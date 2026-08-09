import { describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { connect } from "../src/connect.js";
import { TcpTransport } from "../src/transport.js";
import type { TransportId } from "../src/types.js";
import { nodeNet, nodeDns, mockDns } from "./helpers.js";
import { createMockEventProvider } from "./test-helpers.js";

/**
 * Minimal loopback TCP server on an ephemeral port. Accepted sockets get a
 * no-op "error" listener so a client-side RST does not crash the test process.
 */
class Loopback {
    public readonly port: number;
    private readonly server: ReturnType<typeof createServer>;
    private readonly sockets = new Set<Socket>();

    private constructor(server: ReturnType<typeof createServer>, port: number) {
        this.server = server;
        this.port = port;
        server.on("connection", (sock) => {
            sock.on("error", () => {});
            this.sockets.add(sock);
            sock.on("close", () => this.sockets.delete(sock));
        });
    }

    public static create(): Promise<Loopback> {
        return new Promise((resolve) => {
            const server = createServer();
            server.listen(0, "127.0.0.1", () => {
                const addr = server.address();
                if (!addr || typeof addr === "string") {
                    throw new Error("expected ephemeral port");
                }
                resolve(new Loopback(server, addr.port));
            });
        });
    }

    public async close(): Promise<void> {
        for (const sock of this.sockets) {
            sock.destroy();
        }
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
}

describe("connect", () => {
    it("returns a TcpTransport in the 'open' state once connected", async () => {
        const loop = await Loopback.create();
        try {
            const transport = await connect({
                host: "127.0.0.1",
                port: loop.port,
                net: nodeNet,
                dns: nodeDns,
                events: createMockEventProvider(),
            });
            expect(transport).toBeInstanceOf(TcpTransport);
            expect(transport.state.state).toBe("open");
            await transport.close();
        } finally {
            await loop.close();
        }
    });

    it("mints a TransportId with the `transport_` prefix and base-36 timestamp", async () => {
        // connect() builds the id as `transport_${Date.now().toString(36)}` —
        // verify the shape of the correlation handle rather than its uniqueness.
        const loop = await Loopback.create();
        try {
            const transport = await connect({
                host: "127.0.0.1",
                port: loop.port,
                net: nodeNet,
                dns: nodeDns,
                events: createMockEventProvider(),
            });
            const id = transport.id as TransportId;
            expect(typeof id).toBe("string");
            expect(id.startsWith("transport_")).toBe(true);
            // Everything after the prefix is a base-36 timestamp (digits + lowercase).
            const ts = id.slice("transport_".length);
            expect(ts).toMatch(/^[0-9a-z]+$/);
            expect(ts.length).toBeGreaterThan(0);
            await transport.close();
        } finally {
            await loop.close();
        }
    });

    it("uses a custom DnsResolver for resolution", async () => {
        // connect() forwards options.dns into resolveHost. Supplying a
        // mock resolver that returns a fixed loopback address proves the injection
        // without depending on the platform resolver.
        const loop = await Loopback.create();
        try {
            const transport = await connect({
                host: "placeholder.test",
                port: loop.port,
                net: nodeNet,
                dns: mockDns("127.0.0.1", 4),
                events: createMockEventProvider(),
            });
            expect(transport.state.state).toBe("open");
            await transport.close();
        } finally {
            await loop.close();
        }
    });

    it("uses the real dns.lookup by default when no custom resolver is supplied", async () => {
        // Default path: connect() resolves "localhost" via the platform resolver.
        // Exercises the real DNS path with the Node adapter.
        // ipv6:false so resolution targets IPv4 — the loopback server listens on
        // 127.0.0.1 only; without this, connect() defaults to ipv6:true and
        // resolves localhost to ::1, which the IPv4 server does not serve.
        const loop = await Loopback.create();
        try {
            const transport = await connect({
                host: "localhost",
                port: loop.port,
                ipv6: false,
                net: nodeNet,
                dns: nodeDns,
                events: createMockEventProvider(),
            });
            expect(transport.state.state).toBe("open");
            await transport.close();
        } finally {
            await loop.close();
        }
    });

    it("honors connectTimeoutMs by rejecting when the host is unreachable", async () => {
        // connectTimeoutMs flows into the connect timer inside TcpTransport._establish.
        // A non-routable TEST-NET-1 address with a short timeout surfaces the
        // timeout before any platform unreachable signal.
        await expect(
            connect({
                host: "192.0.2.1",
                port: 443,
                connectTimeoutMs: 50,
                net: nodeNet,
                dns: mockDns("192.0.2.1", 4),
                events: createMockEventProvider(),
            }),
        ).rejects.toThrow(/timed out after 50ms/);
    });
});

describe("TcpTransport.create", () => {
    it("is the factory connect() delegates to — resolves with an open transport", async () => {
        const loop = await Loopback.create();
        try {
            const id = "transport_manual" as TransportId;
            const transport = await TcpTransport.create(id, {
                host: "127.0.0.1",
                port: loop.port,
                net: nodeNet,
                dns: nodeDns,
                events: createMockEventProvider(),
            });
            expect(transport).toBeInstanceOf(TcpTransport);
            expect(transport.id).toBe(id);
            expect(transport.state.state).toBe("open");
            await transport.close();
        } finally {
            await loop.close();
        }
    });
});
