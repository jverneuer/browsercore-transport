import { describe, expect, it, vi } from "vitest";
import { createTypedEventEmitter } from "../src/events.js";
import type { EventProvider } from "@browsercore/contracts";

/** Minimal EventProvider mock for testing the typed emitter surface. */
function createMockEventProvider(): EventProvider {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
        on(event, listener) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(listener);
        },
        once(event, listener) {
            const wrapped = (...args: unknown[]) => {
                this.off(event, wrapped);
                listener(...args);
            };
            this.on(event, wrapped);
        },
        off(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        removeListener(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        emit(event, ...args) {
            const set = listeners.get(event);
            if (!set || set.size === 0) return false;
            for (const l of set) l(...args);
            return true;
        },
        listenerCount(event) {
            return listeners.get(event)?.size ?? 0;
        },
        removeAllListeners(event) {
            if (event) listeners.delete(event);
            else listeners.clear();
        },
    };
}

/**
 * Event map shared across the tests. Mirrors the kind of shape higher layers
 * (transport, TLS) would use: a mix of zero-arg, single-arg, and multi-arg
 * events.
 */
type TestEvents = {
    connect: () => void;
    data: (chunk: string) => void;
    error: (err: Error) => void;
};

describe("TypedEventEmitter", () => {
    describe("on / emit", () => {
        it("delivers an emitted event to a registered listener", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const onConnect = vi.fn();
            emitter.on("connect", onConnect);
            emitter.emit("connect");
            expect(onConnect).toHaveBeenCalledTimes(1);
        });

        it("delivers the exact arguments a listener declares", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const onData = vi.fn();
            emitter.on("data", onData);
            emitter.emit("data", "hello");
            expect(onData).toHaveBeenCalledTimes(1);
            expect(onData).toHaveBeenCalledWith("hello");
            // The argument is typed — `calls[0][0]` is `string`, not `any`.
            const [chunk] = onData.mock.calls[0] as [string];
            expect(chunk).toBe("hello");
        });

        it("delivers Error-typed arguments to an error listener", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const onError = vi.fn();
            const err = new Error("boom");
            emitter.on("error", onError);
            emitter.emit("error", err);
            expect(onError).toHaveBeenCalledTimes(1);
            const [received] = onError.mock.calls[0] as [Error];
            expect(received).toBe(err);
            expect(received.message).toBe("boom");
        });

        it("invokes all listeners registered for the same event, in order", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const calls: number[] = [];
            const first = vi.fn(() => calls.push(1));
            const second = vi.fn(() => calls.push(2));
            emitter.on("connect", first);
            emitter.on("connect", second);
            emitter.emit("connect");
            expect(first).toHaveBeenCalledTimes(1);
            expect(second).toHaveBeenCalledTimes(1);
            expect(calls).toEqual([1, 2]);
        });

        it("does not invoke listeners registered for other events", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const onConnect = vi.fn();
            const onData = vi.fn();
            emitter.on("connect", onConnect);
            emitter.on("data", onData);
            emitter.emit("connect");
            expect(onConnect).toHaveBeenCalledTimes(1);
            expect(onData).not.toHaveBeenCalled();
        });

        it("returns true when the event has listeners, false otherwise", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            // No listeners yet.
            expect(emitter.emit("connect")).toBe(false);
            const onConnect = vi.fn();
            emitter.on("connect", onConnect);
            expect(emitter.emit("connect")).toBe(true);
        });
    });

    describe("off / removeListener", () => {
        it("off() removes a specific listener", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const keep = vi.fn();
            const drop = vi.fn();
            emitter.on("connect", keep);
            emitter.on("connect", drop);
            emitter.off("connect", drop);
            emitter.emit("connect");
            expect(drop).not.toHaveBeenCalled();
            expect(keep).toHaveBeenCalledTimes(1);
        });

        it("removeListener() is an alias for off()", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const keep = vi.fn();
            const drop = vi.fn();
            emitter.on("data", keep);
            emitter.on("data", drop);
            emitter.removeListener("data", drop);
            emitter.emit("data", "payload");
            expect(drop).not.toHaveBeenCalled();
            expect(keep).toHaveBeenCalledTimes(1);
            const [chunk] = keep.mock.calls[0] as [string];
            expect(chunk).toBe("payload");
        });

        it("off() for a listener that was never registered is a no-op", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const registered = vi.fn();
            const neverRegistered = vi.fn();
            emitter.on("connect", registered);
            emitter.off("connect", neverRegistered);
            emitter.emit("connect");
            expect(registered).toHaveBeenCalledTimes(1);
            expect(neverRegistered).not.toHaveBeenCalled();
        });

        it("removing a listener does not affect other events", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const onConnect = vi.fn();
            const onData = vi.fn();
            emitter.on("connect", onConnect);
            emitter.on("data", onData);
            emitter.off("connect", onConnect);
            emitter.emit("data", "still fires");
            expect(onConnect).not.toHaveBeenCalled();
            expect(onData).toHaveBeenCalledTimes(1);
        });
    });

    describe("once", () => {
        it("fires exactly once, then auto-removes the listener", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const onConnect = vi.fn();
            emitter.once("connect", onConnect);
            emitter.emit("connect");
            emitter.emit("connect");
            emitter.emit("connect");
            expect(onConnect).toHaveBeenCalledTimes(1);
        });

        it("delivers arguments on the single firing", () => {
            const emitter = createTypedEventEmitter<TestEvents>(createMockEventProvider());
            const onData = vi.fn();
            emitter.once("data", onData);
            emitter.emit("data", "one");
            emitter.emit("data", "two");
            expect(onData).toHaveBeenCalledTimes(1);
            const [chunk] = onData.mock.calls[0] as [string];
            expect(chunk).toBe("one");
        });
    });
});
