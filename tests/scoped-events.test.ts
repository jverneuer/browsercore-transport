/**
 * Regression gate for issue #55 — scoped transport events.
 *
 * TcpTransport used to forward `on()`/`emit()` to the injected EventProvider
 * unscoped, so two transports sharing one provider (the default: browsersmith's
 * process-wide `nodeEventProvider` singleton) cross-delivered
 * `data`/`close`/`error` events. These tests pin the per-instance scoping:
 * two transports + ONE shared provider must never cross-deliver, while every
 * listener method keeps its exact per-transport semantics.
 */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ConnectOptions, EventProvider, Net, Socket } from "@browsercore/contracts";
import { createScopedEventProvider } from "../src/events.js";
import { TcpTransport } from "../src/transport.js";
import type { TransportId } from "../src/types.js";
import { mockDns } from "./helpers.js";
import { createMockEventProvider } from "./test-helpers.js";

/**
 * Base provider that records which channel names it was asked to register on,
 * so tests can assert the `<namespace>:<event>` mapping onto the shared base.
 */
function createRecordingBase(): { readonly base: EventProvider; readonly channels: string[] } {
    const channels: string[] = [];
    const inner = createMockEventProvider();
    const base: EventProvider = {
        on(event, listener) {
            channels.push(event);
            inner.on(event, listener);
        },
        once(event, listener) {
            channels.push(event);
            inner.once(event, listener);
        },
        off(event, listener) {
            inner.off(event, listener);
        },
        removeListener(event, listener) {
            inner.removeListener(event, listener);
        },
        emit(event, ...args) {
            return inner.emit(event, ...args);
        },
        listenerCount(event) {
            return inner.listenerCount(event);
        },
        removeAllListeners(event) {
            inner.removeAllListeners(event);
        },
    };
    return { base, channels };
}

/**
 * In-memory socket for the scoping tests: emits `"connect"` on the next
 * microtask so `TcpTransport.create` resolves without real network I/O. Tests
 * inject `data`/`error`/`close` on exactly one socket to drive the socket
 * handlers deterministically.
 */
class FakeSocket extends EventEmitter implements Socket {
    public destroyed = false;

    public write(_data: Uint8Array, cb?: (err?: Error | null) => void): boolean {
        if (cb) {
            queueMicrotask(() => cb(null));
        }
        return true;
    }

    public end(): void {
        queueMicrotask(() => this.emit("close", false));
    }

    public destroy(): void {
        this.destroyed = true;
    }
}

/**
 * Mock Net handing out one FakeSocket per connect() and auto-connecting it.
 * Tests keep the sockets so they can inject events on exactly one of them.
 */
function createFakeNet(): { readonly net: Net; readonly sockets: FakeSocket[] } {
    const sockets: FakeSocket[] = [];
    const net: Net = {
        connect(_options: ConnectOptions): Socket {
            const socket = new FakeSocket();
            sockets.push(socket);
            queueMicrotask(() => socket.emit("connect"));
            return socket;
        },
    };
    return { net, sockets };
}

/**
 * Two transports over fake sockets sharing ONE EventProvider — and the SAME
 * correlation id, which `connect()` mints from `clock.now()` and
 * `TcpTransport.create` accepts from callers. The scoped channels must be
 * unique per INSTANCE even when the id collides.
 */
async function createSharedProviderPair(): Promise<{
    readonly transportA: TcpTransport;
    readonly transportB: TcpTransport;
    readonly socketA: FakeSocket;
    readonly socketB: FakeSocket;
}> {
    const sharedProvider = createMockEventProvider();
    const fakeA = createFakeNet();
    const fakeB = createFakeNet();
    const sharedId = "transport_shared_id" as TransportId;
    const transportA = await TcpTransport.create(sharedId, {
        host: "127.0.0.1",
        port: 1234,
        net: fakeA.net,
        dns: mockDns(),
        events: sharedProvider,
    });
    const transportB = await TcpTransport.create(sharedId, {
        host: "127.0.0.1",
        port: 1234,
        net: fakeB.net,
        dns: mockDns(),
        events: sharedProvider,
    });
    const socketA = fakeA.sockets[0];
    const socketB = fakeB.sockets[0];
    if (!socketA || !socketB) {
        throw new Error("fake net did not hand out one socket per transport");
    }
    return { transportA, transportB, socketA, socketB };
}

