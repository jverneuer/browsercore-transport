/**
 * Typed errors for @network/transport.
 *
 * Errors are part of the API — every failure mode is an explicit type so callers
 * can match on `kind` instead of parsing messages.
 */

import { assertNever } from "./utils.js";

export type TransportErrorDetails = Record<string, unknown>;

export class TransportError extends Error {
    public readonly kind = "TransportError" as const;
    public readonly details: TransportErrorDetails;
    /** `Error | undefined` (not `?`) so assignment is valid under exactOptionalPropertyTypes. */
    public override readonly cause: Error | undefined;

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

/** Connection could not be established within the configured timeout. */
export class ConnectTimeoutError extends Error {
    public readonly kind = "ConnectTimeoutError" as const;
    public readonly timeoutMs: number;
    public readonly host: string;
    public readonly port: number;

    constructor(host: string, port: number, timeoutMs: number) {
        super(`Connection to ${host}:${port} timed out after ${timeoutMs}ms`);
        this.name = "ConnectTimeoutError";
        this.timeoutMs = timeoutMs;
        this.host = host;
        this.port = port;
    }
}

/** No address could be resolved for the given host. */
export class DnsResolutionError extends Error {
    public readonly kind = "DnsResolutionError" as const;
    public readonly host: string;
    public override readonly cause: Error | undefined;

    constructor(host: string, options?: { cause?: Error }) {
        super(`DNS resolution failed for ${host}: ${options?.cause?.message ?? "unknown"}`);
        this.name = "DnsResolutionError";
        this.host = host;
        this.cause = options?.cause;
    }
}

/** Transport was open but no data flowed within the idle timeout. */
export class IdleTimeoutError extends Error {
    public readonly kind = "IdleTimeoutError" as const;
    public readonly idleMs: number;

    constructor(idleMs: number) {
        super(`Transport idle for ${idleMs}ms — closing`);
        this.name = "IdleTimeoutError";
        this.idleMs = idleMs;
    }
}

/** A read was pending but no data arrived within the per-read timeout. */
export class ReadTimeoutError extends Error {
    public readonly kind = "ReadTimeoutError" as const;
    public readonly timeoutMs: number;

    constructor(timeoutMs: number) {
        super(`No data received within ${timeoutMs}ms read timeout`);
        this.name = "ReadTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

/** Narrow a caught error to a typed transport error, or throw an explicit error. */
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
