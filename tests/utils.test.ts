import { describe, expect, it } from "vitest";
import { assertNever, createId } from "../src/utils.js";

describe("createId", () => {
    it("emits a non-empty, prefix-tagged string", () => {
        const id = createId("transport");
        expect(typeof id).toBe("string");
        expect(id.startsWith("transport_")).toBe(true);
        expect(id.length).toBeGreaterThan("transport_".length);
    });

    it("produces distinct ids across calls (random suffix)", () => {
        // Two calls in the same millisecond must still differ — the random suffix
        // is what guarantees uniqueness when the timestamp collides.
        const a = createId("x");
        const b = createId("x");
        expect(a).not.toBe(b);
    });
});

describe("assertNever", () => {
    it("throws an exhaustiveness error for any value reaching the default branch", () => {
        // In a correctly exhaustive switch this function is never reached at
        // runtime; the test calls it directly (via a `never` cast) to prove it
        // throws rather than silently returning.
        expect(() => assertNever("surprise" as never)).toThrow(/Unexpected value/);
    });
});
