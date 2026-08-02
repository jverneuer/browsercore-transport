/**
 * Transport: a reliable, ordered byte stream over TCP.
 *
 * No knowledge of TLS, HTTP, or browser fingerprints. Higher layers compose on top.
 */

import { connect as netConnect, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { EventEmitter } from "node:events";
import type {
    CloseReason,
    DnsLookupFn,
    ResolvedAddress,
    TransportId,
    TransportOptions,
    TransportState,
} from "./types.js";
import {
    ConnectTimeoutError,
    DnsResolutionError,
    IdleTimeoutError,
    ReadTimeoutError,
    TransportError,
} from "./errors.js";
import { assertNever } from "./utils.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IPV6 = true;
const DEFAULT_NO_DELAY = true;

/** The public interface every transport implements. Higher layers depend on this. */
export interface Transport extends EventEmitter {
    /** Opaque identifier for logging / correlation. */
    readonly id: TransportId;
    /** Current lifecycle state. */
    readonly state: TransportState;

    /**
     * Write bytes to the stream. Resolves when the data has been handed to the
     * kernel (or buffered). Rejects if the transport is not open.
     * Backpressure: the promise may take time to resolve under heavy write load.
     */
    write(data: Uint8Array): Promise<void>;

    /**
     * Read available data. Resolves with the next chunk of bytes, or rejects if
     * the transport closes before any data arrives. For a streaming read API,
     * subscribe to the `"data"` event instead.
     */
    read(): Promise<Uint8Array>;

    /**
     * Gracefully close the transport. Resolves once the socket has closed.
     * `reason` is recorded for observability.
     */
    close(reason?: CloseReason): Promise<void>;
}

// Re-export so the barrel (index.ts) can surface the concrete class name once implemented.
export type { Socket };

/** Concrete transport implementation over node:net.Socket. */
export class TcpTransport extends EventEmitter implements Transport {
    public readonly id: TransportId;
    private _state: TransportState = { state: "connecting" };
    private _socket: Socket | undefined;
    private _connectTimeoutMs: number | undefined;
    private _idleTimeoutMs: number | undefined;
    private _readTimeoutMs: number | undefined;
    private _idleTimer: NodeJS.Timeout | undefined;
    private _readTimer: NodeJS.Timeout | undefined;
    private _readBuffer: Uint8Array[] = [];
    private _pendingRead: ((data: Uint8Array) => void) | undefined;
    private _pendingReadReject: ((err: Error) => void) | undefined;
    /**
     * Serialized chain of backpressure waiters. Each `write()` that observes a
     * full kernel buffer appends a promise here; the `"drain"` handler releases
     * them one at a time in FIFO order so concurrent writes queue behind drain.
     */
    private _drainChain: Promise<void> = Promise.resolve();
    /** The single drain waiter currently registered on the socket (FIFO slot). */
    private _drainWaiter: { resolve: () => void; reject: (e: Error) => void } | undefined;

    /** Current lifecycle state (read-only through this getter). */
    public get state(): TransportState {
        return this._state;
    }

    /**
     * Factory: resolves DNS, opens the socket, and resolves once the connection
     * is established. Rejects on DNS failure, connect timeout, or socket error.
     */
    public static create(id: TransportId, options: TransportOptions): Promise<TcpTransport> {
        const transport = new TcpTransport(id);
        return transport._establish(options).then(() => transport);
    }

    private constructor(id: TransportId) {
        super();
        this.id = id;
    }

    /** Resolve DNS, open the socket, and wire lifecycle events. */
    private async _establish(options: TransportOptions): Promise<void> {
        this._connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this._idleTimeoutMs = options.idleTimeoutMs;
        this._readTimeoutMs = options.readTimeoutMs;

        const lookup: DnsLookupFn = options.dnsLookup ?? dnsLookup;
        const ipv6 = options.ipv6 ?? DEFAULT_IPV6;
        const noDelay = options.noDelay ?? DEFAULT_NO_DELAY;

        const resolved: ResolvedAddress = await resolveHost(options.host, ipv6, lookup);

        return new Promise<void>((resolve, reject) => {
            const socket = netConnect({
                host: resolved.address,
                port: options.port,
                noDelay,
                localAddress: options.localAddress,
                family: resolved.family,
                ...options.socketOptions,
            });
            this._socket = socket;

            const connectTimer = setTimeout(() => {
                const err = new ConnectTimeoutError(
                    options.host,
                    options.port,
                    this._connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
                );
                socket.destroy(err);
                this._transition({
                    state: "closed",
                    reason: { kind: "timeout", afterMs: this._connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS },
                });
                reject(err);
            }, this._connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

            socket.once("connect", () => {
                clearTimeout(connectTimer);
                this._transition({ state: "open" });
                this._resetIdleTimer();
                resolve();
            });

            socket.on("data", (chunk: Buffer) => {
                this._resetIdleTimer();
                this._clearReadTimer();
                const data = new Uint8Array(chunk);
                this.emit("data", data);
                const pending = this._pendingRead;
                if (pending) {
                    this._pendingRead = undefined;
                    this._pendingReadReject = undefined;
                    pending(data);
                } else {
                    this._readBuffer.push(data);
                }
            });

            socket.on("drain", () => {
                // Kernel buffer drained: release the single queued write waiter.
                const waiter = this._drainWaiter;
                if (waiter) {
                    this._drainWaiter = undefined;
                    waiter.resolve();
                }
            });

            socket.on("end", () => {
                this.emit("end");
                this._rejectPendingRead(new TransportError("remote closed before read delivered"));
            });

            socket.on("error", (err: Error) => {
                // Only re-emit if a consumer is listening. During a failed
                // connect() the transport has no owner yet, so an unhandled
                // "error" would throw — the error is still surfaced via the
                // rejected connect promise and the "closed"/error transition.
                if (this.listenerCount("error") > 0) {
                    this.emit("error", err);
                }
                this._rejectPendingRead(err);
                this._rejectDrainWaiter(err);
                if (this._state.state !== "closed") {
                    this._transition({ state: "closed", reason: { kind: "error", error: err } });
                }
            });

            socket.on("close", (hadError: boolean) => {
                this._clearIdleTimer();
                this._clearReadTimer();
                // Only auto-transition on *unexpected* closes (still open/connecting).
                // A user-initiated close() drives the transition to "closed" itself.
                if (this._state.state === "open" || this._state.state === "connecting") {
                    const reason: CloseReason = hadError
                        ? { kind: "error", error: new TransportError("socket closed with error") }
                        : { kind: "remote_close" };
                    this._transition({ state: "closed", reason });
                }
                const closeErr = new TransportError("socket closed");
                this._rejectPendingRead(closeErr);
                this._rejectDrainWaiter(closeErr);
                this.emit("close", hadError);
            });
        });
    }

    /**
     * Write bytes to the stream. Resolves when the data has been handed to the
     * kernel. If the kernel buffer is full (`socket.write` returns `false`),
     * the promise stays pending until the `"drain"` event fires — this is how
     * backpressure propagates to higher layers instead of buffering unboundedly
     * in userspace.
     */
    public write(data: Uint8Array): Promise<void> {
        this._ensureOpen();
        const socket = this._socket;
        if (!socket) {
            return Promise.reject(new TransportError("socket not available"));
        }
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const wroteOk = socket.write(data, (err) => {
                if (err && !settled) {
                    settled = true;
                    reject(err);
                    return;
                }
                // Data accepted into the kernel buffer. If the buffer was below
                // the high-water mark we're done; otherwise the caller must wait
                // for the kernel to drain before we consider the write complete.
                if (wroteOk && !settled) {
                    settled = true;
                    resolve();
                }
            });
            // Kernel buffer full: backpressure. Resolution is deferred to the
            // next "drain" event (handled in _releaseDrainWaiter). The flush
            // callback above intentionally does nothing in this case.
            if (!wroteOk) {
                this._awaitDrain().then(
                    () => {
                        if (!settled) {
                            settled = true;
                            resolve();
                        }
                    },
                    (e) => {
                        if (!settled) {
                            settled = true;
                            reject(e);
                        }
                    },
                );
            }
        });
    }

    /**
     * Resolve on the next `"drain"` event, queued behind any earlier backpressured
     * writes so concurrent writers proceed one-at-a-time in FIFO order.
     */
    private _awaitDrain(): Promise<void> {
        const next = this._drainChain.then(
            () =>
                new Promise<void>((resolve, reject) => {
                    this._drainWaiter = { resolve, reject };
                }),
        );
        // Keep the chain alive even if an individual waiter rejects/throws.
        this._drainChain = next.catch(() => {});
        return next;
    }

    /** Read the next chunk of bytes, or reject if the socket closes / times out first. */
    public read(): Promise<Uint8Array> {
        this._ensureOpen();
        const buffered = this._readBuffer.shift();
        if (buffered) {
            return Promise.resolve(buffered);
        }
        return new Promise<Uint8Array>((resolve, reject) => {
            this._pendingRead = resolve;
            this._pendingReadReject = reject;
            this._resetReadTimer();
        });
    }

    /** Gracefully close the transport. Resolves once the socket has closed. */
    public close(reason?: CloseReason): Promise<void> {
        const effectiveReason: CloseReason = reason ?? { kind: "client_close" };
        if (this._state.state === "closed" || this._state.state === "closing") {
            return Promise.resolve();
        }
        this._transition({ state: "closing" });
        const socket = this._socket;
        if (!socket || socket.destroyed) {
            this._transition({ state: "closed", reason: effectiveReason });
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            socket.once("close", () => {
                this._transition({ state: "closed", reason: effectiveReason });
                resolve();
            });
            socket.end();
        });
    }

    /** Throw a typed error unless the transport is in the "open" state. */
    private _ensureOpen(): void {
        const s = this._state;
        switch (s.state) {
            case "open":
                return;
            case "connecting":
                throw new TransportError("transport not yet connected");
            case "closing":
                throw new TransportError("transport is closing");
            case "closed":
                throw new TransportError("transport is closed");
            default:
                assertNever(s);
        }
    }

    /** Transition to the next lifecycle state and emit it for observers. */
    private _transition(next: TransportState): void {
        this._state = next;
        this.emit("state", next);
    }

    /** Reject a pending read if one exists (idempotent — clears the slot either way). */
    private _rejectPendingRead(err: Error): void {
        const rejecter = this._pendingReadReject;
        if (rejecter) {
            this._pendingRead = undefined;
            this._pendingReadReject = undefined;
            rejecter(err);
        }
    }

    /** Reject the queued backpressure waiter if one exists (idempotent). */
    private _rejectDrainWaiter(err: Error): void {
        const waiter = this._drainWaiter;
        if (waiter) {
            this._drainWaiter = undefined;
            waiter.reject(err);
        }
    }

    /** Reset the idle timer; called whenever data flows. */
    private _resetIdleTimer(): void {
        const idleMs = this._idleTimeoutMs;
        if (idleMs === undefined) {
            return;
        }
        this._clearIdleTimer();
        this._idleTimer = setTimeout(() => {
            const err = new IdleTimeoutError(idleMs);
            this.emit("error", err);
            void this.close({ kind: "timeout", afterMs: idleMs });
        }, idleMs);
    }

    /** Clear the idle timer if one is active. */
    private _clearIdleTimer(): void {
        if (this._idleTimer !== undefined) {
            clearTimeout(this._idleTimer);
            this._idleTimer = undefined;
        }
    }

    /**
     * (Re)start the per-read timer. When it fires, the pending read is rejected
     * with a {@link ReadTimeoutError} — a read that never sees data should not
     * hang forever.
     */
    private _resetReadTimer(): void {
        const readMs = this._readTimeoutMs;
        if (readMs === undefined) {
            return;
        }
        this._clearReadTimer();
        this._readTimer = setTimeout(() => {
            this._rejectPendingRead(new ReadTimeoutError(readMs));
        }, readMs);
    }

    /** Clear the per-read timer if one is active. */
    private _clearReadTimer(): void {
        if (this._readTimer !== undefined) {
            clearTimeout(this._readTimer);
            this._readTimer = undefined;
        }
    }
}

