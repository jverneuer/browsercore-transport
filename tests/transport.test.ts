import { describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { connect } from "../src/index.js";
import {
    ConnectTimeoutError,
    IdleTimeoutError,
    ReadTimeoutError,
    TransportError,
} from "../src/errors.js";
import type { Transport, TransportState } from "../src/types.js";

/**
 * A loopback TCP server on an ephemeral port that tracks every accepted socket
 * so {@link LoopbackServer.close} can tear them all down first. Node's
 * `net.Server.close()` refuses to invoke its callback while a connection is
 * still open — destroying sockets up front prevents cleanup from hanging.
 */
class LoopbackServer {
    public readonly server: Server;
    public readonly port: number;
    private readonly sockets = new Set<Socket>();

    private constructor(server: Server, port: number) {
        this.server = server;
        this.port = port;
        server.on("connection", (sock) => {
            this.sockets.add(sock);
            sock.on("close", () => this.sockets.delete(sock));
        });
    }

    public static create(): Promise<LoopbackServer> {
        return new Promise((resolve) => {
            const server = createServer();
            server.listen(0, "127.0.0.1", () => {
                const addr = server.address();
                if (!addr || typeof addr === "string") {
                    throw new Error("expected ephemeral port");
                }
                resolve(new LoopbackServer(server, addr.port));
            });
        });
    }

    /** Resolve with the next accepted socket. */
    public acceptOne(): Promise<Socket> {
        return new Promise<Socket>((resolve) => this.server.once("connection", resolve));
    }

    /** Destroy every open socket, then close the server. */
    public async close(): Promise<void> {
        for (const sock of this.sockets) {
            sock.destroy();
        }
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
}

/**
 * Read exactly `total` bytes from a transport, accumulating across however many
 * chunks TCP delivers them in. Resolves once the full count is reached, or rejects
 * if the transport closes / times out first.
 */
function readBytes(transport: Transport, total: number, timeoutMs = 5_000): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`timed out waiting for ${total} bytes`));
        }, timeoutMs);
        const chunks: Uint8Array[] = [];
        let received = 0;
        const loop = (): void => {
            transport
                .read()
                .then((chunk) => {
                    chunks.push(chunk);
                    received += chunk.length;
                    if (received >= total) {
                        clearTimeout(timer);
                        resolve(new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(c)))));
                        return;
                    }
                    loop();
                })
                .catch((err: Error) => {
                    clearTimeout(timer);
                    reject(err);
                });
        };
        loop();
    });
}

/** Drain everything the server socket has buffered into one Uint8Array. */
function readAll(sock: Socket, total: number, timeoutMs = 5_000): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`timed out waiting for ${total} bytes`));
        }, timeoutMs);
        const chunks: Buffer[] = [];
        let received = 0;
        const onData = (chunk: Buffer): void => {
            chunks.push(chunk);
            received += chunk.length;
            if (received >= total) {
                clearTimeout(timer);
                sock.removeListener("data", onData);
                resolve(new Uint8Array(Buffer.concat(chunks)));
            }
        };
        sock.on("data", onData);
    });
}

describe("Step 3 — read path + byte ordering", () => {
    it("preserves byte order across multiple small writes from the server", async () => {
        const loopback = await LoopbackServer.create();
        try {
            const serverSock = loopback.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loopback.port });

            const sock = await serverSock;
            // Three distinct payloads, written in a specific order. TCP is a byte
            // stream and may coalesce these into fewer segments, so the client must
            // read until the full expected byte sequence arrives — not assume a
            // fixed number of read() calls map 1:1 to writes.
            const a = Uint8Array.from([0x01, 0x02, 0x03]);
            const b = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]);
            const c = Uint8Array.from([0x7f]);
            sock.write(Buffer.from(a));
            sock.write(Buffer.from(b));
            sock.write(Buffer.from(c));

            const expected = Uint8Array.from([...a, ...b, ...c]);
            const received = await readBytes(transport, expected.length);

            expect([...received]).toEqual([...expected]);

            await transport.close();
        } finally {
            await loopback.close();
        }
    });
});

