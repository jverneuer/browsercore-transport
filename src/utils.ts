/**
 * Small shared helpers for @browsercore/transport.
 *
 * Kept dependency-free so every package can copy the pattern without pulling in
 * cross-package imports.
 */

import { systemClock, type Clock } from "./types.js";

/**
 * Compile-time exhaustiveness check for `switch`/`if-else` over discriminated unions.
 *
 * Call in the `default` branch with the narrowed variable: `default: assertNever(x)`.
 * The argument is typed `never`, so adding a new union member forces every handler
 * to compile-error until it handles the new case. At runtime (if the check is ever
 * bypassed by an untyped value) it throws with the offending value.
 *
 * @param x - A value that must be `never` at compile time.
 * @throws {Error} If reached at runtime with a non-`never` value.
 *
 * @example
 * ```ts
 * switch (state.state) {
 *     case "open": return doOpen();
 *     case "closed": return doClosed();
 *     default: return assertNever(state.state);
 * }
 * ```
 *
 * @since 0.1.0
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function assertNever(x: never): never {
    throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

/**
 * Generate a unique id with a given prefix.
 *
 * Combines the current wall-clock timestamp (base-36, from the injected
 * canonical `Clock`) with a random suffix to produce an opaque,
 * collision-resistant id suitable for correlation/logging. The suffix uses
 * `Math.random` — deliberately NOT crypto-grade: these ids are correlation
 * handles, not secrets; use `crypto.randomUUID()` if you need
 * unpredictability.
 *
 * @param prefix - Human-readable prefix (e.g. `"transport"`, `"jar"`).
 * @param clock - Time source for the timestamp part. Defaults to
 *   {@link systemClock}; inject a deterministic Clock in tests so ids are
 *   reproducible.
 * @returns A unique id string, e.g. `"transport_lzq3k1_2f9x7"`.
 *
 * @example
 * ```ts
 * createId("transport"); // "transport_lzq3k1_2f9x7"
 * ```
 *
 * @since 0.1.0
 */
export function createId(prefix: string, clock: Clock = systemClock): string {
    return `${prefix}_${clock.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}
