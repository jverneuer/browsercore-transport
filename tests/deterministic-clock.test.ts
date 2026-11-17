import { describe, expect, it } from "vitest";
import {
    connect,
    ConnectTimeoutError,
    IdleTimeoutError,
    ReadTimeoutError,
    systemClock,
    type Clock,
    type TimerHandle,
} from "../src/index.js";
import { createTransportTimers } from "../src/timers.js";
import { createId } from "../src/utils.js";
import type { DnsResolver, IPAddress, Net, Socket } from "@browsercore/contracts";
import { createMockEventProvider } from "./test-helpers.js";

/**
 * Deterministic-clock tests — the injected-Clock seam.
 *
 * Every lifecycle timeout in this package (connect, idle eviction, per-read)
 * runs on the canonical `Clock` from @browsercore/contracts (0.2.6). These
 * tests inject a ManualClock — virtual time, zero real timers — and assert
 * timeouts fire at EXACT virtual instants: not one virtual ms early, not one
 * late. If any code path regressed to a bare `setTimeout`, the
 * advance(N-1)-still-pending assertions would fail (a real timer cannot be
 * held at N-1) or the promise would settle on wall time, not virtual time.
 */

/** A scheduled virtual timer. The object itself is the opaque TimerHandle. */
interface VirtualTimer {
    readonly dueMs: number;
    readonly sequence: number;
    fire(): void;
}

/**
 * Manual-advance {@link Clock}: `advance()` moves monotonic (and wall) time
 * and synchronously fires every timer whose deadline has passed, in due order.
 * `advanceWall()` moves ONLY wall time — NTP-step simulation proving deadline
 * math reads `monotonic()`, never `now()` deltas.
 */
class ManualClock implements Clock {
    private wallMs: number;
    private monoMs = 0;
    private nextSequence = 0;
    private readonly pendingTimers = new Set<VirtualTimer>();
    /** Milliseconds of every `setTimeout` call, in order — for budget assertions. */
    public readonly arms: number[] = [];

    constructor(wallMs = 1_700_000_000_000) {
        this.wallMs = wallMs;
    }

    public now(): number {
        return this.wallMs;
    }

    public monotonic(): number {
        return this.monoMs;
    }

    public sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            this.setTimeout(ms, resolve);
        });
    }

    public setTimeout(ms: number, fn: () => void): TimerHandle {
        const timer: VirtualTimer = {
            dueMs: this.monoMs + ms,
            sequence: this.nextSequence++,
            fire: fn,
        };
        this.pendingTimers.add(timer);
        this.arms.push(ms);
        return timer;
    }

    public clearTimeout(handle: TimerHandle): void {
        this.pendingTimers.delete(handle as VirtualTimer);
    }

    /** Advance monotonic + wall time, firing due timers in due-then-FIFO order. */
    public advance(deltaMs: number): void {
        const targetMs = this.monoMs + deltaMs;
        for (;;) {
            let next: VirtualTimer | undefined;
            for (const timer of this.pendingTimers) {
                if (timer.dueMs > targetMs) {
                    continue;
                }
                if (
                    next === undefined ||
                    timer.dueMs < next.dueMs ||
                    (timer.dueMs === next.dueMs && timer.sequence < next.sequence)
                ) {
                    next = timer;
                }
            }
            if (next === undefined) {
                break;
            }
            this.pendingTimers.delete(next);
            // A callback firing at its due instant must observe the clock AT
            // that instant (deadline math re-reads monotonic() in callbacks).
            this.monoMs = Math.max(this.monoMs, next.dueMs);
            next.fire();
        }
        this.monoMs = targetMs;
        this.wallMs += deltaMs;
    }

    /** Jump ONLY the wall clock (NTP step) — monotonic must not move. */
    public advanceWall(deltaMs: number): void {
        this.wallMs += deltaMs;
    }

    public get pendingCount(): number {
        return this.pendingTimers.size;
    }

    /** The currently armed handles (opacity assertions). */
    public armedHandles(): TimerHandle[] {
        return [...this.pendingTimers];
    }
}

