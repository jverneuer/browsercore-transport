/**
 * Domain types for @browsercore/transport.
 *
 * This package owns NO knowledge of TLS, HTTP, or browser fingerprints.
 * It is a pure byte-stream abstraction over a reliable ordered transport (TCP).
 */

import { type EventEmitter } from "node:events";
import { lookup as dnsLookup, type LookupOneOptions } from "node:dns";
import type { SocketConnectOpts } from "node:net";

/** Type of the configurable DNS lookup function (injectable for DoH etc). */
export type DnsLookupFn = (
    hostname: string,
    options: LookupOneOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

void dnsLookup;

/** Branded transport connection identifier. */
export type TransportId = string & { __brand: "TransportId" };

/** Why a transport was closed. Discriminated union — every case is explicit. */
export type CloseReason =
    | { readonly kind: "client_close" }
    | { readonly kind: "remote_close" }
    | { readonly kind: "error"; readonly error: Error }
    | { readonly kind: "timeout"; readonly afterMs: number };

/** Lifecycle state of a transport connection. */
export type TransportState =
    | { readonly state: "connecting" }
    | { readonly state: "open" }
    | { readonly state: "closing" }
    | { readonly state: "closed"; readonly reason: CloseReason };

/** Options for {@link connect}. Extends Node's socket options with our own. */
export interface TransportOptions {
    /** Target host (DNS name or IP literal). */
    readonly host: string;
    /** Target port. */
    readonly port: number;
    /** Connect timeout in milliseconds. Default 10_000. */
    readonly connectTimeoutMs?: number;
    /** Idle timeout: close if no data flows for this many ms. Default disabled. */
    readonly idleTimeoutMs?: number;
    /**
     * Per-read timeout: reject a pending {@link Transport.read} if no data
     * arrives within this many ms of the read being issued. Default disabled.
     */
    readonly readTimeoutMs?: number;
    /** Allow IPv6 addresses. Default true. */
    readonly ipv6?: boolean;
    /** Custom DNS lookup function (e.g. for DoH). Defaults to dns.lookup. */
    readonly dnsLookup?: DnsLookupFn;
    /** NODELAY — disable Nagle. Default true for protocol stacks. */
    readonly noDelay?: boolean;
    /** Local interface address to bind. */
    readonly localAddress?: string;
    /** Pass-through options to net.connect for anything not covered above. */
    readonly socketOptions?: Omit<SocketConnectOpts, "host" | "port" | "lookup">;
}

/** A resolved address, returned by the DNS resolution step. */
export interface ResolvedAddress {
    readonly address: string;
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
 * A promise whose settlement is controlled manually from the outside.
 *
 * The bridge between event-callback land (socket `"data"`, `"drain"`) and the
 * async/await land our public API speaks. Instead of stashing separate
 * `resolve`/`reject` callbacks in two fields, a `Deferred` keeps one shape.
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
