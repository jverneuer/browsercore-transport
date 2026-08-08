/**
 * Domain types for @browsercore/transport.
 *
 * This package owns NO knowledge of TLS, HTTP, or browser fingerprints.
 * It is a pure byte-stream abstraction over a reliable ordered transport (TCP).
 * Platform-specific implementations (node:net, bun, deno) are injected —
 * this package imports only interfaces from @browsercore/contracts.
 */

import { type EventEmitter } from "node:events";
import type { Net, DnsResolver } from "@browsercore/contracts";

/**
 * Branded transport connection identifier.
 *
 * Opaque id used for logging/correlation. Created by {@link connect} or passed
 * explicitly to {@link TcpTransport.create}.
 */
export type TransportId = string & { __brand: "TransportId" };

/**
 * Why a transport was closed. Discriminated union — every case is explicit.
 *
 * Used both as the `reason` in a closed {@link TransportState} and as the
 * argument to {@link Transport.close}.
 */
export type CloseReason =
    | { readonly kind: "client_close" }
    | { readonly kind: "remote_close" }
    | { readonly kind: "error"; readonly error: Error }
    | { readonly kind: "timeout"; readonly afterMs: number };

/**
 * Lifecycle state of a transport connection.
 *
 * A transport moves `connecting → open → closing → closed`. The `closed` case
 * carries the {@link CloseReason} so callers can distinguish a clean close from
 * an error or timeout.
 */
export type TransportState =
    | { readonly state: "connecting" }
    | { readonly state: "open" }
    | { readonly state: "closing" }
    | { readonly state: "closed"; readonly reason: CloseReason };

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
    /** Allow IPv6 addresses.
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
}

/** A resolved address, returned by the DNS resolution step. */
export interface ResolvedAddress {
    /** The resolved IP address. */
    readonly address: string;
    /** Address family: `4` for IPv4, `6` for IPv6. */
    readonly family: 4 | 6;
}

/**
 * The public interface every transport implements. Higher layers depend on this.
 *
 * A reliable, ordered byte stream over TCP with no knowledge of TLS or HTTP.
 */
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

/**
 * Stream-based transport — a reliable ordered byte stream (TCP).
 * Alias for {@link Transport} so higher layers can depend on the stream
 * abstraction explicitly, distinct from {@link DatagramTransport}.
 */
export type StreamTransport = Transport;

/**
 * UDP datagram transport abstraction. Implemented by a UDP transport package
 * (or a thin `node:dgram` adapter); injected into @browsercore/quic so QUIC
 * stays testable with a fake datagram transport and has no dependency on
 * socket internals.
 */
export interface DatagramTransport {
    /** Opaque identifier for logging / correlation. */
    readonly id: string;
    /** Send a datagram to `address`. Resolves once handed to the kernel / buffered. */
    send(data: Uint8Array, address: UdpAddress): Promise<void>;
    /**
     * Receive the next datagram. Resolves with the bytes and the sender's
     * address, or rejects if the transport closes first.
     */
    recv(): Promise<{ readonly data: Uint8Array; readonly from: UdpAddress }>;
    /** Close the transport. */
    close(reason?: DatagramCloseReason): Promise<void>;
}

/** A resolved UDP socket address. */
export interface UdpAddress {
    /** Hostname or IP address. */
    readonly address: string;
    /** UDP port number. */
    readonly port: number;
    /** IP family — 4 for IPv4, 6 for IPv6. */
    readonly family: 4 | 6;
}

/** Why a datagram transport was closed. */
export type DatagramCloseReason =
    | { readonly kind: "client_close" }
    | { readonly kind: "remote_close" }
    | { readonly kind: "error"; readonly error: Error }
    | { readonly kind: "timeout"; readonly afterMs: number };

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


