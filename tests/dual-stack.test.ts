import { describe, expect, it } from "vitest";
import { createServer, type Socket as NodeSocket } from "node:net";
import { connect, resolveHostCandidates, TcpTransport, DnsResolutionError } from "../src/index.js";
import type { DnsResolver, IPAddress, Net, Socket } from "@browsercore/contracts";
import type { TransportOptions } from "../src/types.js";
import { createMockEventProvider } from "./test-helpers.js";

/**
 * Dual-stack resolution + connect fallback (happy-eyeballs-style sequential).
 *
 * The historical behavior resolved a SINGLE address for ONE family chosen by
 * the `ipv6` preference — a host without an AAAA record failed outright under
 * the default IPv6 preference, and an unreachable AAAA route could never fall
 * back to IPv4. These tests pin the fallback semantics.
 */

/** DnsResolver whose answer depends on the requested family. */
function familyDns(behaviors: Partial<Record<4 | 6, IPAddress[] | Error>>): DnsResolver {
    return {
        lookup(_hostname, family) {
            const result = behaviors[family];
            if (typeof result === "string") {
                // Raw-string rejection: exercises non-Error cause wrapping.
                return Promise.reject(result);
            }
            if (result instanceof Error) {
                return Promise.reject(result);
            }
            if (!result) {
                return Promise.reject(new Error(`ENOTFOUND (no ${family === 6 ? "AAAA" : "A"} record)`));
            }
            return Promise.resolve(result);
        },
    };
}

/** Fake Net adapter recording connect attempts, with per-family outcomes. */
function fakeNet(behavior: (host: string, family: 4 | 6, index: number) => "connect" | "error" | "hang"): {
    net: Net;
    attempts: Array<{ host: string; family: 4 | 6 }>;
} {
    const attempts: Array<{ host: string; family: 4 | 6 }> = [];
    let index = 0;
    const net: Net = {
        connect(options) {
            index++;
            attempts.push({ host: options.host, family: (options.family ?? 4) as 4 | 6 });
            const outcome = behavior(options.host, (options.family ?? 4) as 4 | 6, index - 1);
            const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
            const emit = (event: string, ...args: unknown[]): void => {
                for (const l of listeners.get(event) ?? [...[]]) l(...args);
            };
            let destroyed = false;
            const socket: Socket = {
                write: () => true,
                end: () => {
                    // Graceful close: node:net emits "close" after end().
                    queueMicrotask(() => emit("close", false));
                },
                destroy: () => {
                    destroyed = true;
                    queueMicrotask(() => emit("close", true));
                },
                get destroyed() {
                    return destroyed;
                },
                once(event, listener) {
                    const wrapped = (...args: unknown[]): void => {
                        const arr = listeners.get(event);
                        if (arr) {
                            const i = arr.indexOf(wrapped);
                            if (i >= 0) arr.splice(i, 1);
                        }
                        listener(...args);
                    };
                    if (!listeners.has(event)) listeners.set(event, []);
                    listeners.get(event)!.push(wrapped);
                },
                on(event, listener) {
                    if (!listeners.has(event)) listeners.set(event, []);
                    listeners.get(event)!.push(listener);
                },
            };
            if (outcome === "connect") {
                queueMicrotask(() => emit("connect"));
            } else if (outcome === "error") {
                queueMicrotask(() => emit("error", new Error("ECONNREFUSED")));
            }
            // "hang": no event — the connect timer must fire.
            return socket;
        },
    };
    return { net, attempts };
}

describe("resolveHostCandidates", () => {
    it("returns the preferred family first and the alternate second", async () => {
        const dns = familyDns({
            6: [{ address: "2001:db8::1", family: 6 }],
            4: [{ address: "192.0.2.10", family: 4 }],
        });
        const candidates = await resolveHostCandidates("example.com", true, dns);
        expect(candidates.map((c) => c.address)).toEqual(["2001:db8::1", "192.0.2.10"]);
    });

    it("omits a family whose lookup fails instead of failing the resolution", async () => {
        // This is the httpbin.org case: no AAAA record at all must not kill
        // the connection when IPv6 is preferred.
        const dns = familyDns({
            6: new Error("ENOTFOUND"),
            4: [{ address: "192.0.2.10", family: 4 }],
        });
        const candidates = await resolveHostCandidates("httpbin.org", true, dns);
        expect(candidates).toEqual([{ address: "192.0.2.10", family: 4 }]);
    });

    it("throws DnsResolutionError only when BOTH families fail", async () => {
        const dns = familyDns({ 6: new Error("ENOTFOUND"), 4: new Error("ENOTFOUND") });
        await expect(resolveHostCandidates("nx.example", true, dns)).rejects.toThrow(DnsResolutionError);
    });

    it("deduplicates a resolver that ignores the requested family", async () => {
        const dns = familyDns({
            6: [{ address: "192.0.2.10", family: 4 }],
            4: [{ address: "192.0.2.10", family: 4 }],
        });
        const candidates = await resolveHostCandidates("example.com", true, dns);
        expect(candidates).toHaveLength(1);
    });
});