describe("Step 4 — write path + backpressure", () => {
    it("does not resolve a large write until the server reads (drain)", async () => {
        const loopback = await LoopbackServer.create();
        try {
            const serverSock = loopback.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loopback.port });

            const sock = await serverSock;
            // Do NOT read yet — once the kernel buffer is full, the socket reports
            // backpressure and the write must wait for "drain".
            sock.pause();

            // Loopback kernel buffers are large (often ~1MB+); a single write at
            // >=8 MB reliably exceeds the kernel send buffer while the server is
            // paused, so the promise stays pending until the server drains it.
            const payload = new Uint8Array(8 * 1024 * 1024).fill(0xcd);
            let resolved = false;
            const writePromise = transport.write(payload).then(() => {
                resolved = true;
            });

            // Backpressure means the promise must stay pending: the kernel buffer
            // is full and the server has not read anything yet.
            await new Promise((r) => setTimeout(r, 200));
            expect(resolved).toBe(false);

            // Drain the socket server-side; this triggers "drain" on the client.
            sock.resume();
            await readAll(sock, payload.length);
            await writePromise; // resolves once drain fires
            expect(resolved).toBe(true);

            await transport.close();
        } finally {
            await loopback.close();
        }
    });
});

describe("Step 5 — timeouts + error mapping", () => {
    it("fires the idle timeout when no data flows", async () => {
        const loopback = await LoopbackServer.create();
        try {
            const serverSock = loopback.acceptOne(); // register; resolve after connect
            const transport = await connect({
                host: "127.0.0.1",
                port: loopback.port,
                idleTimeoutMs: 80,
            });
            await serverSock;

            const err = await new Promise<IdleTimeoutError>((resolve) => {
                transport.once("error", (e) => resolve(e as IdleTimeoutError));
            });
            expect(err).toBeInstanceOf(IdleTimeoutError);
            expect(err.idleMs).toBe(80);

            // State should transition to closed with a timeout reason.
            await new Promise((r) => setTimeout(r, 50));
            expect(transport.state.state).toBe("closed");
            expect(transport.state.state === "closed" && transport.state.reason.kind).toBe(
                "timeout",
            );

            await transport.close();
        } finally {
            await loopback.close();
        }
    });

    it("fires the per-read timeout when no data arrives for a read()", async () => {
        const loopback = await LoopbackServer.create();
        try {
            const serverSock = loopback.acceptOne(); // register; resolve after connect
            const transport = await connect({
                host: "127.0.0.1",
                port: loopback.port,
                readTimeoutMs: 60,
            });
            await serverSock;

            await expect(transport.read()).rejects.toBeInstanceOf(ReadTimeoutError);

            await transport.close();
        } finally {
            await loopback.close();
        }
    });

    it("resolves typed errors from socket errors", () => {
        const e = new TransportError("boom", { path: "/x" });
        expect(e).toBeInstanceOf(Error);
        expect(e.kind).toBe("TransportError");
        expect(e.details.path).toBe("/x");
    });

    it("is idempotent and resolves once across double close()", async () => {
        const loopback = await LoopbackServer.create();
        try {
            const serverSock = loopback.acceptOne(); // register; resolve after connect
            const transport = await connect({ host: "127.0.0.1", port: loopback.port });
            await serverSock;

            // Both must resolve; the second is a no-op returning the same result.
            const [r1, r2] = await Promise.all([transport.close(), transport.close()]);
            expect(r1).toBeUndefined();
            expect(r2).toBeUndefined();
            expect(transport.state.state).toBe("closed");
        } finally {
            await loopback.close();
        }
    });
});

describe("connect timeout", () => {
    it("rejects with ConnectTimeoutError when the connection never establishes", async () => {
        // Bind the connect attempt to a non-routable RFC 5737 TEST-NET-1 address so
        // the SYN is silently dropped — no RST, no connect. With a short timeout
        // the deferred ConnectTimeoutError must win the race against any host-level
        // unreachable signal.
        await expect(
            connect({
                host: "192.0.2.1",
                port: 443,
                connectTimeoutMs: 50,
                dnsLookup: (_name, _opts, cb) => cb(null, "192.0.2.1", 4),
            }),
        ).rejects.toBeInstanceOf(ConnectTimeoutError);
    });
});

