/**
 * Backpressure queue for @browsercore/transport.
 *
 * When `socket.write()` returns `false` the kernel send buffer is full and the
 * transport must defer resolving the caller's `write()` promise until the
 * `"drain"` event fires. `DrainQueue` serializes those waiters so concurrent
 * backpressured writes resume one-at-a-time in FIFO order instead of all
 * piling onto the next drain.
 */

import type { Deferred, DrainQueue } from "./types.js";
import { createDeferred } from "./deferred.js";

/**
 * Create a `DrainQueue` that serializes writers waiting on socket backpressure.
 *
 * When `socket.write()` returns `false` the kernel send buffer is full and the
 * transport must defer resolving the caller's `write()` promise until the
 * `"drain"` event fires. `DrainQueue` lines those waiters up so concurrent
 * backpressured writes resume one-at-a-time in FIFO order instead of all
 * piling onto the next drain.
 *
 * The internal chain starts resolved so the first `awaitDrain()` settles
 * immediately once a `"drain"` fires; each waiter appends itself to the chain,
 * and a per-waiter `.catch` keeps the chain alive even if that waiter rejects
 * (e.g. the socket errored out while it was queued).
 *
 * @returns A {@link DrainQueue} with `awaitDrain`, `notifyDrain`, and `reject` methods.
 *
 * @example
 * ```ts
 * const drain = createDrainQueue();
 * // In write(): when socket.write returns false,
 * //   await drain.awaitDrain();
 * // On socket "drain":
 * //   drain.notifyDrain();
 * // On socket "error"/"close":
 * //   drain.reject(err);
 * ```
 *
 * @see DrainQueue for the interface.
 * @since 0.1.0
 */
export function createDrainQueue(): DrainQueue {
    let chain: Promise<void> = Promise.resolve();
    let waiter: Deferred<void> | undefined;

    return {
        awaitDrain(): Promise<void> {
            const next = chain.then(() => {
                const deferred = createDeferred<void>();
                waiter = deferred;
                return deferred.promise;
            });
            // Keep the chain alive even if this individual waiter rejects.
            chain = next.catch(() => {});
            return next;
        },

        notifyDrain(): void {
            const w = waiter;
            if (w) {
                waiter = undefined;
                w.resolve();
            }
        },

        reject(err: Error): void {
            const w = waiter;
            if (w) {
                waiter = undefined;
                w.reject(err);
            }
        },
    };
}
