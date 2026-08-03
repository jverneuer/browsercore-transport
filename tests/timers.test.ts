import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
    createTransportTimers,
    type TransportTimersOptions,
} from "../src/timers.js";

type Spy<T extends (...a: never[]) => unknown> = ReturnType<typeof vi.fn<T>>;

interface Harness {
    opts: TransportTimersOptions;
    onIdleTimeout: Spy<(err: { idleMs: number }) => void>;
    onReadTimeout: Spy<(err: { timeoutMs: number }) => void>;
}

/** Build timers opts with spy callbacks already wired in. */
function makeOpts(config: { idleTimeoutMs?: number; readTimeoutMs?: number } = {}): Harness {
    const onIdleTimeout = vi.fn();
    const onReadTimeout = vi.fn();
    return {
        opts: {
            idleTimeoutMs: config.idleTimeoutMs,
            readTimeoutMs: config.readTimeoutMs,
            onIdleTimeout,
            onReadTimeout,
        },
        onIdleTimeout,
        onReadTimeout,
    };
}

describe("createTransportTimers", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    describe("idle timer", () => {
        it("fires onIdleTimeout exactly once after idleTimeoutMs elapses", () => {
            const { opts, onIdleTimeout } = makeOpts({ idleTimeoutMs: 100 });
            const t = createTransportTimers(opts);
            t.resetIdle();

            vi.advanceTimersByTime(99);
            expect(onIdleTimeout).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(onIdleTimeout).toHaveBeenCalledTimes(1);
            // IdleTimeoutError carries the configured duration.
            const err = onIdleTimeout.mock.calls[0]![0];
            expect(err.idleMs).toBe(100);
        });

        it("resetIdle() clears the previously armed timer so only the latest fires", () => {
            const { opts, onIdleTimeout } = makeOpts({ idleTimeoutMs: 100 });
            const t = createTransportTimers(opts);
            t.resetIdle();
            vi.advanceTimersByTime(60);
            t.resetIdle(); // restart — old timer must be cleared
            vi.advanceTimersByTime(99);
            expect(onIdleTimeout).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(onIdleTimeout).toHaveBeenCalledTimes(1);
        });

        it("clearIdle() cancels an armed idle timer", () => {
            const { opts, onIdleTimeout } = makeOpts({ idleTimeoutMs: 100 });
            const t = createTransportTimers(opts);
            t.resetIdle();
            t.clearIdle();
            vi.advanceTimersByTime(10_000);
            expect(onIdleTimeout).not.toHaveBeenCalled();
        });

        it("resetIdle() is a no-op when idleTimeoutMs is undefined", () => {
            const { opts, onIdleTimeout } = makeOpts();
            const t = createTransportTimers(opts);
            t.resetIdle();
            vi.advanceTimersByTime(1_000_000);
            expect(onIdleTimeout).not.toHaveBeenCalled();
        });

        it("clearIdle() is a no-op when nothing is armed", () => {
            const { opts } = makeOpts({ idleTimeoutMs: 100 });
            const t = createTransportTimers(opts);
            expect(() => t.clearIdle()).not.toThrow();
        });
    });

    describe("per-read timer", () => {
        it("fires onReadTimeout exactly once after readTimeoutMs elapses", () => {
            const { opts, onReadTimeout } = makeOpts({ readTimeoutMs: 50 });
            const t = createTransportTimers(opts);
            t.resetRead();

            vi.advanceTimersByTime(49);
            expect(onReadTimeout).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(onReadTimeout).toHaveBeenCalledTimes(1);
            const err = onReadTimeout.mock.calls[0]![0];
            expect(err.timeoutMs).toBe(50);
        });

        it("resetRead() clears the previously armed timer so only the latest fires", () => {
            const { opts, onReadTimeout } = makeOpts({ readTimeoutMs: 50 });
            const t = createTransportTimers(opts);
            t.resetRead();
            vi.advanceTimersByTime(30);
            t.resetRead();
            vi.advanceTimersByTime(49);
            expect(onReadTimeout).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(onReadTimeout).toHaveBeenCalledTimes(1);
        });

        it("clearRead() cancels an armed read timer", () => {
            const { opts, onReadTimeout } = makeOpts({ readTimeoutMs: 50 });
            const t = createTransportTimers(opts);
            t.resetRead();
            t.clearRead();
            vi.advanceTimersByTime(10_000);
            expect(onReadTimeout).not.toHaveBeenCalled();
        });

        it("resetRead() is a no-op when readTimeoutMs is undefined", () => {
            const { opts, onReadTimeout } = makeOpts();
            const t = createTransportTimers(opts);
            t.resetRead();
            vi.advanceTimersByTime(1_000_000);
            expect(onReadTimeout).not.toHaveBeenCalled();
        });

        it("clearRead() is a no-op when nothing is armed", () => {
            const { opts } = makeOpts({ readTimeoutMs: 50 });
            const t = createTransportTimers(opts);
            expect(() => t.clearRead()).not.toThrow();
        });
    });

    describe("clearAll", () => {
        it("cancels both the idle and read timers at once", () => {
            const { opts, onIdleTimeout, onReadTimeout } = makeOpts({
                idleTimeoutMs: 100,
                readTimeoutMs: 50,
            });
            const t = createTransportTimers(opts);
            t.resetIdle();
            t.resetRead();
            t.clearAll();
            vi.advanceTimersByTime(10_000);
            expect(onIdleTimeout).not.toHaveBeenCalled();
            expect(onReadTimeout).not.toHaveBeenCalled();
        });

        it("is safe to call when nothing is armed", () => {
            const { opts } = makeOpts({ idleTimeoutMs: 100, readTimeoutMs: 50 });
            const t = createTransportTimers(opts);
            expect(() => t.clearAll()).not.toThrow();
        });
    });

    it("idle and read timers are independent — clearing one does not clear the other", () => {
        const { opts, onIdleTimeout, onReadTimeout } = makeOpts({
            idleTimeoutMs: 100,
            readTimeoutMs: 50,
        });
        const t = createTransportTimers(opts);
        t.resetIdle();
        t.resetRead();
        t.clearIdle(); // only the idle timer
        vi.advanceTimersByTime(60);
        expect(onReadTimeout).toHaveBeenCalledTimes(1);
        expect(onIdleTimeout).not.toHaveBeenCalled();
    });
});
