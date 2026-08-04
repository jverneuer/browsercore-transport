/**
 * Typed errors for @browsercore/transport.
 *
 * Errors are part of the API — every failure mode is an explicit type so callers
 * can match on `kind` instead of parsing messages.
 */

import { assertNever } from "./utils.js";

/** Arbitrary structured metadata attached to a {@link TransportError} (e.g. host, port, timeoutMs). */
export type TransportErrorDetails = Record<string, unknown>;

/**
 * Base class for every error raised by `@browsercore/transport`.
 *
 * Every transport failure is an explicit, named type so callers can match on
 * the `kind` discriminator instead of parsing messages. All transport errors
 * extend this class, which itself extends `Error` — so a single `catch` on
 * `TransportError` (or `Error`) works, while `instanceof` against a subclass
 * narrows to a specific failure mode.
 *
 * @example
 * ```ts
 * try {
 *     await transport.write(data);
 * } catch (e) {
 *     if (e instanceof ConnectTimeoutError) {
 *         // retry against a fallback address...
 *     }
 *     throw e;
 * }
 * ```
 *
 * @since 0.1.0
 */
export class TransportError extends Error {
    public readonly kind = "TransportError" as const;
    public readonly details: TransportErrorDetails;
    /** `Error | undefined` (not `?`) so assignment is valid under exactOptionalPropertyTypes. */
    public override readonly cause: Error | undefined;

    /**
     * @param message - Human-readable description of the failure.
     * @param details - Structured metadata about the error (e.g. `{ host, port }`).
     * @param options - Standard `Error` options; `cause` preserves the wrapped error.
     */
    constructor(
        message: string,
        details: TransportErrorDetails = {},
        options?: { cause?: Error },
    ) {
        super(message, options);
        this.name = new.target.name;
        this.details = details;
        this.cause = options?.cause;
    }
}

/**
 * The connection could not be established within the configured connect timeout.
 *
 * Raised by {@link connect} / {@link TcpTransport.create} when the TCP
 * handshake does not complete in time. The `host`, `port`, and `timeoutMs`
 * fields let callers log the target and decide whether to retry.
 *
 * @example
 * ```ts
 * try {
 *     await connect({ host: "example.com", port: 443, connectTimeoutMs: 5000 });
 * } catch (e) {
 *     if (e instanceof ConnectTimeoutError) {
 *         console.warn(`Timed out after ${e.timeoutMs}ms`);
 *     }
 * }
 * ```
 *
 * @since 0.1.0
 */
export class ConnectTimeoutError extends Error {
    public readonly kind = "ConnectTimeoutError" as const;
    public readonly timeoutMs: number;
    public readonly host: string;
    public readonly port: number;

    /**
     * @param host - Target host the connection was attempted against.
     * @param port - Target port.
     * @param timeoutMs - Configured connect timeout in milliseconds.
     */
    constructor(host: string, port: number, timeoutMs: number) {
        super(`Connection to ${host}:${port} timed out after ${timeoutMs}ms`);
        this.name = "ConnectTimeoutError";
        this.timeoutMs = timeoutMs;
        this.host = host;
        this.port = port;
    }
}

/**
 * No address could be resolved for the given host.
 *
 * Raised by {@link resolveHost} when the configured (or default `dns.lookup`)
 * resolver returns an error for the requested hostname.
 *
 * @see resolveHost for the resolution entry point.
 *
 * @since 0.1.0
 */
export class DnsResolutionError extends Error {
    public readonly kind = "DnsResolutionError" as const;
    public readonly host: string;
    public override readonly cause: Error | undefined;

    /**
     * @param host - The hostname that failed to resolve.
     * @param options - `cause` wraps the underlying DNS error.
     */
    constructor(host: string, options?: { cause?: Error }) {
        super(`DNS resolution failed for ${host}: ${options?.cause?.message ?? "unknown"}`);
        this.name = "DnsResolutionError";
        this.host = host;
        this.cause = options?.cause;
    }
}

/**
 * The transport was open but no data flowed within the idle timeout.
 *
 * Raised when the idle timer fires (configured via {@link TransportOptions.idleTimeoutMs});
 * the transport emits the error and closes itself with a `"timeout"` reason.
 *
 * @since 0.1.0
 */
export class IdleTimeoutError extends Error {
    public readonly kind = "IdleTimeoutError" as const;
    public readonly idleMs: number;

    /**
     * @param idleMs - The configured idle timeout in milliseconds.
     */
    constructor(idleMs: number) {
        super(`Transport idle for ${idleMs}ms — closing`);
        this.name = "IdleTimeoutError";
        this.idleMs = idleMs;
    }
}

/**
 * A `read()` was pending but no data arrived within the per-read timeout.
 *
 * Raised when the per-read timer fires (configured via {@link TransportOptions.readTimeoutMs});
 * the pending {@link Transport.read} promise rejects with this error.
 *
 * @since 0.1.0
 */
export class ReadTimeoutError extends Error {
    public readonly kind = "ReadTimeoutError" as const;
    public readonly timeoutMs: number;

    /**
     * @param timeoutMs - The configured per-read timeout in milliseconds.
     */
    constructor(timeoutMs: number) {
        super(`No data received within ${timeoutMs}ms read timeout`);
        this.name = "ReadTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

/**
 * Narrow a caught error to a typed {@link TransportError}.
 *
 * Returns the input unchanged if it is already a `TransportError`. Otherwise
 * wraps it: an `Error` keeps its message as `cause`, and any other value is
 * stringified into a fresh `TransportError`. This is the canonical way to
 * convert unknown `catch` values into the typed error hierarchy.
 *
 * @param e - The caught value from a `catch` clause.
 * @returns A typed {@link TransportError}.
 *
 * @example
 * ```ts
 * try {
 *     await riskyOperation();
 * } catch (e) {
 *     throw ensureTransportError(e);
 * }
 * ```
 *
 * @since 0.1.0
 */
export function ensureTransportError(e: unknown): TransportError {
    if (e instanceof TransportError) {
        return e;
    }
    if (e instanceof Error) {
        return new TransportError(e.message, {}, { cause: e });
    }
    return new TransportError(typeof e === "string" ? e : "unknown transport error");
}

void assertNever; // referenced for tree-shaking safety in bundlers
