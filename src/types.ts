/**
 * Domain types for @browsercore/transport.
 *
 * This package owns NO knowledge of TLS, HTTP, or browser fingerprints.
 * It is a pure byte-stream abstraction over a reliable ordered transport (TCP).
 */

import { connect } from "./connect.js";
import { type EventEmitter } from "node:events";
import type { LookupOneOptions } from "node:dns";
import type { SocketConnectOpts } from "node:net";
import { TransportError } from "./errors.js";

/**
 * Type of the configurable DNS lookup function, injectable so tests and
 * DoH-based resolvers can replace the default `dns.lookup`.
 *
 * The signature mirrors `dns.lookup` — a Node-style callback with the resolved
 * address and family.
 */
export type DnsLookupFn = (
    hostname: string,
    options: LookupOneOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

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
 * Options for {@link connect}. Extends Node's socket options with our own
 * timeout, backpressure, and DNS configuration.
 *
 * All timeout options are disabled by default — set a value to enable the
 * corresponding timer.
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
     * Custom DNS lookup function (e.g. for DoH). Defaults to `dns.lookup`.
     *
     * @defaultValue dns.lookup
     */
    readonly dnsLookup?: DnsLookupFn;
    /**
     * NODELAY — disable Nagle's algorithm. Recommended for protocol stacks
     * where low latency matters.
     *
     * @defaultValue true
     */
    readonly noDelay?: boolean;
    /** Local interface address to bind. */
    readonly localAddress?: string;
    /** Pass-through options to `net.connect` for anything not covered above. */
    readonly socketOptions?: Omit<SocketConnectOpts, "host" | "port" | "lookup">;
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

/**
 * Source of random bytes. Abstracted so protocol layers can be tested
 * deterministically against synthetic randomness.
 */
export interface RandomSource {
    /** Return `length` cryptographically or deterministically derived random bytes. */
    bytes(length: number): Uint8Array;
}

/**
 * Default {@link RandomSource} backed by `node:crypto.randomBytes`.
 * Used by protocol layers unless a deterministic source is injected.
 */
export const nodeRandomSource: RandomSource = {
    bytes: (len) => {
        const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
        return randomBytes(len);
    },
};

/**
 * Deterministic {@link RandomSource} using xorshift32. Seeded repeatability
 * makes protocol-layer unit tests stable across runs — the output is NOT
 * cryptographically secure and must never be used for real keys.
 */
export class DeterministicRandom implements RandomSource {
    private state: number;
    constructor(seed: number) {
        this.state = seed | 0;
    }
    bytes(length: number): Uint8Array {
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            // xorshift32
            this.state ^= this.state << 13;
            this.state ^= this.state >> 17;
            this.state ^= this.state << 5;
            out[i] = (this.state >>> 0) & 0xff;
        }
        return out;
    }
}

/**
 * Proxy endpoint configuration for {@link createHttpProxy}.
 *
 * The TLS layer depends on {@link ProxyConnector} and never sees these
 * options — that separation is what keeps TLS proxy-unaware.
 */
export interface ProxyOptions {
    /** Proxy host (DNS name or IP literal). */
    readonly host: string;
    /** Proxy port. */
    readonly port: number;
    /** Optional Basic-auth credentials, sent as a `Proxy-Authorization` header. */
    readonly auth?: Readonly<{ readonly username: string; readonly password: string }>;
}

/**
 * Establishes a {@link Transport} to a target, optionally tunneled through a proxy.
 *
 * Higher layers (TLS) depend on this interface alone. Whether the bytes travel
 * directly to the target or through an HTTP CONNECT tunnel is an implementation
 * detail hidden behind `connect()` — TLS never branches on "are we proxied?".
 */
export interface ProxyConnector {
    /** Open a transport to `targetHost:targetPort`, tunneled if the implementation proxies. */
    connect(targetHost: string, targetPort: number): Promise<Transport>;
}

/** Direct connection (no proxy). */
export const directConnector: ProxyConnector = {
    connect: (host, port) => connect({ host, port }),
};

/** The bytes that terminate an HTTP header block — the end of the CONNECT response headers. */
const CONNECT_TERMINATOR = "\r\n\r\n";

/** Build the HTTP CONNECT request (with optional `Proxy-Authorization`). */
function buildConnectRequest(targetHost: string, targetPort: number, auth?: ProxyOptions["auth"]): string {
    const header = `CONNECT ${targetHost}:${targetPort} HTTP/1.0`;
    if (!auth) {
        return `${header}\r\n\r\n`;
    }
    const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    return `${header}\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`;
}

/**
 * Read bytes from the transport until the HTTP header terminator arrives.
 *
 * CONNECT responses are tiny (a status line + a few headers), but the TCP
 * stack may fragment them across chunks — so we accumulate rather than assume
 * a single chunk is enough. We subscribe to the `"data"` event rather than
 * looping on `read()`: the response is a single coherent write from the proxy,
 * and an event-driven accumulate avoids sequential awaits.
 */
function readConnectResponse(transport: Transport): Promise<string> {
    return new Promise<string>((resolve) => {
        const decoder = new TextDecoder();
        let buffer = "";
        const onData = (chunk: Uint8Array): void => {
            buffer += decoder.decode(chunk, { stream: true });
            if (buffer.includes(CONNECT_TERMINATOR)) {
                transport.off("data", onData);
                resolve(buffer);
            }
        };
        transport.on("data", onData);
    });
}

/** Parse the three-digit status code out of an HTTP CONNECT response. */
function parseConnectStatus(response: string): number {
    const statusLine = response.split("\r\n", 1)[0] ?? "";
    const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/u.exec(statusLine);
    if (!match) {
        throw new TransportError(`Malformed proxy CONNECT response: ${JSON.stringify(statusLine)}`);
    }
    return Number(match[1]);
}

/** Accept any 2xx; reject everything else with a typed error. */
function assertConnectSucceeded(response: string, targetHost: string, targetPort: number): void {
    const status = parseConnectStatus(response);
    if (status < 200 || status >= 300) {
        throw new TransportError(`Proxy CONNECT failed with status ${status}`, {
            targetHost,
            targetPort,
            status,
        });
    }
}

/**
 * Create a connector that tunnels targets through an HTTP CONNECT proxy.
 *
 * The returned {@link ProxyConnector} opens a TCP connection to the proxy,
 * sends a `CONNECT` request, reads until the response headers terminate, and
 * verifies the status is 2xx. On success the now-tunneled transport is
 * returned — higher layers read/write plaintext to it as if it were directly
 * connected to the target.
 */
export function createHttpProxy(proxy: ProxyOptions): ProxyConnector {
    return {
        connect: async (targetHost, targetPort) => {
            const transport = await connect({ host: proxy.host, port: proxy.port });
            const request = buildConnectRequest(targetHost, targetPort, proxy.auth);
            await transport.write(new TextEncoder().encode(request));
            const response = await readConnectResponse(transport);
            assertConnectSucceeded(response, targetHost, targetPort);
            return transport;
        },
    };
}
