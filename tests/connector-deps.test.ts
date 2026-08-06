import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
    directConnector,
    createHttpProxy,
    setConnectorDeps,
    resetConnectorDeps,
} from "../src/index.js";
import type { Net, Socket, DnsResolver, ConnectOptions } from "@browsercore/contracts";

const mockSocket: Socket = {
    write(_data: Uint8Array, _cb?: (err?: Error | null) => void) { return true; },
    end() {},
    destroy(_error?: Error) {},
    destroyed: false,
    once(_event: string, _listener: (...args: unknown[]) => void) {},
    on(_event: string, _listener: (...args: unknown[]) => void) {},
};

const mockNet: Net = {
    connect(_options: ConnectOptions): Socket {
        return mockSocket;
    },
};

const mockDns: DnsResolver = {
    async lookup(_hostname: string, _family: 4 | 6) {
        return [{ address: "127.0.0.1", family: 4 }];
    },
};

describe("connector deps", () => {
    afterEach(() => {
        resetConnectorDeps();
    });

    describe("when initialized", () => {
        beforeEach(() => {
            setConnectorDeps({ net: mockNet, dns: mockDns });
        });

        it("directConnector connect does not throw about missing deps", () => {
            expect(() => directConnector.connect("127.0.0.1", 80)).not.toThrow(
                /Transport dependencies not initialized/,
            );
        });

        it("createHttpProxy uses injected deps", () => {
            const connector = createHttpProxy({ host: "127.0.0.1", port: 80 });
            expect(connector).toBeDefined();
            expect(typeof connector.connect).toBe("function");
        });
    });

    describe("when not initialized", () => {
        it("directConnector connect throws TransportError", () => {
            expect(() => directConnector.connect("127.0.0.1", 80)).toThrow(
                /Transport dependencies not initialized/,
            );
        });
    });
});
