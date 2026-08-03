import { describe, expect, it } from "vitest";
import { createDrainQueue } from "../src/drain.js";

/**
 * `awaitDrain()` chains through a resolved promise and only creates its waiter
 * inside a microtask, so a test must flush microtasks before asserting on (or
 * notifying) the waiter. This helper yields one macrotask to do that reliably.
 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("createDrainQueue", () => {
    it("awaits a drain that has not yet fired, then resolves on notifyDrain()", async () => {
        const q = createDrainQueue();
        let resolved = false;
        const p = q.awaitDrain().then(() => {
            resolved = true;
        });
        await flush();
        expect(resolved).toBe(false);
        q.notifyDrain();
        await p;
        expect(resolved).toBe(true);
    });

    it("notifyDrain() is a no-op when no waiter is queued", () => {
        const q = createDrainQueue();
        // Neither of these should throw or mutate any waiter.
        expect(() => q.notifyDrain()).not.toThrow();
        expect(() => q.notifyDrain()).not.toThrow();
    });

    it("resumes concurrent backpressured waiters strictly in FIFO order", async () => {
        const q = createDrainQueue();
        const order: string[] = [];
        const a = q.awaitDrain().then(() => order.push("a"));
        const b = q.awaitDrain().then(() => order.push("b"));
        const c = q.awaitDrain().then(() => order.push("c"));
        await flush();

        // Only the head waiter is released per drain — concurrent waiters must not
        // all pile onto a single notifyDrain.
        q.notifyDrain();
        await a;
        await flush();
        expect(order).toEqual(["a"]);

        q.notifyDrain();
        await b;
        await flush();
        expect(order).toEqual(["a", "b"]);

        q.notifyDrain();
        await c;
        expect(order).toEqual(["a", "b", "c"]);
    });

    it("reject(err) rejects the single pending waiter", async () => {
        const q = createDrainQueue();
        const p = q.awaitDrain();
        await flush();
        q.reject(new Error("socket gone"));
        await expect(p).rejects.toThrow("socket gone");
    });

    it("reject() is a no-op when no waiter is queued", () => {
        const q = createDrainQueue();
        expect(() => q.reject(new Error("x"))).not.toThrow();
    });

    it("keeps the chain alive after a waiter rejects so later waiters still proceed", async () => {
        // The per-waiter `.catch(() => {})` on the chain is what stops one failed
        // write from poisoning every later backpressured write. After the head
        // waiter rejects, the next notifyDrain() must still release the next one.
        const q = createDrainQueue();
        const first = q.awaitDrain();
        const second = q.awaitDrain();
        await flush();

        q.reject(new Error("first failed"));
        await expect(first).rejects.toThrow("first failed");
        await flush();

        // The chain survived: the second waiter resolves on the next drain.
        let secondResolved = false;
        second.then(() => {
            secondResolved = true;
        });
        q.notifyDrain();
        await flush();
        expect(secondResolved).toBe(true);
    });
});
