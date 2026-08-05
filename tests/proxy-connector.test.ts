import { describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { connect } from "../src/connect.js";
import {
    createHttpProxy,
    directConnector,
    type ProxyConnector,
} from "../src/index.js";
import type { Transport } from "../src/types.js";

/**
 * Loopback TCP server on an ephemeral port that tracks accepted sockets so
 * teardown can destroy them first (otherwise `server.close()` hangs).
 */
class LoopbackProxy {
    public readonly server: Server;
    public readonly port: number;
    private readonly sockets = new Set<Socket>();

    private constructor(server: Server, port: number) {
        this.server = server;
        this.port = port;
        server.on("connection", (sock) => {
            sock.on("error", () => {});
            this.sockets.add(sock);
            sock.on("close", () => this.sockets.delete(sock));
        });
    }

    public static create(): Promise<LoopbackProxy> {
        return new Promise((resolve) => {
            const server = createServer();
            server.listen(0, "127.0.0.1", () => {
                const addr = server.address();
                if (!addr || typeof addr === "string") {
                    throw new Error("expected ephemeral port");
                }
                resolve(new LoopbackProxy(server, addr.port));
            });
        });
    }

    /** Resolve with the next accepted socket. */
    public acceptOne(): Promise<Socket> {
        return new Promise<Socket>((resolve) => this.server.once("connection", resolve));
    }

    public async close(): Promise<void> {
        for (const sock of this.sockets) {
            sock.destroy();
        }
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
}

/** Read bytes from a socket until the HTTP header terminator, then return them. */
function readUntilTerminator(sock: Socket, timeoutMs = 5_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out reading CONNECT request")), timeoutMs);
        let buffer = "";
        const onData = (chunk: Buffer): void => {
            buffer += chunk.toString("utf-8");
            if (buffer.includes("\r\n\r\n")) {
                clearTimeout(timer);
                sock.removeListener("data", onData);
                resolve(buffer);
            }
        };
        sock.on("data", onData);
    });
}

/**
 * Read everything a socket delivers until `quietMs` pass with no new data,
 * then return the concatenated string. Tunnel payloads (e.g. a TLS
 * ClientHello) carry no HTTP terminator, so a terminator-based read would wait
 * forever — a quiet-timeout collects exactly what arrived.
 */
function readUntilQuiet(sock: Socket, quietMs = 200, timeoutMs = 5_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("timed out reading tunnel bytes")), timeoutMs);
        let buffer = "";
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        const onData = (chunk: Buffer): void => {
            buffer += chunk.toString("utf-8");
            if (quietTimer) {
                clearTimeout(quietTimer);
            }
            quietTimer = setTimeout(() => {
                clearTimeout(deadline);
                sock.removeListener("data", onData);
                resolve(buffer);
            }, quietMs);
        };
        sock.on("data", onData);
    });
}

describe("directConnector", () => {
    it("opens a transport straight to the target, proxy-unaware", async () => {
        const loop = await LoopbackProxy.create();
        try {
            const serverSock = loop.acceptOne();
            const transport = await directConnector.connect("127.0.0.1", loop.port);
            expect(transport.state.state).toBe("open");

            // The server side should see the connection — nothing is tunneled.
            const sock = await serverSock;
            expect(sock.destroyed).toBe(false);

            await transport.close();
        } finally {
            await loop.close();
        }
    });
});

describe("createHttpProxy", () => {
    it("tunnels a target through an HTTP CONNECT proxy responding 200", async () => {
        const proxy = await LoopbackProxy.create();
        try {
            const serverSock = proxy.acceptOne();
            const connector = await createHttpProxy({ host: "127.0.0.1", port: proxy.port });

            const tunnelPromise = connector.connect("example.com", 443);

            // The proxy receives the CONNECT request.
            const sock = await serverSock;
            const request = await readUntilTerminator(sock);
            expect(request).toContain("CONNECT example.com:443 HTTP/1.0\r\n");
            expect(request.endsWith("\r\n\r\n")).toBe(true);

            // Proxy replies with a 200 — the tunnel is now live.
            sock.write("HTTP/1.0 200 Connection Established\r\n\r\n");

            const transport = await tunnelPromise;
            expect(transport.state.state).toBe("open");

            // The tunneled transport speaks plaintext to the target as if direct.
            // Whatever the client writes through the tunnel appears on the proxy's
            // accepted socket, undecorated — no framing, no terminator.
            await transport.write(new TextEncoder().encode("hello"));
            const echo = await readUntilQuiet(sock);
            expect(echo).toBe("hello");

            await transport.close();
        } finally {
            await proxy.close();
        }
    });

    it("sends a Proxy-Authorization: Basic header when auth is configured", async () => {
        const proxy = await LoopbackProxy.create();
        try {
            const serverSock = proxy.acceptOne();
            const connector = await createHttpProxy({
                host: "127.0.0.1",
                port: proxy.port,
                auth: { username: "aladdin", password: "opensesame" },
            });

            const tunnelPromise = connector.connect("example.com", 443);

            const sock = await serverSock;
            const request = await readUntilTerminator(sock);
            const expectedCredentials = Buffer.from("aladdin:opensesame").toString("base64");
            expect(request).toContain(`Proxy-Authorization: Basic ${expectedCredentials}\r\n`);

            sock.write("HTTP/1.0 200 Connection Established\r\n\r\n");
            const transport = await tunnelPromise;
            expect(transport.state.state).toBe("open");

            await transport.close();
        } finally {
            await proxy.close();
        }
    });

    it("rejects when the proxy answers with a non-2xx status", async () => {
        const proxy = await LoopbackProxy.create();
        try {
            const serverSock = proxy.acceptOne();
            const connector = await createHttpProxy({ host: "127.0.0.1", port: proxy.port });

            const tunnelPromise = connector.connect("example.com", 443);

            const sock = await serverSock;
            await readUntilTerminator(sock);
            sock.write("HTTP/1.0 403 Forbidden\r\n\r\n");

            await expect(tunnelPromise).rejects.toThrow(/Proxy CONNECT failed with status 403/);
        } finally {
            await proxy.close();
        }
    });

    it("rejects on a malformed proxy response", async () => {
        const proxy = await LoopbackProxy.create();
        try {
            const serverSock = proxy.acceptOne();
            const connector = await createHttpProxy({ host: "127.0.0.1", port: proxy.port });

            const tunnelPromise = connector.connect("example.com", 443);

            const sock = await serverSock;
            await readUntilTerminator(sock);
            sock.write("not http at all\r\n\r\n");

            await expect(tunnelPromise).rejects.toThrow(/Malformed proxy CONNECT response/);
        } finally {
            await proxy.close();
        }
    });
});

describe("ProxyConnector contract", () => {
    it("direct and http proxy connectors share the same shape", async () => {
        const proxy = await LoopbackProxy.create();
        try {
            // Both are `ProxyConnector` — interchangeable to the TLS layer.
            const connectors: ProxyConnector[] = [
                directConnector,
                await createHttpProxy({ host: "127.0.0.1", port: proxy.port }),
            ];
            for (const connector of connectors) {
                expect(typeof connector.connect).toBe("function");
            }
        } finally {
            await proxy.close();
        }
    });
});
