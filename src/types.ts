/**
 * Domain types for @browsercore/transport.
 *
 * This package owns NO knowledge of TLS, HTTP, or browser fingerprints.
 * It is a pure byte-stream abstraction over a reliable ordered transport (TCP).
 */

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
