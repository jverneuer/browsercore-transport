/**
 * Idle + per-read timers for @browsercore/transport.
 *
 * The idle timer closes a connection across which no data flows for too long;
 * the per-read timer bounds how long a single `read()` may block. Both are
 * optional — their durations are `undefined` when disabled, and every reset is
 * a no-op in that case.
 */

import { IdleTimeoutError, ReadTimeoutError } from "./errors.js";
import type { TransportTimers } from "./types.js";

export interface TransportTimersOptions {
    /** Idle timeout in ms, or `undefined` to disable. */
    readonly idleTimeoutMs: number | undefined;
    /** Per-read timeout in ms, or `undefined` to disable. */
    readonly readTimeoutMs: number | undefined;
    /**
     * Called when the idle timer fires. The transport emits the error and
     * closes with a `"timeout"` reason — supplied by the caller so this module
     * stays free of transport/emitter coupling.
     */
    readonly onIdleTimeout: (err: IdleTimeoutError) => void;
    /** Called when the per-read timer fires, to reject the pending read. */
    readonly onReadTimeout: (err: ReadTimeoutError) => void;
}

/**
 * Create the timer pair. Callbacks (not timers) carry the side effects so this
 * module owns only `setTimeout`/`clearTimeout` and the timeout durations.
 */
export function createTransportTimers(opts: TransportTimersOptions): TransportTimers {
    let idleTimer: NodeJS.Timeout | undefined;
    let readTimer: NodeJS.Timeout | undefined;

    return {
        resetIdle(): void {
            const idleMs = opts.idleTimeoutMs;
            if (idleMs === undefined) {
                return;
            }
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                opts.onIdleTimeout(new IdleTimeoutError(idleMs));
            }, idleMs);
        },

        clearIdle(): void {
            clearTimeout(idleTimer);
            idleTimer = undefined;
        },

        resetRead(): void {
            const readMs = opts.readTimeoutMs;
            if (readMs === undefined) {
                return;
            }
            clearTimeout(readTimer);
            readTimer = setTimeout(() => {
                opts.onReadTimeout(new ReadTimeoutError(readMs));
            }, readMs);
        },

        clearRead(): void {
            clearTimeout(readTimer);
            readTimer = undefined;
        },

        clearAll(): void {
            clearTimeout(idleTimer);
            clearTimeout(readTimer);
            idleTimer = undefined;
            readTimer = undefined;
        },
    };
}
