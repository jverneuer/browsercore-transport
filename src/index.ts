/**
 * @browsercore/transport — public API surface.
 *
 * A generic byte-stream transport abstraction independent of TLS or HTTP.
 * Higher layers (tls, http1, http2) compose exclusively through these exports.
 *
 * The package provides:
 * - {@link connect} — open a {@link Transport} to a host:port
 * - {@link TcpTransport} — the concrete `node:net.Socket`-based implementation
 * - {@link Transport}, {@link TransportOptions}, {@link TransportState} — the domain types
 * - A typed error hierarchy ({@link TransportError} and subclasses) matched on `kind`
 *
 * @module
 */

export { connect } from "./connect.js";
export { resolveHost, TcpTransport } from "./transport.js";
export type { Transport, StreamTransport, DatagramTransport, UdpAddress, DatagramCloseReason } from "./types.js";

export { createHttpProxy, directConnector } from "./types.js";
export type { ProxyConnector, ProxyOptions } from "./types.js";

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
    type DnsLookupFn,
    type ResolvedAddress,
    type TransportId,
    type TransportOptions,
    type TransportState,
} from "./types.js";

export { nodeRandomSource, DeterministicRandom } from "./types.js";
export type { RandomSource } from "./types.js";

export { assertNever } from "./utils.js";