/** Drain the microtask queue (DNS promises, queueMicrotask socket events). */
async function drain(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Outcome box for a promise under virtual time — inspect without awaiting. */
interface Attempt {
    error: Error | undefined;
    done: boolean;
}

function track(promise: Promise<unknown>): Attempt {
    const attempt: Attempt = { error: undefined, done: false };
    promise.then(
        () => {
            attempt.done = true;
        },
        (err: unknown) => {
            attempt.done = true;
            attempt.error = err instanceof Error ? err : new Error(String(err));
        },
    );
    return attempt;
}

/** Fake socket whose events are driven entirely by the test. */
class FakeSocket {
    public readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    public readonly socket: Socket;
    private destroyedFlag = false;

    constructor() {
        const self = this;
        this.socket = {
            write: () => true,
            end: () => {
                queueMicrotask(() => self.emit("close", false));
            },
            destroy: () => {
                self.destroyedFlag = true;
                queueMicrotask(() => self.emit("close", true));
            },
            get destroyed() {
                return self.destroyedFlag;
            },
            once: (event, listener) => {
                // The canonical Socket declares on/once as literal-event
                // overloads, so `listener` arrives as a union of narrow
                // signatures; the store below takes the widest callable shape.
                // Safe because emission is test-driven and only ever passes
                // the payload the matching overload declares.
                self.addListener(event, listener as (...args: unknown[]) => void, true);
            },
            on: (event, listener) => {
                self.addListener(event, listener as (...args: unknown[]) => void, false);
            },
        };
    }

    private addListener(event: string, listener: (...args: unknown[]) => void, once: boolean): void {
        const wrapped = (...args: unknown[]) => {
            if (once) {
                const arr = this.listeners.get(event);
                if (arr) {
                    const i = arr.indexOf(wrapped);
                    if (i >= 0) arr.splice(i, 1);
                }
            }
            listener(...args);
        };
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event)!.push(wrapped);
    }

    public emit(event: string, ...args: unknown[]): void {
        for (const listener of [...(this.listeners.get(event) ?? [])]) {
            listener(...args);
        }
    }
}

/** Net adapter recording every attempt's socket; outcomes are test-driven. */
function fakeNet(): { net: Net; sockets: FakeSocket[] } {
    const sockets: FakeSocket[] = [];
    const net: Net = {
        connect: () => {
            const fake = new FakeSocket();
            sockets.push(fake);
            return fake.socket;
        },
    };
    return { net, sockets };
}

/** Resolver answering per-family fixed addresses (dual-stack determinism). */
function fixedDns(byFamily: Partial<Record<4 | 6, IPAddress[]>>): DnsResolver {
    return {
        lookup: (_hostname, family) => {
            const answer = byFamily[family];
            return answer
                ? Promise.resolve(answer)
                : Promise.reject(new Error(`ENOTFOUND (${family})`));
        },
    };
}

const SINGLE = fixedDns({ 4: [{ address: "198.51.100.1", family: 4 }] });
const DUAL = fixedDns({
    6: [{ address: "2001:db8::1", family: 6 }],
    4: [{ address: "127.0.0.1", family: 4 }],
});

describe("systemClock (default Clock)", () => {
    it("delegates now() to the platform wall clock", () => {
        // Loose bounds: this pins the delegation, not clock precision.
        const before = Date.now();
        const read = systemClock.now();
        const after = Date.now();
        expect(read).toBeGreaterThanOrEqual(before);
        expect(read).toBeLessThanOrEqual(after);
    });

    it("monotonic() never goes backwards", () => {
        const a = systemClock.monotonic();
        const b = systemClock.monotonic();
        expect(b).toBeGreaterThanOrEqual(a);
    });

    it("sleep resolves via the platform timer", async () => {
        await systemClock.sleep(0);
    });
});

