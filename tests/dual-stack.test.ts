import { describe, expect, it } from "vitest";
import { createServer, type Socket as NodeSocket } from "node:net";
import { connect, resolveHostCandidates, DnsResolutionError } from "../src/index.js";
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
