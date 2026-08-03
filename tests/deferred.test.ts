import { describe, expect, it } from "vitest";
import { createDeferred } from "../src/deferred.js";

describe("createDeferred", () => {
    it("resolve() settles the promise with the supplied value", async () => {
        const d = createDeferred<number>();
        d.resolve(42);
        expect(await d.promise).toBe(42);
    });

    it("reject() settles the promise with the supplied error", async () => {
        const d = createDeferred<string>();
        d.reject(new Error("nope"));
        await expect(d.promise).rejects.toThrow("nope");
    });

    it("delivers a value resolved before anyone awaits (thenable semantics)", async () => {
        // The executor captures resolve/reject synchronously; settling before any
        // .then is attached must still deliver the value to a later awaiter.
        const d = createDeferred<string>();
        d.resolve("late-but-settled");
        // Yield a microtask so a misbehaving deferred could have dropped it.
        await Promise.resolve();
        expect(await d.promise).toBe("late-but-settled");
    });

    it("exposes one shared shape with promise/resolve/reject on the same object", () => {
        const d = createDeferred<number>();
        expect(d).toHaveProperty("promise");
        expect(d).toHaveProperty("resolve");
        expect(d).toHaveProperty("reject");
        expect(typeof d.resolve).toBe("function");
        expect(typeof d.reject).toBe("function");
    });
});
