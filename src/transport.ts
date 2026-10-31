/**
 * Transport: a reliable, ordered byte stream over TCP.
 *
 * No knowledge of TLS, HTTP, or browser fingerprints. Higher layers compose on top.
 * The stateful lifecycle lives in `TcpTransport`; timer and backpressure concerns
 * are composed in from dedicated modules so each file stays focused.
 *
 * Platform-specific socket implementations are injected via {@link TransportOptions.net}
 * — this class never imports `node:net` directly, keeping the transport
 * runtime-agnostic (Node, Bun, Deno, Cloudflare Workers, mocks).
 */

import type { EventProvider, Socket } from "@browsercore/contracts";
import type {
    CloseReason,
    Deferred,
    DrainQueue,
    ResolvedAddress,
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
import { resolveHost, resolveHostCandidates } from "./resolve.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IPV6 = true;
const DEFAULT_NO_DELAY = true;
/**
 * Per-attempt connect cap for every candidate EXCEPT the last one. When the
 * first candidate is unreachable at the network level (e.g. an AAAA route that
 * black-holes SYN packets), waiting out the full connect timeout before trying
 * the next family would make the fallback useless in practice — real stacks
 * (Chrome, Node's autoSelectFamily) cap each non-final attempt at a few
 * hundred milliseconds. The final candidate gets the remaining budget.
 */
const FALLBACK_ATTEMPT_TIMEOUT_MS = 300;

/**
 * Concrete transport implementation over an injected {@link Net} socket.
 *
 * A reliable, ordered byte stream with no knowledge of TLS, HTTP, or browser
 * fingerprints. Higher layers (tls, http1, http2) compose exclusively through
 * this class. The stateful lifecycle lives here; timer and backpressure concerns
 * are composed in from {@link TransportTimers} and {@link DrainQueue} so each
 * file stays focused.
 *
 * Use {@link connect} to obtain an instance rather than constructing directly.
 *
 * @example
 * ```ts
 * const transport = await connect({ host: "example.com", port: 443 });
 * await transport.write(new TextEncoder().encode("hello"));
 * const chunk = await transport.read();
 * await transport.close();
 * ```
 *
 * @see Transport for the public interface.
 * @see connect for the factory entry point.
 * @since 0.1.0
 */
export class TcpTransport implements Transport {
    public readonly id: TransportId;
    private readonly events: EventProvider;
    // `_state` is the one exception to the no-underscore rule: the public
    // `get state()` getter (required by the Transport interface) already
    // claims the name `state`, so the backing field keeps a trailing marker.
    private _state: TransportState = { state: "connecting" };
    private socket: Socket | undefined;
    private readBuffer: Uint8Array[] = [];
    private pendingRead: Deferred<Uint8Array> | undefined;
    private timers!: TransportTimers;
    private drain!: DrainQueue;

    // -------------------------------------------------------------------------
    // EventProvider delegation — decouples the transport from any specific
    // runtime event system.
    // -------------------------------------------------------------------------

    public on(event: string, listener: (...args: unknown[]) => void): void {
        this.events.on(event, listener);
    }

    public once(event: string, listener: (...args: unknown[]) => void): void {
        this.events.once(event, listener);
    }

    public off(event: string, listener: (...args: unknown[]) => void): void {
        this.events.off(event, listener);
    }

    public removeListener(event: string, listener: (...args: unknown[]) => void): void {
        this.events.removeListener(event, listener);
    }

    public emit(event: string, ...args: unknown[]): boolean {
        return this.events.emit(event, ...args);
    }

    public listenerCount(event: string): number {
        return this.events.listenerCount(event);
    }

    public removeAllListeners(event?: string): void {
        this.events.removeAllListeners(event);
    }

    /** Current lifecycle state (read-only through this getter). */
    public get state(): TransportState {
        return this._state;
    }

    /**
     * Factory: resolve DNS, open the socket, and resolve once the connection is established.
 *
     * Prefer {@link connect}, which mints the id for you. This is exposed as a
     * static method for cases where you need to supply a specific {@link TransportId}
     * (e.g. for correlation across logs).
     *
     * @param id - Opaque correlation id assigned to the transport.
     * @param options - Connection target and timeout/backpressure configuration.
     * @returns A promise that resolves with a connected {@link TcpTransport}.
     * @throws {DnsResolutionError} If the host cannot be resolved.
     * @throws {ConnectTimeoutError} If the TCP handshake does not complete in time.
     * @throws {TransportError} On socket errors during connection.
     *
     * @since 0.1.0
     */
    public static create(id: TransportId, options: TransportOptions): Promise<TcpTransport> {
        if (!options.events) {
            throw new TransportError(
                "TcpTransport.create requires an injected EventProvider (options.events)",
            );
        }
        const transport = new TcpTransport(id, options.events);
        return transport._establish(options).then(() => transport);
    }

    /**
     * Private constructor — instances are created via {@link TcpTransport.create}.
     *
     * @param id - Opaque correlation id assigned to the transport.
     * @param events - Injected EventProvider backend (decouples from any
     *   specific runtime event system).
     */
    private constructor(id: TransportId, events: EventProvider) {
        this.id = id;
        this.events = events;
    }

    /**
     * Resolve DNS, open the socket, and wire lifecycle events.
     *
     * Sets up the connect timer, idle/per-read timers, the backpressure queue,
     * and all socket event handlers (`connect`, `data`, `drain`, `end`, `error`, `close`).
     * Resolves once the socket connects; rejects on DNS failure, connect timeout, or error.
     *
     * @param options - Connection configuration.
     * @throws {DnsResolutionError} If DNS resolution fails.
     * @throws {ConnectTimeoutError} If the connect timeout elapses.
     * @throws {TransportError} On socket error before connection.
     */
    private async _establish(options: TransportOptions): Promise<void> {
        const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        const ipv6 = options.ipv6 ?? DEFAULT_IPV6;
        const noDelay = options.noDelay ?? DEFAULT_NO_DELAY;

        // Resolve BOTH families up front, preferred family first, so a failed
        // or unreachable first candidate can fall back to the other one. A
        // single-family resolver made the caller's connectivity hinge on one
        // address: hosts without an AAAA record failed outright under an IPv6
        // preference, and AAAA routes that black-hole could never fall back.
        const candidates = await resolveHostCandidates(options.host, ipv6, options.dns);

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

        // Happy-eyeballs-style sequential fallback: every candidate except the
        // last gets a short per-attempt cap; the final candidate gets the rest
        // of the connect budget so a single-candidate resolution behaves
        // exactly like the historical full-timeout path.
        const deadlineMs = Date.now() + connectTimeoutMs;
        let lastError: Error = new TransportError("no resolved addresses");
        for (const [i, candidate] of candidates.entries()) {
            const isLast = i === candidates.length - 1;
            const remaining = deadlineMs - Date.now();
            const attemptTimeoutMs = isLast
                ? Math.max(remaining, 1)
                : Math.min(Math.max(remaining, 1), FALLBACK_ATTEMPT_TIMEOUT_MS);
            try {
                // oxlint-disable-next-line no-await-in-loop -- fallback attempts must run in order; each starts only if the previous failed
                await this._openSocket(options, candidate, noDelay, attemptTimeoutMs);
                return;
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (Date.now() >= deadlineMs) {
                    break;
                }
            }
        }
        throw lastError;
    }

    /**
     * Open a socket to one resolved candidate and wait for the TCP handshake.
     *
     * Wires the full session event surface (`data`, `drain`, `end`, `error`,
     * `close`) once the socket connects. On a failed attempt the socket is
     * detached (listeners removed, destroyed) so the caller can retry with the
     * next candidate without stale handlers firing.
     *
     * @param options - Connection configuration (net adapter, local address).
     * @param candidate - The resolved address to connect to.
     * @param noDelay - Whether to disable Nagle's algorithm.
     * @param timeoutMs - Connect budget for THIS attempt.
     */
    private _openSocket(
        options: TransportOptions,
        candidate: ResolvedAddress,
        noDelay: boolean,
        timeoutMs: number,
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let connected = false;
            const socket = options.net.connect({
                host: candidate.address,
                port: options.port,
                noDelay,
                ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
                family: candidate.family,
            });
            this.socket = socket;

            const fail = (err: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(connectTimer);
                // Handlers on a never-connected socket are all guarded by the
                // settled/connected flags, so the dead attempt's events cannot
                // fire session behavior or state transitions after destroy().
                socket.destroy(err);
                reject(err);
            };

            const connectTimer = setTimeout(() => {
                fail(new ConnectTimeoutError(options.host, options.port, timeoutMs));
            }, timeoutMs);

            socket.once("connect", () => {
                connected = true;
                clearTimeout(connectTimer);
                this.transition({ state: "open" });
                this.timers.resetIdle();
                settled = true;
                resolve();
            });

            socket.on("data", (chunk: Uint8Array) => {
                this.timers.resetIdle();
                this.timers.clearRead();
                const data = chunk;
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
                // A pre-connect error (refused, unreachable, …) fails THIS
                // attempt so the caller can fall back to the next candidate
                // immediately instead of waiting out the connect timer.
                if (!connected) {
                    fail(err instanceof Error ? err : new Error(String(err)));
                    return;
                }
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
                if (!connected) {
                    // The attempt never completed (error already handled it,
                    // or the socket died silently before connecting).
                    fail(new TransportError("socket closed before connect completed"));
                    return;
                }
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
     *
     * @param data - Bytes to write.
     * @returns A promise that resolves once the kernel has accepted the data.
     * @throws {TransportError} If the transport is not open.
     *
     * @since 0.1.0
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

    /**
     * Read the next chunk of bytes, or reject if the socket closes / times out first.
     *
     * If data was already buffered (received between reads), it is returned
     * immediately. Otherwise the returned promise resolves on the next `"data"`
     * event — or rejects with a {@link ReadTimeoutError} if a per-read timeout
     * is configured, or with a {@link TransportError} if the socket closes.
     *
     * For a streaming read API, subscribe to the `"data"` event directly instead.
     *
     * @returns A promise that resolves with the next chunk of bytes.
     * @throws {TransportError} If the transport is not open or the socket closes.
     * @throws {ReadTimeoutError} If no data arrives within the per-read timeout.
     *
     * @since 0.1.0
     */
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

    /**
     * Gracefully close the transport. Resolves once the socket has closed.
     *
     * Idempotent: calling `close` on an already-closing or closed transport
     * resolves immediately. The `reason` is recorded in the final
     * {@link TransportState} and emitted for observers.
     *
     * @param reason - Why the transport is being closed. Defaults to `{ kind: "client_close" }`.
     * @returns A promise that resolves once the socket has fully closed.
     *
     * @since 0.1.0
     */
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

    /**
     * Throw a typed error unless the transport is in the `"open"` state.
     *
     * Guards every public operation (`write`, `read`) against use of a transport
     * that is still connecting, is closing, or has already closed.
     *
     * @throws {TransportError} Unless the state is `"open"`.
     */
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

    /**
     * Transition to the next lifecycle state and emit it for observers.
     *
     * Updates the backing {@link TransportState} and emits a `"state"` event
     * so higher layers can react to lifecycle changes (open → closing → closed).
     *
     * @param next - The new {@link TransportState} to transition into.
     */
    private transition(next: TransportState): void {
        this._state = next;
        this.emit("state", next);
    }

    /**
     * Reject a pending read if one exists (idempotent — clears the slot either way).
     *
     * Drives the pending {@link Transport.read} promise to rejection on socket
     * error, close, or timeout. Safe to call when no read is pending.
     *
     * @param err - The error to reject the pending read with.
     */
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
