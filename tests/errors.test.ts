import { describe, expect, it } from "vitest";
import {
    ConnectTimeoutError,
    DnsResolutionError,
    IdleTimeoutError,
    ReadTimeoutError,
    TransportError,
    ensureTransportError,
} from "../src/index.js";

describe("TransportError", () => {
    it("captures an optional cause (covers the `options?.cause` defined path)", () => {
        // The constructor's `this.cause = options?.cause` only reads the cause
        // when a third `options` argument is supplied — exercise that path so the
        // optional-chain true branch is covered.
        const cause = new Error("underlying failure");
        const e = new TransportError("boom", { path: "/x" }, { cause });
        expect(e).toBeInstanceOf(Error);
        expect(e.kind).toBe("TransportError");
        expect(e.details.path).toBe("/x");
        expect(e.cause).toBe(cause);
    });
});

describe("DnsResolutionError", () => {
    it("falls back to 'unknown' when no cause message is present (covers the `??` default)", () => {
        // Message template: `${options?.cause?.message ?? "unknown"}`. The
        // `?? "unknown"` fallback only fires when the cause is absent — construct
        // without a cause to exercise that branch.
        const e = new DnsResolutionError("nx.example");
        expect(e).toBeInstanceOf(Error);
        expect(e.kind).toBe("DnsResolutionError");
        expect(e.host).toBe("nx.example");
        expect(e.cause).toBeUndefined();
        expect(e.message).toContain("unknown");
    });
});

describe("ensureTransportError", () => {
    it("returns a TransportError unchanged (instanceof short-circuit)", () => {
        const e = new TransportError("already typed");
        expect(ensureTransportError(e)).toBe(e);
    });

    it("wraps a plain Error, preserving it as the cause", () => {
        const inner = new Error("underlying");
        const wrapped = ensureTransportError(inner);
        expect(wrapped).toBeInstanceOf(TransportError);
        expect(wrapped).not.toBe(inner);
        expect(wrapped.message).toBe("underlying");
        expect(wrapped.cause).toBe(inner);
    });

    it("wraps a bare string message", () => {
        const e = ensureTransportError("string failure");
        expect(e).toBeInstanceOf(TransportError);
        expect(e.message).toBe("string failure");
    });

    it("maps an unknown non-error value to the default message", () => {
        // Neither an Error nor a string — the final else branch produces the
        // static "unknown transport error" message.
        const e = ensureTransportError(42);
        expect(e).toBeInstanceOf(TransportError);
        expect(e.message).toBe("unknown transport error");
    });
});

describe("ConnectTimeoutError", () => {
    it("records the host, port, and timeout and embeds them in the message", () => {
        const e = new ConnectTimeoutError("example.com", 443, 5_000);
        expect(e).toBeInstanceOf(Error);
        expect(e.kind).toBe("ConnectTimeoutError");
        expect(e.host).toBe("example.com");
        expect(e.port).toBe(443);
        expect(e.timeoutMs).toBe(5_000);
        expect(e.name).toBe("ConnectTimeoutError");
        expect(e.message).toContain("example.com:443");
        expect(e.message).toContain("5000ms");
    });
});

describe("IdleTimeoutError", () => {
    it("records the idle duration and embeds it in the message", () => {
        const e = new IdleTimeoutError(30_000);
        expect(e).toBeInstanceOf(Error);
        expect(e.kind).toBe("IdleTimeoutError");
        expect(e.idleMs).toBe(30_000);
        expect(e.name).toBe("IdleTimeoutError");
        expect(e.message).toContain("30000ms");
    });
});

describe("ReadTimeoutError", () => {
    it("records the per-read timeout and embeds it in the message", () => {
        const e = new ReadTimeoutError(2_500);
        expect(e).toBeInstanceOf(Error);
        expect(e.kind).toBe("ReadTimeoutError");
        expect(e.timeoutMs).toBe(2_500);
        expect(e.name).toBe("ReadTimeoutError");
        expect(e.message).toContain("2500ms");
    });
});
