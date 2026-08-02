/**
 * Transport: a reliable, ordered byte stream over TCP.
 *
 * No knowledge of TLS, HTTP, or browser fingerprints. Higher layers compose on top.
 * The stateful lifecycle lives in `TcpTransport`; timer and backpressure concerns
 * are composed in from dedicated modules so each file stays focused.
 */

import { connect as netConnect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import type {
    CloseReason,
    Deferred,
    DrainQueue,
    Transport,
    TransportId,
    TransportOptions,
    TransportState,
    TransportTimers,
} from "./types.js";
import { ConnectTimeoutError, TransportError, ensureTransportError } from "./errors.js";
import { assertNever } from "./utils.js";
import { createDeferred } from "./deferred.js";
import { createDrainQueue } from "./drain.js";
import { createTransportTimers } from "./timers.js";
import { resolveHost } from "./resolve.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IPV6 = true;
const DEFAULT_NO_DELAY = true;

// Re-export so the barrel (index.ts) can surface the concrete class name once implemented.
export type { Socket };

/** Concrete transport implementation over node:net.Socket. */
export class TcpTransport extends EventEmitter implements Transport {
    public readonly id: TransportId;
    // `_state` is the one exception to the no-underscore rule: the public
    // `get state()` getter (required by the Transport interface) already
    // claims the name `state`, so the backing field keeps a trailing marker.
    private _state: TransportState = { state: "connecting" };
    private socket: Socket | undefined;
    private readBuffer: Uint8Array[] = [];
    private pendingRead: Deferred<Uint8Array> | undefined;
    private timers!: TransportTimers;
    private drain!: DrainQueue;

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
        const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        const ipv6 = options.ipv6 ?? DEFAULT_IPV6;
        const noDelay = options.noDelay ?? DEFAULT_NO_DELAY;

        const resolved = await resolveHost(options.host, ipv6, options.dnsLookup);

        // Timers and the backpressure queue are created here (not the
        // constructor) because their configuration derives from `options`.
        this.timers = createTransportTimers({
            idleTimeoutMs: options.idleTimeoutMs,
            readTimeoutMs: options.readTimeoutMs,
            onIdleTimeout: (err) => {
                this.emit("error", err);
                void this.close({ kind: "timeout", afterMs: err.idleMs });
            },
            onReadTimeout: (err) => {
                this.rejectPendingRead(err);
            },
        });
        this.drain = createDrainQueue();

        return new Promise<void>((resolve, reject) => {
            const socket = netConnect({
                host: resolved.address,
                port: options.port,
                noDelay,
                localAddress: options.localAddress,
                family: resolved.family,
                ...options.socketOptions,
            });
            this.socket = socket;

            const connectTimer = setTimeout(() => {
                const err = new ConnectTimeoutError(options.host, options.port, connectTimeoutMs);
                socket.destroy(err);
                this.transition({ state: "closed", reason: { kind: "timeout", afterMs: connectTimeoutMs } });
                reject(err);
            }, connectTimeoutMs);

            socket.once("connect", () => {
                clearTimeout(connectTimer);
                this.transition({ state: "open" });
                this.timers.resetIdle();
                resolve();
            });

            socket.on("data", (chunk: Buffer) => {
                this.timers.resetIdle();
                this.timers.clearRead();
                const data = new Uint8Array(chunk);
                this.emit("data", data);
                const pending = this.pendingRead;
                if (pending) {
                    this.pendingRead = undefined;
                    pending.resolve(data);
                } else {
                    this.readBuffer.push(data);
                }
            });

            socket.on("drain", () => {
                this.drain.notifyDrain();
            });

            socket.on("end", () => {
                this.emit("end");
                this.rejectPendingRead(new TransportError("remote closed before read delivered"));
            });

            socket.on("error", (err: Error) => {
                // Only re-emit if a consumer is listening. During a failed
                // connect() the transport has no owner yet, so an unhandled
                // "error" would throw — the error is still surfaced via the
                // rejected connect promise and the "closed"/error transition.
                if (this.listenerCount("error") > 0) {
                    this.emit("error", err);
                }
                this.rejectPendingRead(err);
                this.drain.reject(err);
                if (this.state.state !== "closed") {
                    this.transition({ state: "closed", reason: { kind: "error", error: err } });
                }
            });

            socket.on("close", (hadError: boolean) => {
                this.timers.clearAll();
                // Only auto-transition on *unexpected* closes (still open/connecting).
                // A user-initiated close() drives the transition to "closed" itself.
                if (this.state.state === "open" || this.state.state === "connecting") {
                    const reason: CloseReason = hadError
                        ? { kind: "error", error: new TransportError("socket closed with error") }
                        : { kind: "remote_close" };
                    this.transition({ state: "closed", reason });
                }
                const closeErr = new TransportError("socket closed");
                this.rejectPendingRead(closeErr);
                this.drain.reject(closeErr);
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
        this.ensureOpen();
        const socket = this.socket;
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
            // next "drain" event. The flush callback above intentionally does
            // nothing in this case.
            if (!wroteOk) {
                void this.drain
                    .awaitDrain()
                    .then(
                        () => {
                            if (settled) {
                                return false;
                            }
                            settled = true;
                            resolve();
                            return true;
                        },
                        (e) => {
                            if (settled) {
                                return false;
                            }
                            settled = true;
                            reject(ensureTransportError(e));
                            return true;
                        },
                    );
            }
        });
    }

    /** Read the next chunk of bytes, or reject if the socket closes / times out first. */
    public read(): Promise<Uint8Array> {
        this.ensureOpen();
        const buffered = this.readBuffer.shift();
        if (buffered) {
            return Promise.resolve(buffered);
        }
        const deferred = createDeferred<Uint8Array>();
        this.pendingRead = deferred;
        this.timers.resetRead();
        return deferred.promise;
    }

    /** Gracefully close the transport. Resolves once the socket has closed. */
    public close(reason?: CloseReason): Promise<void> {
        const effectiveReason: CloseReason = reason ?? { kind: "client_close" };
        if (this.state.state === "closed" || this.state.state === "closing") {
            return Promise.resolve();
        }
        this.transition({ state: "closing" });
        const socket = this.socket;
        if (!socket || socket.destroyed) {
            this.transition({ state: "closed", reason: effectiveReason });
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            socket.once("close", () => {
                this.transition({ state: "closed", reason: effectiveReason });
                resolve();
            });
            socket.end();
        });
    }

    /** Throw a typed error unless the transport is in the "open" state. */
    private ensureOpen(): void {
        const s = this.state;
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
    private transition(next: TransportState): void {
        this._state = next;
        this.emit("state", next);
    }

    /** Reject a pending read if one exists (idempotent — clears the slot either way). */
    private rejectPendingRead(err: Error): void {
        const pending = this.pendingRead;
        if (pending) {
            this.pendingRead = undefined;
            pending.reject(err);
        }
    }
}

// resolveHost lives in its own module; re-exported here so the barrel keeps
// surfacing it from a single, stable module path.
export { resolveHost };