describe("createScopedEventProvider", () => {
    it("registers listeners under <namespace>:<event> channels on the base provider", () => {
        const { base, channels } = createRecordingBase();
        const scope = createScopedEventProvider(base, "tcp:1:t1");
        scope.on("data", () => {});
        scope.once("close", () => {});
        expect(channels).toEqual(["tcp:1:t1:data", "tcp:1:t1:close"]);
    });

    it("two scopes on one base never cross-deliver data/close/error", () => {
        const { base } = createRecordingBase();
        const scopeA = createScopedEventProvider(base, "tcp:1:tA");
        const scopeB = createScopedEventProvider(base, "tcp:2:tB");
        for (const event of ["data", "close", "error"]) {
            const onA = vi.fn();
            const onB = vi.fn();
            scopeA.on(event, onA);
            scopeB.on(event, onB);
            scopeA.emit(event, "from-a");
            expect(onA).toHaveBeenCalledTimes(1);
            expect(onA).toHaveBeenCalledWith("from-a");
            expect(onB).not.toHaveBeenCalled();
            scopeB.emit(event, "from-b");
            expect(onB).toHaveBeenCalledTimes(1);
            expect(onB).toHaveBeenCalledWith("from-b");
            expect(onA).toHaveBeenCalledTimes(1);
        }
    });

    it("off() removes only that scope's listener, even for a listener shared by both scopes", () => {
        const { base } = createRecordingBase();
        const scopeA = createScopedEventProvider(base, "tcp:1:tA");
        const scopeB = createScopedEventProvider(base, "tcp:2:tB");
        const sharedListener = vi.fn();
        scopeA.on("data", sharedListener);
        scopeB.on("data", sharedListener);
        scopeA.off("data", sharedListener);
        scopeA.emit("data", "a");
        expect(sharedListener).not.toHaveBeenCalled();
        scopeB.emit("data", "b");
        expect(sharedListener).toHaveBeenCalledTimes(1);
        expect(sharedListener).toHaveBeenCalledWith("b");
    });

    it("removeListener() is an alias for off() with per-scope semantics", () => {
        const { base } = createRecordingBase();
        const scopeA = createScopedEventProvider(base, "tcp:1:tA");
        const scopeB = createScopedEventProvider(base, "tcp:2:tB");
        const sharedListener = vi.fn();
        scopeA.on("error", sharedListener);
        scopeB.on("error", sharedListener);
        scopeA.removeListener("error", sharedListener);
        scopeA.emit("error", new Error("a"));
        expect(sharedListener).not.toHaveBeenCalled();
        scopeB.emit("error", new Error("b"));
        expect(sharedListener).toHaveBeenCalledTimes(1);
    });

    it("once() fires exactly once for its own scope and auto-removes only there", () => {
        const { base } = createRecordingBase();
        const scopeA = createScopedEventProvider(base, "tcp:1:tA");
        const scopeB = createScopedEventProvider(base, "tcp:2:tB");
        const onceA = vi.fn();
        scopeA.once("data", onceA);
        scopeA.emit("data", "one");
        scopeA.emit("data", "two");
        scopeB.emit("data", "b");
        expect(onceA).toHaveBeenCalledTimes(1);
        expect(onceA).toHaveBeenCalledWith("one");
        expect(scopeA.listenerCount("data")).toBe(0);
        expect(scopeB.listenerCount("data")).toBe(0);
    });

    it("listenerCount() counts only this scope's listeners", () => {
        const { base } = createRecordingBase();
        const scopeA = createScopedEventProvider(base, "tcp:1:tA");
        const scopeB = createScopedEventProvider(base, "tcp:2:tB");
        scopeA.on("data", () => {});
        scopeA.on("data", () => {});
        scopeB.on("data", () => {});
        expect(scopeA.listenerCount("data")).toBe(2);
        expect(scopeB.listenerCount("data")).toBe(1);
    });

    it("removeAllListeners(event) clears only that scope's channel for that event", () => {
        const { base } = createRecordingBase();
        const scopeA = createScopedEventProvider(base, "tcp:1:tA");
        const scopeB = createScopedEventProvider(base, "tcp:2:tB");
        const onDataA = vi.fn();
        const onTickA = vi.fn();
        const onDataB = vi.fn();
        scopeA.on("data", onDataA);
        scopeA.on("tick", onTickA);
        scopeB.on("data", onDataB);
        scopeA.removeAllListeners("data");
        scopeA.emit("data", "a");
        expect(onDataA).not.toHaveBeenCalled();
        scopeA.emit("tick");
        expect(onTickA).toHaveBeenCalledTimes(1);
        scopeB.emit("data", "b");
        expect(onDataB).toHaveBeenCalledTimes(1);
    });

    it("removeAllListeners() clears only this scope's channels — the base keeps everything else", () => {
        const { base } = createRecordingBase();
        const scopeA = createScopedEventProvider(base, "tcp:1:tA");
        const scopeB = createScopedEventProvider(base, "tcp:2:tB");
        const onDataA = vi.fn();
        const onTickA = vi.fn();
        const onDataB = vi.fn();
        const onTickB = vi.fn();
        const onGlobal = vi.fn();
        scopeA.on("data", onDataA);
        scopeA.on("tick", onTickA);
        scopeB.on("data", onDataB);
        scopeB.on("tick", onTickB);
        // A listener registered directly on the shared base, outside any scope.
        base.on("global", onGlobal);
        scopeA.removeAllListeners();
        scopeA.emit("data", "a");
        scopeA.emit("tick");
        expect(onDataA).not.toHaveBeenCalled();
        expect(onTickA).not.toHaveBeenCalled();
        // The peer scope and the bare base channel all survive.
        scopeB.emit("data", "b");
        scopeB.emit("tick");
        base.emit("global");
        expect(onDataB).toHaveBeenCalledTimes(1);
        expect(onTickB).toHaveBeenCalledTimes(1);
        expect(onGlobal).toHaveBeenCalledTimes(1);
    });

    it("emit() returns whether THIS scope has listeners", () => {
        const { base } = createRecordingBase();
        const scopeA = createScopedEventProvider(base, "tcp:1:tA");
        const scopeB = createScopedEventProvider(base, "tcp:2:tB");
        expect(scopeA.emit("data", "nobody-listening")).toBe(false);
        scopeA.on("data", () => {});
        expect(scopeA.emit("data", "a")).toBe(true);
        expect(scopeB.emit("data", "b")).toBe(false);
    });
});

