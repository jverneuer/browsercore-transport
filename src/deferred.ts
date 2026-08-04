/**
 * Async-waiter primitives for @browsercore/transport.
 *
 * A `Deferred<T>` couples a promise with the ability to settle it from the
 * outside — the standard bridge between event-callback land (socket "data",
 * "drain") and the async/await land our public API speaks. Instead of stashing
 * bare `resolve`/`reject` callbacks in two fields, we keep one `Deferred` and
 * read `.promise`/`.resolve`/`.reject` off it. One shape, named once.
 */

import type { Deferred } from "./types.js";

/**
 * Build a `Deferred<T>`: a promise whose resolution is controlled manually from the outside.
 *
 * This is the standard bridge between event-callback land (socket `"data"`,
 * `"drain"`) and the async/await land our public API speaks. Instead of
 * stashing bare `resolve`/`reject` callbacks in two fields, a `Deferred`
 * keeps one shape — `promise`, `resolve`, and `reject` together.
 *
 * The executor runs synchronously during `new Promise(...)`, so `resolve` and
 * `reject` are assigned before this returns — the `!` assertions just quiet
 * the compiler's definite-assignment check.
 *
 * @template T - The type the promise resolves with.
 * @returns A {@link Deferred} containing the promise and its settlement functions.
 *
 * @example
 * ```ts
 * const deferred = createDeferred<Uint8Array>();
 * socket.once("data", (chunk) => deferred.resolve(chunk));
 * const chunk = await deferred.promise;
 * ```
 *
 * @see Deferred for the interface.
 * @since 0.1.0
 */
export function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
