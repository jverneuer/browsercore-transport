/**
 * Tests for random-source.ts — the RandomSource abstraction.
 *
 * Covers the default node-backed source, the deterministic test source,
 * and the factory function.
 */

import { describe, expect, it } from "vitest";
import {
    nodeRandomSource,
    DeterministicRandom,
    createRandomSource,
} from "../src/random-source.js";

describe("nodeRandomSource", () => {
    it("returns a Uint8Array of the requested length", () => {
        const bytes = nodeRandomSource.randomBytes(32);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBe(32);
    });

    it("returns different bytes on successive calls", () => {
        const a = nodeRandomSource.randomBytes(16);
        const b = nodeRandomSource.randomBytes(16);
        // Two random 16-byte buffers should not be equal (2^-128 chance of collision).
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    });

    it("handles zero-length request", () => {
        const bytes = nodeRandomSource.randomBytes(0);
        expect(bytes.length).toBe(0);
    });
});

describe("DeterministicRandom", () => {
    it("returns a Uint8Array of the requested length", () => {
        const rng = new DeterministicRandom(12345);
        const bytes = rng.randomBytes(16);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBe(16);
    });

    it("produces the same sequence for the same seed", () => {
        const a = new DeterministicRandom(42);
        const b = new DeterministicRandom(42);
        expect(Array.from(a.randomBytes(32))).toEqual(Array.from(b.randomBytes(32)));
    });

    it("produces different sequences for different seeds", () => {
        const a = new DeterministicRandom(1);
        const b = new DeterministicRandom(2);
        expect(Array.from(a.randomBytes(32))).not.toEqual(Array.from(b.randomBytes(32)));
    });

    it("each byte is in the 0-255 range", () => {
        const rng = new DeterministicRandom(999);
        const bytes = rng.randomBytes(100);
        for (const byte of bytes) {
            expect(byte).toBeGreaterThanOrEqual(0);
            expect(byte).toBeLessThanOrEqual(255);
        }
    });

    it("advances state across calls (output evolves)", () => {
        const rng = new DeterministicRandom(7);
        const first = Array.from(rng.randomBytes(8));
        const second = Array.from(rng.randomBytes(8));
        expect(first).not.toEqual(second);
    });
});

describe("createRandomSource", () => {
    it("returns the node-backed default source", () => {
        const source = createRandomSource();
        expect(source).toBe(nodeRandomSource);
    });

    it("returned source produces random bytes", () => {
        const source = createRandomSource();
        const bytes = source.randomBytes(8);
        expect(bytes.length).toBe(8);
    });
});
