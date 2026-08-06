/**
 * Test helpers for transport tests — mock Net and DnsResolver implementations.
 */

import { connect as netConnect } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import type { Net, Socket, DnsResolver, ConnectOptions, IPAddress } from "@browsercore/contracts";

/**
 * Real Node.js Net adapter backed by node:net.
 * Used by tests that spin up a real loopback server.
 */
export const nodeNet: Net = {
    connect(options: ConnectOptions): Socket {
        return netConnect({
            host: options.host,
            port: options.port,
            noDelay: options.noDelay,
            localAddress: options.localAddress,
            family: options.family,
        }) as Socket;
    },
};

/**
 * Real Node.js DnsResolver backed by node:dns.lookup.
 * Used by tests that resolve real hostnames (e.g. "localhost").
 */
export const nodeDns: DnsResolver = {
    lookup(hostname, family) {
        return new Promise((resolve, reject) => {
            dnsLookup(hostname, { family }, (err, address, resolvedFamily) => {
                if (err) {
                    reject(err);
                    return;
                }
                const result: IPAddress = {
                    address,
                    family: (resolvedFamily || family) as 4 | 6,
                };
                resolve([result]);
            });
        });
    },
};

/**
 * Mock DnsResolver that returns a fixed address.
 * Used by tests that need deterministic DNS without a real resolver.
 */
export function mockDns(address = "127.0.0.1", family: 4 | 6 = 4): DnsResolver {
    return {
        lookup(_hostname, _family) {
            return Promise.resolve([{ address, family }]);
        },
    };
}