describe("createTransportTimers on an injected Clock", () => {
    it("fires the idle timer at exactly idleTimeoutMs of virtual time", () => {
        const clock = new ManualClock();
        const fired: IdleTimeoutError[] = [];
        const timers = createTransportTimers({
            idleTimeoutMs: 100,
            readTimeoutMs: undefined,
            clock,
            onIdleTimeout: (err) => fired.push(err),
            onReadTimeout: () => {},
        });
        timers.resetIdle();
        clock.advance(99);
        expect(fired).toHaveLength(0);
        clock.advance(1);
        expect(fired).toHaveLength(1);
        expect(fired[0]).toBeInstanceOf(IdleTimeoutError);
        expect(fired[0]!.idleMs).toBe(100);
        expect(clock.pendingCount).toBe(0);
    });

    it("fires the read timer at exactly readTimeoutMs and resetRead re-arms it", () => {
        const clock = new ManualClock();
        const fired: ReadTimeoutError[] = [];
        const timers = createTransportTimers({
            idleTimeoutMs: undefined,
            readTimeoutMs: 50,
            clock,
            onIdleTimeout: () => {},
            onReadTimeout: (err) => fired.push(err),
        });
        timers.resetRead();
        clock.advance(30);
        timers.resetRead(); // restart — the first arming must be cancelled
        clock.advance(49);
        expect(fired).toHaveLength(0);
        clock.advance(1);
        expect(fired).toHaveLength(1);
        expect(fired[0]).toBeInstanceOf(ReadTimeoutError);
        expect(fired[0]!.timeoutMs).toBe(50);
    });

    it("clearIdle/clearRead cancel armed virtual timers", () => {
        const clock = new ManualClock();
        const timers = createTransportTimers({
            idleTimeoutMs: 100,
            readTimeoutMs: 50,
            clock,
            onIdleTimeout: () => {},
            onReadTimeout: () => {},
        });
        timers.resetIdle();
        timers.resetRead();
        timers.clearIdle();
        timers.clearRead();
        clock.advance(1_000_000);
        expect(clock.pendingCount).toBe(0);
    });

    it("hands back opaque TimerHandles — no NodeJS.Timeout surface", () => {
        // The runtime-coupling audit's finding: NodeJS.Timeout leaked through
        // this factory into published .d.ts. The Clock contract's handle is an
        // opaque object; nothing Node-specific may be observable on it.
        const clock = new ManualClock();
        const timers = createTransportTimers({
            idleTimeoutMs: 10,
            readTimeoutMs: undefined,
            clock,
            onIdleTimeout: () => {},
            onReadTimeout: () => {},
        });
        timers.resetIdle();
        const handle = clock.armedHandles()[0]!;
        expect(typeof handle).toBe("object");
        expect(handle).not.toHaveProperty("_idleTimeout"); // NodeJS.Timeout internals
        expect(handle).not.toHaveProperty("refresh"); // NodeJS.Timeout methods
        timers.clearIdle();
    });
});

describe("connect-timeout on an injected Clock", () => {
    it("fires at exactly connectTimeoutMs — no real timers involved", async () => {
        const clock = new ManualClock();
        const { net } = fakeNet();
        const attempt = track(
            connect({
                host: "hang.example",
                port: 443,
                connectTimeoutMs: 5_000,
                net,
                dns: SINGLE,
                events: createMockEventProvider(),
                clock,
            }),
        );

        await drain();
        expect(attempt.done).toBe(false);
        expect(clock.arms).toEqual([5_000]); // full budget on the single (last) candidate

        clock.advance(4_999);
        await drain();
        expect(attempt.done).toBe(false); // held at N-1 — impossible under a real timer

        clock.advance(1);
        await drain();
        expect(attempt.done).toBe(true);
        expect(attempt.error).toBeInstanceOf(ConnectTimeoutError);
        expect(attempt.error?.message).toMatch(/timed out after 5000ms/);
        expect(clock.pendingCount).toBe(0);
    });

    it("is immune to wall-clock jumps — deadline math reads monotonic() only", async () => {
        const clock = new ManualClock();
        const { net } = fakeNet();
        const attempt = track(
            connect({
                host: "hang.example",
                port: 443,
                connectTimeoutMs: 1_000,
                net,
                dns: SINGLE,
                events: createMockEventProvider(),
                clock,
            }),
        );

        await drain();
        // A 60-second NTP step mid-connect must neither fire the timeout
        // early nor stretch the budget: now() is never used for deadlines.
        clock.advanceWall(60_000);
        clock.advance(999);
        await drain();
        expect(attempt.done).toBe(false);

        clock.advance(1);
        await drain();
        expect(attempt.done).toBe(true);
        expect(attempt.error).toBeInstanceOf(ConnectTimeoutError);
    });

    it("caps the non-final fallback attempt at 300ms of virtual time, then connects", async () => {
        const clock = new ManualClock();
        const { net, sockets } = fakeNet();
        const connectPromise = connect({
            host: "blackhole.example",
            port: 443,
            connectTimeoutMs: 5_000,
            net,
            dns: DUAL,
            events: createMockEventProvider(),
            clock,
        });
        const attempt = track(connectPromise);

        await drain();
        // First candidate (AAAA) black-holes: capped well under the budget.
        expect(clock.arms).toEqual([300]);
        clock.advance(299);
        await drain();
        expect(attempt.done).toBe(false);

        clock.advance(1); // fallback budget elapses -> next candidate
        await drain();
        expect(sockets).toHaveLength(2);
        // Final candidate gets the REST of the budget (5_000 - 300), exactly.
        expect(clock.arms).toEqual([300, 4_700]);

        sockets[1]!.emit("connect");
        const transport = await connectPromise;
        expect(attempt.error).toBeUndefined();
        expect(transport.state.state).toBe("open");
        expect(clock.pendingCount).toBe(0); // connect timer cleared on success
        await transport.close();
    });
});

