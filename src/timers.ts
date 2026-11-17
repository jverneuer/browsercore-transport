/**
 * Idle + per-read timers for @browsercore/transport.
 *
 * The idle timer closes a connection across which no data flows for too long;
 * the per-read timer bounds how long a single `read()` may block. Both are
 * optional — their durations are `undefined` when disabled, and every reset is
 * a no-op in that case.
 *
 * Every timer is armed on the injected canonical `Clock`
 * (`@browsercore/contracts`), never on bare `setTimeout` — the runtime-coupling
 * audit (2026-11-16) flagged this module as the polyrepo's only Node-typed
 * timer-handle leak, and timer tokens are now opaque {@link TimerHandle}s.
 */

import { IdleTimeoutError, ReadTimeoutError } from "./errors.js";
import { systemClock, type Clock, type TimerHandle, type TransportTimers } from "./types.js";

/**
 * Options for {@link createTransportTimers}.
 *
 * Durations are optional — a timeout is disabled when its duration is `undefined`,
 * and every reset is a no-op in that case. Callbacks (not timers) carry the side
 * effects so the timer module owns only clock `setTimeout`/`clearTimeout`.
 */
export interface TransportTimersOptions {
    /** Idle timeout in ms, or `undefined` to disable. */
    readonly idleTimeoutMs: number | undefined;
    /** Per-read timeout in ms, or `undefined` to disable. */
    readonly readTimeoutMs: number | undefined;
    /**
     * Time + timer source — the canonical `Clock` from
     * `@browsercore/contracts`. Defaults to {@link systemClock} (platform
     * globals); inject a manual-advance Clock for deterministic tests.
     */
    readonly clock?: Clock;
    /**
     * Called when the idle timer fires. The transport emits the error and
     * closes with a `"timeout"` reason — supplied by the caller so this module
     * stays free of transport/emitter coupling.
     *
     * @see IdleTimeoutError - the error passed to this callback.
     */
    readonly onIdleTimeout: (err: IdleTimeoutError) => void;
    /**
     * Called when the per-read timer fires, to reject the pending read.
     *
     * @see ReadTimeoutError - the error passed to this callback.
     */
    readonly onReadTimeout: (err: ReadTimeoutError) => void;
}

/**
 * Create the idle + per-read timer pair that drive transport lifecycle timeouts.
 *
 * Side effects are delegated to the caller-supplied callbacks, so this module
 * only manages clock arming/cancelling and the timeout durations. Return
 * the {@link TransportTimers} interface and wire it into a {@link TcpTransport}.
 *
 * @param opts - Configuration: durations, the {@link Clock} timers arm on
 *   (defaults to {@link systemClock}), and the callbacks invoked on timeout.
 * @returns A {@link TransportTimers} handle with reset/clear methods.
 *
 * @example
 * ```ts
 * const timers = createTransportTimers({
 *     idleTimeoutMs: 30_000,
 *     readTimeoutMs: 10_000,
 *     onIdleTimeout: (err) => { transport.emit("error", err); },
 *     onReadTimeout: (err) => { rejectPendingRead(err); },
 * });
 * timers.resetIdle(); // whenever data flows
 * timers.clearAll();  // on close
 * ```
 *
 * @see TransportTimers for the interface.
 * @since 0.1.0
 */
export function createTransportTimers(opts: TransportTimersOptions): TransportTimers {
    const clock = opts.clock ?? systemClock;
    let idleTimer: TimerHandle | undefined;
    let readTimer: TimerHandle | undefined;

    return {
        resetIdle(): void {
            const idleMs = opts.idleTimeoutMs;
            if (idleMs === undefined) {
                return;
            }
            if (idleTimer !== undefined) {
                clock.clearTimeout(idleTimer);
            }
            idleTimer = clock.setTimeout(idleMs, () => {
                opts.onIdleTimeout(new IdleTimeoutError(idleMs));
            });
        },

        clearIdle(): void {
            if (idleTimer !== undefined) {
                clock.clearTimeout(idleTimer);
            }
            idleTimer = undefined;
        },

        resetRead(): void {
            const readMs = opts.readTimeoutMs;
            if (readMs === undefined) {
                return;
            }
            if (readTimer !== undefined) {
                clock.clearTimeout(readTimer);
            }
            readTimer = clock.setTimeout(readMs, () => {
                opts.onReadTimeout(new ReadTimeoutError(readMs));
            });
        },

        clearRead(): void {
            if (readTimer !== undefined) {
                clock.clearTimeout(readTimer);
            }
            readTimer = undefined;
        },

        clearAll(): void {
            if (idleTimer !== undefined) {
                clock.clearTimeout(idleTimer);
            }
            if (readTimer !== undefined) {
                clock.clearTimeout(readTimer);
            }
            idleTimer = undefined;
            readTimer = undefined;
        },
    };
}