describe("TcpTransport event scoping — two transports, one shared provider (issue #55)", () => {
    it("delivers data only to the transport whose socket produced it", async () => {
        const { transportA, transportB, socketA, socketB } = await createSharedProviderPair();
        const onDataA = vi.fn();
        const onDataB = vi.fn();
        transportA.on("data", onDataA);
        transportB.on("data", onDataB);

        const chunkA = new Uint8Array([0x01, 0x01, 0x01]);
        socketA.emit("data", chunkA);
        expect(onDataA).toHaveBeenCalledTimes(1);
        expect(onDataA.mock.calls[0]?.[0]).toBe(chunkA);
        expect(onDataB).not.toHaveBeenCalled();

        const chunkB = new Uint8Array([0x02, 0x02, 0x02]);
        socketB.emit("data", chunkB);
        expect(onDataB).toHaveBeenCalledTimes(1);
        expect(onDataB.mock.calls[0]?.[0]).toBe(chunkB);
        expect(onDataA).toHaveBeenCalledTimes(1);
    });

    it("delivers close only to the transport that closed; the peer stays open", async () => {
        const { transportA, transportB, socketA, socketB } = await createSharedProviderPair();
        const onCloseA = vi.fn();
        const onCloseB = vi.fn();
        const onStateB = vi.fn();
        transportA.on("close", onCloseA);
        transportB.on("close", onCloseB);
        transportB.on("state", onStateB);

        await transportA.close();
        expect(onCloseA).toHaveBeenCalledTimes(1);
        expect(onCloseA.mock.calls[0]?.[0]).toBe(false);
        expect(onCloseB).not.toHaveBeenCalled();
        expect(onStateB).not.toHaveBeenCalled();
        expect(transportB.state.state).toBe("open");

        // The peer still receives its own data after the other transport closed.
        const onDataB = vi.fn();
        transportB.on("data", onDataB);
        socketB.emit("data", new Uint8Array([0x07]));
        socketA.emit("data", new Uint8Array([0x08]));
        expect(onDataB).toHaveBeenCalledTimes(1);
    });

    it("delivers error only to the transport whose socket errored", async () => {
        const { transportA, transportB, socketA, socketB } = await createSharedProviderPair();
        const onErrorA = vi.fn();
        const onErrorB = vi.fn();
        transportA.on("error", onErrorA);
        transportB.on("error", onErrorB);

        const boom = new Error("socket A failed");
        socketA.emit("error", boom);
        expect(onErrorA).toHaveBeenCalledTimes(1);
        expect(onErrorA.mock.calls[0]?.[0]).toBe(boom);
        expect(onErrorB).not.toHaveBeenCalled();
        expect(transportB.state.state).toBe("open");

        // B keeps working after A's error.
        const onDataB = vi.fn();
        transportB.on("data", onDataB);
        socketB.emit("data", new Uint8Array([0x09]));
        expect(onDataB).toHaveBeenCalledTimes(1);
    });

    it("does not re-emit a socket error when only the OTHER transport has error listeners", async () => {
        const { transportB, socketA } = await createSharedProviderPair();
        const onErrorB = vi.fn();
        transportB.on("error", onErrorB);

        // A has NO error listener: the scoped listenerCount guard must not see
        // B's listener, so the socket error is not re-emitted on the transport.
        expect(() => socketA.emit("error", new Error("a-only"))).not.toThrow();
        expect(onErrorB).not.toHaveBeenCalled();
    });

    it("once() fires exactly once for its own transport only", async () => {
        const { transportA, socketA, socketB } = await createSharedProviderPair();
        const onceA = vi.fn();
        transportA.once("data", onceA);
        socketA.emit("data", new Uint8Array([0x01]));
        socketA.emit("data", new Uint8Array([0x02]));
        socketB.emit("data", new Uint8Array([0x03]));
        expect(onceA).toHaveBeenCalledTimes(1);
        expect(transportA.listenerCount("data")).toBe(0);
    });

    it("off() removes only that transport's listener", async () => {
        const { transportA, transportB, socketA, socketB } = await createSharedProviderPair();
        const sharedListener = vi.fn();
        transportA.on("data", sharedListener);
        transportB.on("data", sharedListener);

        transportA.off("data", sharedListener);
        socketA.emit("data", new Uint8Array([0x01]));
        expect(sharedListener).not.toHaveBeenCalled();
        socketB.emit("data", new Uint8Array([0x02]));
        expect(sharedListener).toHaveBeenCalledTimes(1);
    });

    it("removeListener() removes only that transport's listener", async () => {
        const { transportA, transportB, socketA, socketB } = await createSharedProviderPair();
        const sharedListener = vi.fn();
        transportA.on("error", sharedListener);
        transportB.on("error", sharedListener);

        transportA.removeListener("error", sharedListener);
        socketA.emit("error", new Error("a"));
        expect(sharedListener).not.toHaveBeenCalled();
        socketB.emit("error", new Error("b"));
        expect(sharedListener).toHaveBeenCalledTimes(1);
    });

    it("listenerCount() counts only this transport's listeners", async () => {
        const { transportA, transportB } = await createSharedProviderPair();
        transportA.on("data", () => {});
        transportA.on("data", () => {});
        transportB.on("data", () => {});
        expect(transportA.listenerCount("data")).toBe(2);
        expect(transportB.listenerCount("data")).toBe(1);
        transportA.off("data", () => {});
        expect(transportA.listenerCount("data")).toBe(2);
    });

    it("removeAllListeners(event) clears only that transport's channel for that event", async () => {
        const { transportA, transportB, socketA, socketB } = await createSharedProviderPair();
        const onDataA = vi.fn();
        const onDataB = vi.fn();
        transportA.on("data", onDataA);
        transportB.on("data", onDataB);

        transportA.removeAllListeners("data");
        socketA.emit("data", new Uint8Array([0x01]));
        expect(onDataA).not.toHaveBeenCalled();
        socketB.emit("data", new Uint8Array([0x02]));
        expect(onDataB).toHaveBeenCalledTimes(1);
    });

    it("removeAllListeners() clears only this transport's listeners; the peer keeps its own", async () => {
        const { transportA, transportB, socketA, socketB } = await createSharedProviderPair();
        const onDataA = vi.fn();
        const onTickA = vi.fn();
        const onDataB = vi.fn();
        const onTickB = vi.fn();
        transportA.on("data", onDataA);
        transportA.on("tick", onTickA);
        transportB.on("data", onDataB);
        transportB.on("tick", onTickB);

        transportA.removeAllListeners();
        socketA.emit("data", new Uint8Array([0x01]));
        transportA.emit("tick");
        expect(onDataA).not.toHaveBeenCalled();
        expect(onTickA).not.toHaveBeenCalled();
        // The peer transport is untouched.
        socketB.emit("data", new Uint8Array([0x02]));
        transportB.emit("tick");
        expect(onDataB).toHaveBeenCalledTimes(1);
        expect(onTickB).toHaveBeenCalledTimes(1);
    });

    it("emit() returns whether THIS transport has listeners", async () => {
        const { transportA, transportB } = await createSharedProviderPair();
        expect(transportA.emit("data", new Uint8Array([0x01]))).toBe(false);
        transportA.on("data", () => {});
        expect(transportA.emit("data", new Uint8Array([0x02]))).toBe(true);
        expect(transportB.emit("data", new Uint8Array([0x03]))).toBe(false);
    });
});
