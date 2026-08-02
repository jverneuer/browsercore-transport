/**
 * @network/transport — public API surface.
 *
 * A generic byte-stream transport abstraction independent of TLS or HTTP.
 * Higher layers (tls, http1, http2) compose exclusively through these exports.
 */

export { connect, resolveHost, TcpTransport } from "./transport.js";
export type { Transport } from "./transport.js";

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

export { assertNever } from "./utils.js";
