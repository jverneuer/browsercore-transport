/**
 * Domain types for @browsercore/transport.
 *
 * This package owns NO knowledge of TLS, HTTP, or browser fingerprints.
 * It is a pure byte-stream abstraction over a reliable ordered transport (TCP).
 * Platform-specific implementations (node:net, bun, deno) are injected —
 * this package imports only interfaces from @browsercore/contracts.
 */

import type {
    Transport as CanonicalTransport,
    EventProvider,
    Net,
    DnsResolver,
    Clock,
    TimerHandle,
} from "@browsercore/contracts";

// ---------------------------------------------------------------------------
// Canonical transport types — re-exported, no longer declared here.
//
// @browsercore/contracts 0.2.5 adopted this package's Transport shape as the
// canonical definition (replaceability audit 2026-11-16 found Transport
// declared twice, type-incompatible, bridged only by casts in fetch). The
// local duplicates that used to live in this file are removed; what follows
// re-exports the single definitions so every consumer of
// @browsercore/transport sees the exact same types as consumers of
// @browsercore/contracts.
// ---------------------------------------------------------------------------

export type {
    Transport,
    TransportState,
    CloseReason,
    DatagramTransport,
    UdpAddress,
    DatagramCloseReason,
} from "@browsercore/contracts";

/**
 * Branded transport connection identifier.
 *
 * Opaque id used for logging/correlation. Created by {@link connect} or passed
 * explicitly to {@link TcpTransport.create}. Assignable to/from the canonical
 * `Transport["id"]: string` — the brand lives here, not in contracts.
 */
export type TransportId = string & { __brand: "TransportId" };

/**
 * Options for {@link connect}.
 *
 * All timeout options are disabled by default — set a value to enable the
 * corresponding timer. Platform-specific implementations (`net`, `dns`) are
 * injected by the application entrypoint (e.g. browsersmith).
 */
export interface TransportOptions {
    /** Target host (DNS name or IP literal). */
    readonly host: string;
    /** Target port. */
    readonly port: number;
    /**
     * Connect timeout in milliseconds. Aborts the connection if the TCP
     * handshake does not complete in time.
     *
     * @defaultValue 10_000
     */
    readonly connectTimeoutMs?: number;
    /**
     * Idle timeout: close the transport if no data flows for this many ms.
     * Disabled by default.
     *
     * @defaultValue undefined (disabled)
     */
    readonly idleTimeoutMs?: number;
    /**
     * Per-read timeout: reject a pending {@link Transport.read} if no data
     * arrives within this many ms of the read being issued.
     * Disabled by default.
     *
     * @defaultValue undefined (disabled)
     */
    readonly readTimeoutMs?: number;
    /** Allow IPv6 addresses. Candidates from BOTH families are resolved and
     * attempted in preference order with connect-level fallback; this flag
     * only decides which family is tried first.
     * @defaultValue true
     */
    readonly ipv6?: boolean;
    /**
     * NODELAY — disable Nagle's algorithm. Recommended for protocol stacks
     * where low latency matters.
     *
     * @defaultValue true
     */
    readonly noDelay?: boolean;
    /** Local interface address to bind. */
    readonly localAddress?: string;
    /**
     * Platform-provided TCP implementation. Injected by the application
     * entrypoint (e.g. browsersmith passes the Node adapter).
     */
    readonly net: Net;
    /**
     * Platform-provided DNS resolver. Injected by the application
     * entrypoint (e.g. browsersmith passes the Node adapter).
     */
    readonly dns: DnsResolver;
    /**
     * Platform-provided event provider. Injected by the application
     * entrypoint (e.g. browsersmith passes the runtime EventProvider).
     * Decouples the transport from any specific runtime event system.
     *
     * Required — this package provides no fallback. Inject the runtime
     * EventProvider via the composition root (browsersmith).
     */
    readonly events?: EventProvider;
    /**
     * Time + timer source — the canonical `Clock` from
     * `@browsercore/contracts` (0.2.6). Every timer the transport arms
     * (connect, idle, per-read) and every timestamp it mints (correlation
     * ids) routes through it.
     *
     * Defaults to {@link systemClock}, which delegates to the platform
     * globals (`Date.now()`, `performance.now()`, `setTimeout`) — behavior is
     * identical unless the caller opts in. Inject a deterministic Clock in
     * tests to fire timeouts at exact virtual instants with zero real
     * timers. Callers that assemble a `Platform` composition root may pass
     * `platform.time` here — this package takes the Clock directly rather
     * than the whole Platform bundle.
     */
    readonly clock?: Clock;
}

