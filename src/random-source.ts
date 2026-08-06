/**
 * Randomness providers for @browsercore/transport.
 *
 * Abstracted so protocol layers can be tested deterministically against
 * synthetic randomness. The default {@link nodeRandomSource} is backed by
 * `node:crypto.randomBytes`; {@link DeterministicRandom} is a seeded xorshift32
 * used for repeatable unit tests (NOT cryptographically secure).
 */

import { randomBytes } from "node:crypto";

/**
 * Source of random bytes. Abstracted so protocol layers can be tested
 * deterministically against synthetic randomness.
 */
export interface RandomSource {
    /** Generate `length` cryptographically-strong random bytes. */
    randomBytes(length: number): Uint8Array;
}

/**
 * Default {@link RandomSource} backed by `node:crypto.randomBytes`.
 * Used by protocol layers unless a deterministic source is injected.
 */
export const nodeRandomSource: RandomSource = {
    randomBytes: (len) => randomBytes(len),
};

/**
 * Deterministic {@link RandomSource} using xorshift32. Seeded repeatability
 * makes protocol-layer unit tests stable across runs — the output is NOT
 * cryptographically secure and must never be used for real keys.
 */
export class DeterministicRandom implements RandomSource {
    private state: number;
    constructor(seed: number) {
        this.state = Math.trunc(seed);
    }
    randomBytes(length: number): Uint8Array {
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            // xorshift32
            this.state ^= this.state << 13;
            this.state ^= this.state >> 17;
            this.state ^= this.state << 5;
            out[i] = (this.state >>> 0) & 0xff;
        }
        return out;
    }
}

/**
 * Factory that returns the default {@link RandomSource}. Centralizes the
 * choice of default so callers can swap the implementation in one place.
 */
export function createRandomSource(): RandomSource {
    return nodeRandomSource;
}
