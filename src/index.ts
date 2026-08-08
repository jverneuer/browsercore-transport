/**
 * @browsercore/transport — public API surface.
 *
 * A generic byte-stream transport abstraction independent of TLS or HTTP.
 * Higher layers (tls, http1, http2) compose exclusively through these exports.
 *
 * The package provides:
 * - {@link connect} — open a {@link Transport} to a host:port
 * - {@link TcpTransport} — the concrete implementation over an injected {@link Net}
 * - {@link Transport}, {@link TransportOptions}, {@link TransportState} — the domain types
 * - A typed error hierarchy ({@link TransportError} and subclasses) matched on `kind`
 *
 * This package imports only interfaces from `@browsercore/contracts` — never
 * `node:net` or `node:dns` directly. Platform adapters are injected via
 * {@link TransportOptions.net} and {@link TransportOptions.dns}.
 *
 * @module
 */

export { connect } from "./connect.js";
export { resolveHost, TcpTransport } from "./transport.js";
export type { Transport, StreamTransport, DatagramTransport, UdpAddress, DatagramCloseReason } from "./types.js";

export {
    ConnectTimeoutError,
    DnsResolutionError,
    IdleTimeoutError,
    ReadTimeoutError,
    TransportError,
    ensureTransportError,
} from "./errors.js";
export type { TransportErrorDetails } from "./errors.js";

export {
    type CloseReason,
    type ResolvedAddress,
    type TransportId,
    type TransportOptions,
    type TransportState,
} from "./types.js";

export { nodeRandomSource, DeterministicRandom, createRandomSource } from "./random-source.js";
export type { RandomSource } from "./random-source.js";

export { assertNever } from "./utils.js";

export { createTypedEventEmitter } from "./events.js";
export type { TypedEventEmitter } from "./events.js";

// Re-export platform-agnostic contracts for convenience — consumers can pull
// Net/Socket/DnsResolver from here without importing @browsercore/contracts.
export type { Net, Socket, DnsResolver, ConnectOptions, IPAddress } from "@browsercore/contracts";