// ---------------------------------------------------------------------------
// Clock seam (injected — the canonical @browsercore/contracts Clock)
// ---------------------------------------------------------------------------

/**
 * Re-exported so consumers of this package can type their own Clock
 * injections without importing `@browsercore/contracts` directly — same
 * convenience rule as `Net`/`Socket`/`DnsResolver` below.
 */
export type { Clock, TimerHandle };

/**
 * The default {@link Clock}: delegates to the platform globals
 * (`Date.now()`, `performance.now()`, global `setTimeout`/`clearTimeout`).
 *
 * This is the same seam pattern tls/http2 use (`systemClock` housed next to
 * the options that inject it), but typed as the CANONICAL contracts Clock —
 * the superseding shape all sibling package-local clocks migrate onto
 * (replaceability audit 2026-11-16, remediation item #6). Production callers
 * never need to supply a clock; tests inject a manual-advance fake so
 * timeouts fire at exact virtual instants without real timers.
 *
 * Unit contract (from the contract's docs): `now()` is WALL time (epoch ms,
 * can jump — NTP); `monotonic()` is elapsed/deadline time and never goes
 * backwards. Deadline math in this package uses `monotonic()` exclusively.
 */
export const systemClock: Clock = {
    now: () => Date.now(),
    monotonic: () => performance.now(),
    sleep: (ms) =>
        new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        }),
    setTimeout: (ms, fn) => {
        return setTimeout(fn, ms);
    },
    clearTimeout: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
};

/** A resolved address, returned by the DNS resolution step. */
export interface ResolvedAddress {
    /** The resolved IP address. */
    readonly address: string;
    /** Address family: `4` for IPv4, `6` for IPv6. */
    readonly family: 4 | 6;
}

/**
 * Stream-based transport — a reliable ordered byte stream (TCP).
 * Alias for the canonical {@link Transport} so higher layers can depend on the
 * stream abstraction explicitly, distinct from {@link DatagramTransport}.
 */
export type StreamTransport = CanonicalTransport;

/**
 * A promise whose settlement is controlled manually from the outside.
 *
 * The bridge between event-callback land (socket `"data"`, `"drain"`) and the
 * async/await land our public API speaks. Instead of stashing separate
 * `resolve`/`reject` callbacks in two fields, a `Deferred` keeps one shape.
 *
 * @template T - The type the promise resolves with.
 *
 * @see createDeferred for the factory.
 */
export interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (reason: Error) => void;
}

/**
 * FIFO backpressure queue. When the kernel send buffer is full, `write()`
 * returns `false` and callers must wait for the socket `"drain"` event before
 * the bytes are considered handed off. `awaitDrain()` lines writers up so they
 * proceed one-at-a-time in order — concurrent backpressured writes never race
 * to resume.
 *
 * @see createDrainQueue for the factory.
 */
export interface DrainQueue {
    /** Wait for the next `"drain"`, queued behind any earlier waiters. */
    awaitDrain(): Promise<void>;
    /** Release the single queued writer now that the kernel buffer drained. */
    notifyDrain(): void;
    /** Reject the queued writer (socket error/close) so writes fail fast. */
    reject(err: Error): void;
}

/**
 * Idle + per-read timer ownership, factored out of the transport so the
 * lifecycle class stays focused on socket wiring. The idle timer closes a
 * connection that carries no data; the per-read timer bounds how long a single
 * `read()` may block waiting for the next chunk.
 *
 * @see createTransportTimers for the factory.
 */
export interface TransportTimers {
    /** (Re)start the idle timer; called whenever data flows. */
    resetIdle(): void;
    /** Clear the idle timer (e.g. on close). */
    clearIdle(): void;
    /** (Re)start the per-read timer when a read() is issued. */
    resetRead(): void;
    /** Clear the per-read timer once data arrives. */
    clearRead(): void;
    /** Clear both timers (e.g. on socket close). */
    clearAll(): void;
}