describe("Step 6 — observability seam", () => {
    it("emits state transitions open -> closing -> closed with correlation id", async () => {
        const loopback = await LoopbackServer.create();
        try {
            const serverSock = loopback.acceptOne();

            // The transport starts life in "connecting"; the first _transition it
            // emits is "open" once the socket connects. connect() resolves on that
            // "open" state, so we capture it directly and subscribe for the rest.
            const seen: TransportState["state"][] = [];
            const transport = await connect({ host: "127.0.0.1", port: loopback.port });

            // TransportId is observable and non-empty — the correlation handle.
            expect(typeof transport.id).toBe("string");
            expect(transport.id.length).toBeGreaterThan(0);

            // "open" was the state reached during connect(); capture it directly.
            seen.push(transport.state.state);
            transport.on("state", (s: TransportState) => seen.push(s.state));

            const sock = await serverSock;
            expect(transport.state.state).toBe("open");

            await transport.close();
            sock.end();

            // Allow the socket "close" event to drive the final transition.
            await new Promise((r) => setTimeout(r, 50));

            expect(seen).toContain("open");
            expect(seen).toContain("closing");
            expect(seen).toContain("closed");
            expect(seen.indexOf("open")).toBeLessThan(seen.indexOf("closing"));
            expect(seen.indexOf("closing")).toBeLessThan(seen.indexOf("closed"));
        } finally {
            await loopback.close();
        }
    });
});

describe("remote lifecycle — error and half-close drive state", () => {
    it("transitions to closed/error when the client socket errors", async () => {
        const loopback = await LoopbackServer.create();
        try {
            loopback.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loopback.port });

            // A real consumer always attaches a transport-level "error" listener —
            // the transport re-emits socket errors (transport.ts ~line 177), and an
            // unhandled re-emit would otherwise throw. Mirror that contract here so
            // we exercise the handler without an uncaught-error cascade.
            transport.on("error", () => {});

            // Exercise the transport's socket "error" handler (transport.ts ~line
            // 176-181) directly: a client-side socket error must map into an "error"
            // CloseReason and a transition to "closed". We reach the private socket
            // via white-box access — this is the deterministic trigger for a path
            // that a remote destroy cannot reliably reproduce (destroying the
            // server-side socket yields a clean FIN → hadError=false on the client).
            const socket = (transport as unknown as { socket: Socket }).socket;
            socket.emit("error", new Error("simulated client socket error"));

            // The error handler runs synchronously on emit(), but give the
            // subsequent "close" event a tick so the transition settles.
            await new Promise((r) => setTimeout(r, 50));

            expect(transport.state.state).toBe("closed");
            if (transport.state.state === "closed") {
                expect(transport.state.reason.kind).toBe("error");
            }
            // The recorded reason should wrap the error we emitted.
            if (transport.state.state === "closed" && transport.state.reason.kind === "error") {
                expect(transport.state.reason.error.message).toBe("simulated client socket error");
            }
            // Unref the underlying socket so it doesn't keep the event loop alive
            // after the test ends — destroying it would ECONNRESET the peer server
            // socket (no error listener there), surfacing as an unhandled error.
            socket.unref();
        } finally {
            await loopback.close();
        }
    });

    it("transitions to closed/remote_close when the remote sends EOF first", async () => {
        const loopback = await LoopbackServer.create();
        try {
            const serverSock = loopback.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loopback.port });

            const sock = await serverSock;
            // Remote sends EOF/end without the client closing first
            // (transport.ts ~line 171-174 path: socket "end" event). A clean
            // FIN produces hadError=false on the socket "close" event, which
            // the transport maps to a "remote_close" reason.
            sock.end();

            // Allow the "close" event (hadError=false) to drive the transition.
            await new Promise((r) => setTimeout(r, 50));

            expect(transport.state.state).toBe("closed");
            if (transport.state.state === "closed") {
                expect(transport.state.reason.kind).toBe("remote_close");
            }
        } finally {
            await loopback.close();
        }
    });
});
