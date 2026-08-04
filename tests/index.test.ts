import { describe, expect, it } from "vitest";
import {
    assertNever,
    connect,
    ConnectTimeoutError,
    DnsResolutionError,
    ensureTransportError,
    IdleTimeoutError,
    ReadTimeoutError,
    resolveHost,
    TcpTransport,
    TransportError,
} from "../src/index.js";

/**
 * The barrel (src/index.ts) is the contract every higher layer (tls, http1,
 * http2) imports from. This test pins the public API surface so a refactor that
 * drops or renames an export fails loudly rather than breaking a downstream
 * package at import time. Each assertion checks the export exists and has the
 * shape its consumers rely on.
 */
describe("public API surface (src/index.ts barrel)", () => {
    it("re-exports the connect() factory as a function", () => {
        expect(typeof connect).toBe("function");
    });

    it("re-exports the concrete TcpTransport class", () => {
        expect(typeof TcpTransport).toBe("function");
        // `create` is a static factory (on the constructor); the instance methods
        // live on the prototype. Pin both so a shuffle of method placement breaks
        // the contract higher layers depend on.
        expect(typeof TcpTransport.create).toBe("function");
        expect(TcpTransport.prototype).toHaveProperty("write");
        expect(TcpTransport.prototype).toHaveProperty("read");
        expect(TcpTransport.prototype).toHaveProperty("close");
    });

    it("re-exports resolveHost as a function", () => {
        expect(typeof resolveHost).toBe("function");
    });

    it("re-exports every typed error class", () => {
        // Each is constructable and carries its discriminator `kind`.
        expect(new TransportError("x").kind).toBe("TransportError");
        expect(new ConnectTimeoutError("h", 1, 2).kind).toBe("ConnectTimeoutError");
        expect(new DnsResolutionError("h").kind).toBe("DnsResolutionError");
        expect(new IdleTimeoutError(100).kind).toBe("IdleTimeoutError");
        expect(new ReadTimeoutError(100).kind).toBe("ReadTimeoutError");
    });

    it("re-exports the ensureTransportError narrowing helper", () => {
        expect(typeof ensureTransportError).toBe("function");
        const e = ensureTransportError(new Error("x"));
        expect(e).toBeInstanceOf(TransportError);
    });

    it("re-exports the assertNever exhaustiveness helper", () => {
        expect(typeof assertNever).toBe("function");
        expect(() => assertNever("value" as never)).toThrow(/Unexpected value/);
    });
});