describe("idle eviction on an injected Clock", () => {
    it("closes with a timeout reason at exactly idleTimeoutMs after the last data", async () => {
        const clock = new ManualClock();
        const { net, sockets } = fakeNet();
        const connectPromise = connect({
            host: "idle.example",
            port: 443,
            idleTimeoutMs: 500,
            net,
            dns: SINGLE,
            events: createMockEventProvider(),
            clock,
        });
        await drain();
        sockets[0]!.emit("connect");
        const transport = await connectPromise;
        expect(transport.state.state).toBe("open");

        const errors: unknown[] = [];
        transport.on("error", (err) => errors.push(err));

        // Data flows at 499 — the idle deadline must restart from THERE.
        clock.advance(499);
        sockets[0]!.emit("data", new Uint8Array([1]));
        clock.advance(499);
        expect(transport.state.state).toBe("open"); // 499ms since last data
        expect(errors).toHaveLength(0);

        clock.advance(1); // exactly idleTimeoutMs since the last data
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(IdleTimeoutError);
        // The idle handler closes with a timeout reason; the fake socket's
        // end() emits "close" on a microtask, which completes the transition.
        await drain();
        expect(transport.state.state).toBe("closed");
        const finalState = transport.state;
        if (finalState.state === "closed") {
            expect(finalState.reason).toEqual({ kind: "timeout", afterMs: 500 });
        }
        expect(clock.pendingCount).toBe(0); // clearAll on socket close
    });
});

describe("read timeout on an injected Clock", () => {
    it("rejects a pending read at exactly readTimeoutMs", async () => {
        const clock = new ManualClock();
        const { net, sockets } = fakeNet();
        const connectPromise = connect({
            host: "read.example",
            port: 443,
            readTimeoutMs: 300,
            net,
            dns: SINGLE,
            events: createMockEventProvider(),
            clock,
        });
        await drain();
        sockets[0]!.emit("connect");
        const transport = await connectPromise;

        const attempt = track(transport.read());
        expect(clock.arms).toContain(300); // read timer armed on issue

        clock.advance(299);
        await drain();
        expect(attempt.done).toBe(false);

        clock.advance(1);
        await drain(); // rejection propagates on a microtask
        expect(attempt.done).toBe(true);
        expect(attempt.error).toBeInstanceOf(ReadTimeoutError);
        expect(attempt.error?.message).toMatch(/within 300ms/);
        expect(clock.pendingCount).toBe(0);
        await transport.close();
    });

    it("clears the read deadline when data arrives in time", async () => {
        const clock = new ManualClock();
        const { net, sockets } = fakeNet();
        const connectPromise = connect({
            host: "read2.example",
            port: 443,
            readTimeoutMs: 300,
            net,
            dns: SINGLE,
            events: createMockEventProvider(),
            clock,
        });
        await drain();
        sockets[0]!.emit("connect");
        const transport = await connectPromise;

        const readPromise = transport.read();
        const chunk = new Uint8Array([9, 9, 9]);
        clock.advance(150);
        sockets[0]!.emit("data", chunk); // within the deadline

        const received = await readPromise;
        expect(received).toBe(chunk);
        clock.advance(5_000); // nothing may fire after the read resolved
        expect(clock.pendingCount).toBe(0);
        await transport.close();
    });
});

describe("id generation on an injected Clock", () => {
    it("createId mints the timestamp from clock.now()", () => {
        const clock = new ManualClock(1_234_567_890);
        const id = createId("transport", clock);
        expect(id.startsWith(`transport_${(1_234_567_890).toString(36)}_`)).toBe(true);
    });

    it("connect() mints the TransportId from the injected clock", async () => {
        const wallMs = 1_700_000_000_123;
        const clock = new ManualClock(wallMs);
        const { net, sockets } = fakeNet();
        const connectPromise = connect({
            host: "id.example",
            port: 443,
            net,
            dns: SINGLE,
            events: createMockEventProvider(),
            clock,
        });
        await drain();
        sockets[0]!.emit("connect");
        const transport = await connectPromise;
        expect(transport.id).toBe(`transport_${wallMs.toString(36)}`);
        await transport.close();
    });
});

describe("Clock.sleep (contract surface)", () => {
    it("resolves on virtual time via the injected clock", async () => {
        const clock = new ManualClock();
        let resolved = false;
        const sleepPromise = clock.sleep(250).then(() => {
            resolved = true;
        });
        clock.advance(249);
        await drain();
        expect(resolved).toBe(false);
        clock.advance(1);
        await sleepPromise;
        expect(resolved).toBe(true);
    });
});
