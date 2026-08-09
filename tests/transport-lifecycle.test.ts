import { describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { connect } from "../src/index.js";
import { TransportError } from "../src/errors.js";
import type { Transport, TransportState } from "../src/types.js";
import { nodeNet, nodeDns } from "./helpers.js";
import { createMockEventProvider } from "./test-helpers.js";

/**
 * Minimal loopback TCP server on an ephemeral port. Every accepted socket gets
 * a no-op "error" listener so that abruptly destroying the *client* side (which
 * RSTs the peer) does not surface as an unhandled error here and crash the test.
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

    public acceptOne(): Promise<Socket> {
        return new Promise((resolve) => this.server.once("connection", resolve));
    }

    public async close(): Promise<void> {
        for (const sock of this.sockets) {
            sock.destroy();
        }
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
}

/** White-box accessor for the transport's private socket field. */
function socketOf(t: Transport): Socket {
    return (t as unknown as { socket: Socket }).socket;
}

/** Read exactly `total` bytes from the server-side socket. */
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

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("read path — buffered data", () => {
    it("read() returns data that arrived before the read was issued (buffered path)", async () => {
        // Covers the readBuffer.push() branch of the "data" handler and the
        // `if (buffered) return resolve(buffered)` branch of read().
        const loop = await Loopback.create();
        try {
            const serverSock = loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            const sock = await serverSock;

            sock.write(Buffer.from([0x01, 0x02, 0x03]));
            // Give the client socket time to receive and buffer the chunk with no
            // pending read() outstanding.
            await tick(50);

            const chunk = await transport.read();
            expect([...chunk]).toEqual([0x01, 0x02, 0x03]);
            await transport.close();
        } finally {
            await loop.close();
        }
    });
});

describe("write path — kernel-accepted and error paths", () => {
    it("write() resolves promptly for a small payload accepted by the kernel", async () => {
        // Covers the `wroteOk && !settled` resolve branch: socket.write returns
        // true (no backpressure) and the flush callback resolves the promise.
        const loop = await Loopback.create();
        try {
            const serverSock = loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            const sock = await serverSock;

            const payload = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
            await transport.write(payload);
            const received = await readAll(sock, payload.length);
            expect([...received]).toEqual([...payload]);
            await transport.close();
        } finally {
            await loop.close();
        }
    });

    it("write() rejects when the flush callback reports an error", async () => {
        // Covers the `err && !settled` branch of the write flush callback. The
        // transport hands data to socket.write with a callback; if that callback
        // fires with an error the write promise must reject.
        const loop = await Loopback.create();
        try {
            loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            const socket = socketOf(transport) as Socket & {
                write: (...args: unknown[]) => unknown;
            };
            const realWrite = socket.write.bind(socket);

            (socket as { write: (...args: unknown[]) => unknown }).write = (
                _data: unknown,
                cb: (err: Error) => void,
            ): boolean => {
                cb(new Error("write aborted"));
                return true;
            };

            await expect(transport.write(Uint8Array.of(1, 2, 3))).rejects.toThrow(
                "write aborted",
            );

            (socket as { write: unknown }).write = realWrite;
            await transport.close();
        } finally {
            await loop.close();
        }
    });

    it("write() rejects when the underlying socket is unexpectedly absent", async () => {
        // Defensive branch: ensureOpen() passes (state "open") but socket is
        // undefined — not reachable via the public API; exercised via white-box.
        const loop = await Loopback.create();
        try {
            loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            const wb = transport as unknown as { socket: Socket | undefined };
            const real = wb.socket;
            wb.socket = undefined;
            await expect(transport.write(Uint8Array.of(1))).rejects.toThrow(
                TransportError,
            );
            wb.socket = real;
            await transport.close();
        } finally {
            await loop.close();
        }
    });

    it("ignores a late drain once a backpressured write has already settled (double-settle guard)", async () => {
        // Covers the drain resolve-handler's `if (settled) return false` guard.
        // The write is backpressured (socket.write returns false → awaitDrain
        // queued) but settles first via the flush-callback error branch; a drain
        // arriving afterwards must NOT double-resolve/reject the promise.
        const loop = await Loopback.create();
        try {
            loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            const socket = socketOf(transport) as Socket & {
                write: (...args: unknown[]) => unknown;
            };
            const realWrite = socket.write.bind(socket);
            (socket as { write: (...args: unknown[]) => unknown }).write = (
                _data: unknown,
                cb: (err: Error) => void,
            ): boolean => {
                // Backpressure + synchronous settle via the error branch.
                cb(new Error("flush error"));
                return false;
            };

            await expect(transport.write(Uint8Array.of(1, 2, 3))).rejects.toThrow(
                "flush error",
            );
            await tick(0); // let awaitDrain's microtask arm the waiter

            // A drain arriving now must be a no-op against the settled write.
            expect(() => socket.emit("drain")).not.toThrow();
            await tick(0);

            (socket as { write: unknown }).write = realWrite;
            await transport.close();
        } finally {
            await loop.close();
        }
    });

    it("ignores a late drain rejection once a backpressured write has already settled", async () => {
        // Covers the drain reject-handler's `if (settled) return false` guard.
        // After the write settles via the flush-callback error, a socket error
        // drives drain.reject() on the queued waiter; the rejection must be
        // swallowed rather than double-settling the write promise.
        const loop = await Loopback.create();
        try {
            loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            transport.on("error", () => {});
            transport.on("close", () => {});
            const socket = socketOf(transport) as Socket & {
                write: (...args: unknown[]) => unknown;
            };
            const realWrite = socket.write.bind(socket);
            (socket as { write: (...args: unknown[]) => unknown }).write = (
                _data: unknown,
                cb: (err: Error) => void,
            ): boolean => {
                cb(new Error("flush error"));
                return false;
            };

            await expect(transport.write(Uint8Array.of(1, 2, 3))).rejects.toThrow(
                "flush error",
            );
            await tick(0); // let awaitDrain's microtask arm the waiter

            // Socket errors after the write settled → drain.reject on an
            // already-settled write; must not throw or re-reject.
            expect(() => socket.emit("error", new Error("late socket error"))).not.toThrow();
            await tick(0);

            (socket as { write: unknown }).write = realWrite;
            socket.destroy();
            await tick(50);
        } finally {
            await loop.close();
        }
    });

    it("a backpressured write rejects when the socket errors (drain.reject path)", async () => {
        // Covers the drain-rejection branch of write(): the write is pending on
        // awaitDrain(), then the socket "error" handler calls drain.reject(err),
        // which rejects the queued write via ensureTransportError.
        const loop = await Loopback.create();
        try {
            const serverSock = loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            transport.on("error", () => {}); // swallow re-emitted socket error
            const sock = await serverSock;
            sock.pause(); // keep the kernel buffer full → backpressure

            const payload = new Uint8Array(8 * 1024 * 1024).fill(0xcd);
            const writePromise = transport.write(payload);
            await tick(200); // ensure the kernel buffer is full and write is queued

            socketOf(transport).emit("error", new Error("link gone"));
            await expect(writePromise).rejects.toThrow("link gone");
            // Drain the payload so the server side closes cleanly.
            sock.resume();
            await readAll(sock, payload.length).catch(() => {});
            await tick(50);
        } finally {
            await loop.close();
        }
    });
});

describe("ensureOpen — guards against non-open states", () => {
    it("write()/read() throw once the transport is closed", async () => {
        const loop = await Loopback.create();
        try {
            loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            await transport.close();
            expect(transport.state.state).toBe("closed");
            expect(() => transport.write(Uint8Array.of(1))).toThrow(TransportError);
            expect(() => transport.read()).toThrow(TransportError);
        } finally {
            await loop.close();
        }
    });

    it("write()/read() throw while the transport is closing", async () => {
        // close() transitions to "closing" synchronously before awaiting the
        // socket close, so calling write()/read() before the await throws.
        const loop = await Loopback.create();
        try {
            const serverSock = loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            await serverSock;

            const closePromise = transport.close();
            expect(transport.state.state).toBe("closing");
            expect(() => transport.write(Uint8Array.of(1))).toThrow(TransportError);
            expect(() => transport.read()).toThrow(TransportError);
            await closePromise;
        } finally {
            await loop.close();
        }
    });

    it("write()/read() throw via the exhaustiveness guard on an invalid state", async () => {
        // The `default: assertNever(s)` branch is unreachable for any valid
        // TransportState (the switch is exhaustive). Reach it by white-boxing an
        // invalid state member — it must throw rather than silently fall through.
        const loop = await Loopback.create();
        try {
            loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            (transport as unknown as { _state: unknown })._state = { state: "bogus" };
            expect(() => transport.write(Uint8Array.of(1))).toThrow(/Unexpected value/);
            expect(() => transport.read()).toThrow(/Unexpected value/);
        } finally {
            await loop.close();
        }
    });

    it("write()/read() throw while the transport is still connecting", async () => {
        // The "connecting" branch of ensureOpen is a defensive guard: connect()
        // only resolves once the socket is open, so a caller never holds a
        // transport in this state via the public API. Reached via white-box state
        // access, mirroring the existing socket-level white-box tests.
        const loop = await Loopback.create();
        try {
            loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            const wb = transport as unknown as { _state: TransportState };
            wb._state = { state: "connecting" };

            expect(() => transport.write(Uint8Array.of(1))).toThrow(TransportError);
            expect(() => transport.read()).toThrow(TransportError);

            // Restore a closeable state so teardown does not no-op on the fake.
            wb._state = { state: "open" };
            await transport.close();
        } finally {
            await loop.close();
        }
    });
});

describe("close — lifecycle edges", () => {
    it("close() completes when the underlying socket is already destroyed", async () => {
        // Covers close()'s `!socket || socket.destroyed` branch: socket.destroy()
        // schedules its "close" event for a later tick, so synchronously here the
        // state is still "open" while socket.destroyed is already true.
        const loop = await Loopback.create();
        try {
            loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            const socket = socketOf(transport);
            socket.destroy();
            expect(socket.destroyed).toBe(true);
            expect(transport.state.state).toBe("open");

            await transport.close();
            await tick(50); // let the deferred socket "close" event settle
            expect(transport.state.state).toBe("closed");
        } finally {
            await loop.close();
        }
    });

    it("close() records an explicit close reason", async () => {
        const loop = await Loopback.create();
        try {
            loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            const reason = { kind: "error" as const, error: new Error("application") };
            await transport.close(reason);
            expect(transport.state.state).toBe("closed");
            if (transport.state.state === "closed") {
                expect(transport.state.reason).toBe(reason);
            }
        } finally {
            await loop.close();
        }
    });
});

describe("remote lifecycle — close-with-error mapping", () => {
    it("maps an unexpected socket close-with-error to a closed/error reason", async () => {
        // Covers the `hadError ? { kind: "error", ... }` branch of the transport's
        // socket "close" handler. Emitting "close" directly (with hadError=true)
        // bypasses the socket "error" handler, which would otherwise transition
        // first and skip this branch.
        const loop = await Loopback.create();
        try {
            loop.acceptOne();
            const transport = await connect({ host: "127.0.0.1", port: loop.port, net: nodeNet, dns: nodeDns, events: createMockEventProvider() });
            transport.on("error", () => {});
            transport.on("close", () => {});

            const socket = socketOf(transport);
            socket.emit("close", true);

            expect(transport.state.state).toBe("closed");
            if (transport.state.state === "closed") {
                expect(transport.state.reason.kind).toBe("error");
            }
            socket.destroy();
            await tick(50);
        } finally {
            await loop.close();
        }
    });
});

describe("idle timer — reset on data flow", () => {
    it("does not fire while data keeps flowing, then fires once data stops", async () => {
        // Property test: every incoming "data" chunk re-arms the idle timer, so a
        // steady trickle below the idle window must NOT time out; only a gap
        // longer than the idle window fires IdleTimeoutError.
        const loop = await Loopback.create();
        try {
            const serverSock = loop.acceptOne();
            const transport = await connect({
                host: "127.0.0.1",
                port: loop.port,
                idleTimeoutMs: 180,
                net: nodeNet,
                dns: nodeDns,
                events: createMockEventProvider(),
            });
            const sock = await serverSock;

            const errors: Error[] = [];
            transport.on("error", (e: Error) => errors.push(e));

            // Trickling faster than the 180ms idle window keeps resetting the timer.
            for (let i = 0; i < 3; i++) {
                sock.write(Buffer.from([i]));
                await tick(70);
            }
            expect(errors).toHaveLength(0);

            // Stop sending — the idle timer now runs to completion.
            await tick(260);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toBeInstanceOf(Error);
            expect((errors[0] as { idleMs?: number }).idleMs).toBe(180);
            expect(transport.state.state).toBe("closed");
        } finally {
            await loop.close();
        }
    });
});