/**
 * Establish a TCP transport connection.
 *
 * Resolves DNS (via {@link resolveHost}), opens a `node:net.Socket`, wires
 * timeouts/backpressure/idle, and resolves once the connection is established.
 *
 * @example
 * ```ts
 * const transport = await connect({ host: "example.com", port: 443 });
 * await transport.write(handshakeBytes);
 * const chunk = await transport.read();
 * await transport.close();
 * ```
 */
export function connect(options: TransportOptions): Promise<Transport> {
    const id = `transport_${Date.now().toString(36)}` as TransportId;
    return TcpTransport.create(id, options);
}

/** Resolve a host to an address using the configured (or default) DNS lookup. */
export async function resolveHost(
    host: string,
    ipv6: boolean,
    lookup: (
        hostname: string,
        options: { family: 4 | 6 },
        callback: (err: Error | null, address: string, family: number) => void,
    ) => void = dnsLookup,
): Promise<ResolvedAddress> {
    return new Promise((resolve, reject) => {
        const family = ipv6 ? 6 : 4;
        lookup(host, { family }, (err, address, resolvedFamily) => {
            if (err) {
                reject(new DnsResolutionError(host, { cause: err }));
                return;
            }
            const fam = (resolvedFamily ?? family) as ResolvedAddress["family"];
            resolve({ address, family: fam });
        });
    });
}
