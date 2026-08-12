/**
 * Randomness providers for @browsercore/transport.
 *
 * Abstracted so protocol layers can be tested deterministically against
 * synthetic randomness. The default source is backed by the Web Crypto API
 * (`globalThis.crypto.getRandomValues`), which is available in every modern
 * runtime (Node 20+, browsers, Deno, Bun, Workers) without a `node:` import;
 * {@link DeterministicRandom} is a seeded xorshift32 used for repeatable unit
 * tests (NOT cryptographically secure).
 */

/**
 * Source of random bytes. Abstracted so protocol layers can be tested
 * deterministically against synthetic randomness.
 */
export interface RandomSource {
    /** Generate `length` cryptographically-strong random bytes. */
    randomBytes(length: number): Uint8Array;
}

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
 * Factory that returns the default {@link RandomSource} backed by the Web
 * Crypto API (`globalThis.crypto.getRandomValues`). Centralizes the choice of
 * default so callers can swap the implementation in one place.
 */
export function createRandomSource(): RandomSource {
    return {
        // Web Crypto's getRandomValues accepts at most 65 536 bytes per call
        // (per the WHATWG spec); loop in chunks so arbitrary lengths work.
        randomBytes: (len: number): Uint8Array => {
            const out = new Uint8Array(len);
            const limit = 65_536;
            for (let offset = 0; offset < len; offset += limit) {
                globalThis.crypto.getRandomValues(
                    out.subarray(offset, Math.min(offset + limit, len)),
                );
            }
            return out;
        },
    };
}