describe("connect dual-stack fallback", () => {
    it("falls back to IPv4 when the AAAA lookup fails (ENOTFOUND case)", async () => {
        // Before the fix: DEFAULT_IPV6=true made lookup(host, 6) reject and the
        // whole connect die with DnsResolutionError — no AAAA meant no request.
        const { net, attempts } = fakeNet(() => "connect");
        const dns = familyDns({
            6: new Error("ENOTFOUND"),
            4: [{ address: "127.0.0.1", family: 4 }],
        });
        const transport = await connect({
            host: "httpbin.org",
            port: 443,
            net,
            dns,
            events: createMockEventProvider(),
        });
        expect(transport.state.state).toBe("open");
        expect(attempts).toEqual([{ host: "127.0.0.1", family: 4 }]);
        await transport.close();
    });

    it("falls back to the next candidate when the first connect errors", async () => {
        // IPv6 resolves but the route refuses — must land on the IPv4 address.
        const { net, attempts } = fakeNet((_host, family) => (family === 6 ? "error" : "connect"));
        const dns = familyDns({
            6: [{ address: "2001:db8::1", family: 6 }],
            4: [{ address: "127.0.0.1", family: 4 }],
        });
        const transport = await connect({
            host: "example.com",
            port: 443,
            net,
            dns,
            events: createMockEventProvider(),
        });
        expect(transport.state.state).toBe("open");
        expect(attempts).toEqual([
            { host: "2001:db8::1", family: 6 },
            { host: "127.0.0.1", family: 4 },
        ]);
        await transport.close();
    });

    it("falls back when the first candidate black-holes (connect timeout)", async () => {
        // IPv6 resolves, SYN never answered — the non-final attempt is capped
        // well below the connect budget so the fallback stays useful in
        // real time. Local loopback server must still be reached quickly.
        const { net, attempts } = fakeNet((_host, family) => (family === 6 ? "hang" : "connect"));
        const dns = familyDns({
            6: [{ address: "2001:db8::1", family: 6 }],
            4: [{ address: "127.0.0.1", family: 4 }],
        });
        const transport = await connect({
            host: "example.com",
            port: 443,
            connectTimeoutMs: 5_000,
            net,
            dns,
            events: createMockEventProvider(),
        });
        expect(transport.state.state).toBe("open");
        expect(attempts).toEqual([
            { host: "2001:db8::1", family: 6 },
            { host: "127.0.0.1", family: 4 },
        ]);
        await transport.close();
    }, 10_000);

    it("rejects with the connect timeout when every candidate fails", async () => {
        const { net } = fakeNet(() => "error");
        const dns = familyDns({
            6: [{ address: "2001:db8::1", family: 6 }],
            4: [{ address: "192.0.2.1", family: 4 }],
        });
        await expect(
            connect({
                host: "example.com",
                port: 443,
                connectTimeoutMs: 400,
                net,
                dns,
                events: createMockEventProvider(),
            }),
        ).rejects.toThrow(/timed out|ECONNREFUSED/);
    }, 5_000);

    it("connects over a real loopback server through the fallback path", async () => {
        // End-to-end with the real node:net adapter: the (fake) AAAA record is
        // unroutable, the A record is the loopback server.
        const server = createServer((sock: NodeSocket) => sock.end());
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        try {
            const transport = await connect({
                host: "example.test",
                port,
                connectTimeoutMs: 5_000,
                net: (await import("./helpers.js")).nodeNet,
                dns: familyDns({
                    6: [{ address: "2001:db8::1", family: 6 }],
                    4: [{ address: "127.0.0.1", family: 4 }],
                }),
                events: createMockEventProvider(),
            } satisfies TransportOptions);
            expect(transport.state.state).toBe("open");
            await transport.close();
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }, 10_000);
});

describe("resolveHostCandidates edge coverage", () => {
    it("skips a family whose lookup resolves to an empty array", async () => {
        // The A-record lookup succeeds but yields no addresses — that family
        // must be absent without failing the resolution (the AAAA still hits).
        const dns = familyDns({
            6: [{ address: "2001:db8::2", family: 6 }],
            4: [],
        });
        const candidates = await resolveHostCandidates("dual.example", true, dns);
        expect(candidates).toEqual([{ address: "2001:db8::2", family: 6 }]);
    });

    it("reports 'no addresses' when both families resolve empty (not rejected)", async () => {
        const dns = familyDns({ 6: [], 4: [] });
        await expect(resolveHostCandidates("empty.example", true, dns)).rejects.toThrow(
            /no addresses|DNS/,
        );
    });

    it("normalizes a lookup that reports family 0 as 'unknown'", async () => {
        // `resolvedFamily || family`: a 0 means "unknown" and must fall back to
        // the family we asked for.
        const dns = familyDns({ 4: [{ address: "192.0.2.7", family: 0 as unknown as 4 }] });
        const candidates = await resolveHostCandidates("fz.example", true, dns);
        expect(candidates).toEqual([{ address: "192.0.2.7", family: 4 }]);
    });

    it("wraps a non-Error rejection reason in the DnsResolutionError cause", async () => {
        const dns = familyDns({ 6: "ENOTFOUND-string", 4: "ENOTFOUND-string" });
        await expect(resolveHostCandidates("boom.example", true, dns)).rejects.toThrow(
            DnsResolutionError,
        );
    });

    it("resolveHost wraps a non-Error rejection reason", async () => {
        const dns = {
            lookup: () => Promise.reject("raw string failure"),
        } as unknown as DnsResolver;
        await expect(
            import("../src/index.js").then((m) => m.resolveHost("boom.example", false, dns)),
        ).rejects.toThrow(DnsResolutionError);
    });
});

describe("connect fallback edge coverage", () => {
    it("TcpTransport.create without an events provider throws a typed error", () => {
        expect(() =>
            TcpTransport.create("transport_x" as never, {
                host: "example.com",
                port: 443,
                net: fakeNet(() => "connect").net,
                dns: familyDns({ 4: [{ address: "127.0.0.1", family: 4 }] }),
            } as never),
        ).toThrow(/requires an injected EventProvider/);
    });

    it("wraps a synchronous non-Error throw from net.connect", async () => {
        // A Net adapter whose connect() throws a raw string synchronously —
        // the attempt must reject (wrapped), not crash the caller.
        const badNet: Net = {
            connect() {
                throw "connect exploded";
            },
        };
        await expect(
            connect({
                host: "example.com",
                port: 443,
                net: badNet,
                dns: familyDns({ 4: [{ address: "127.0.0.1", family: 4 }] }),
                events: createMockEventProvider(),
            }),
        ).rejects.toThrow(/connect exploded/);
    });

    it("wraps a non-Error socket error event during a fallback attempt", async () => {
        // Socket 'error' emitted with a raw string: the attempt must fail with
        // a wrapped Error and fall back to the next candidate.
        let call = 0;
        const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
        const stringErrorSocket: Socket = {
            write: () => true,
            end: () => {},
            destroy: () => {},
            get destroyed() {
                return false;
            },
            once(event, listener) {
                if (!listeners.has(event)) listeners.set(event, []);
                listeners.get(event)!.push(listener as (...a: unknown[]) => void);
            },
            on(event, listener) {
                if (!listeners.has(event)) listeners.set(event, []);
                listeners.get(event)!.push(listener as (...a: unknown[]) => void);
            },
        };
        const net: Net = {
            connect(options) {
                call++;
                if (call === 1) {
                    // First candidate: emit a STRING error on the socket.
                    queueMicrotask(() => {
                        for (const l of listeners.get("error") ?? []) l("socket exploded");
                    });
                    return stringErrorSocket;
                }
                // Second candidate: connect normally.
                const m = new Map<string, Array<(...args: unknown[]) => void>>();
                const emit = (event: string, ...args: unknown[]): void => {
                    for (const l of m.get(event) ?? []) l(...args);
                };
                const s: Socket = {
                    write: () => true,
                    end: () => {
                        queueMicrotask(() => emit("close", false));
                    },
                    destroy: () => {
                        queueMicrotask(() => emit("close", true));
                    },
                    get destroyed() {
                        return false;
                    },
                    once(event, listener) {
                        if (!m.has(event)) m.set(event, []);
                        m.get(event)!.push(listener as (...a: unknown[]) => void);
                    },
                    on(event, listener) {
                        if (!m.has(event)) m.set(event, []);
                        m.get(event)!.push(listener as (...a: unknown[]) => void);
                    },
                };
                queueMicrotask(() => emit("connect"));
                void options;
                return s;
            },
        };
        const transport = await connect({
            host: "example.com",
            port: 443,
            net,
            dns: familyDns({
                6: [{ address: "2001:db8::9", family: 6 }],
                4: [{ address: "127.0.0.1", family: 4 }],
            }),
            events: createMockEventProvider(),
        });
        expect(transport.state.state).toBe("open");
        await transport.close();
    });
});
