import { describe, expect, it } from "vitest";
import { resolveHost, DnsResolutionError } from "../src/index.js";
import { nodeDns, mockDns } from "./helpers.js";

describe("resolveHost", () => {
    it("returns the address from a successful lookup", async () => {
        const result = await resolveHost("example.com", false, mockDns("93.184.216.34", 4));

        expect(result.address).toBe("93.184.216.34");
        expect(result.family).toBe(4);
    });

    it("rejects with DnsResolutionError on lookup failure", async () => {
        const failingDns = {
            lookup(_hostname: string, _family: 4 | 6) {
                return Promise.reject(new Error("ENOTFOUND"));
            },
        };

        await expect(resolveHost("nx.example", false, failingDns)).rejects.toThrow(
            DnsResolutionError,
        );
    });

    it("rejects with DnsResolutionError when the lookup returns an empty array", async () => {
        const emptyDns = {
            lookup(_hostname: string, _family: 4 | 6) {
                return Promise.resolve([]);
            },
        };

        await expect(resolveHost("example.com", false, emptyDns)).rejects.toThrow(
            DnsResolutionError,
        );
    });

    it("falls back to the requested family when the lookup reports none (B78)", async () => {
        // Some lookup implementations call back with resolvedFamily=0/null/undefined
        // when they cannot determine the family. The `resolvedFamily || family`
        // fallback (resolveHost ~line 437) must then use the family we requested
        // rather than propagating a falsy value into ResolvedAddress.family.
        const zeroFamilyDns = {
            lookup(_hostname: string, _family: 4 | 6) {
                return Promise.resolve([{ address: "192.0.2.5", family: 0 as const }]);
            },
        };

        const result = await resolveHost("example.com", false, zeroFamilyDns);

        expect(result.address).toBe("192.0.2.5");
        expect(result.family).toBe(4);
    });

    it("passes IPv6 family when requested", async () => {
        let capturedFamily: 4 | 6 = 4;
        const capturingDns = {
            lookup(_hostname: string, family: 4 | 6) {
                capturedFamily = family;
                return Promise.resolve([{ address: "::1", family: 6 }]);
            },
        };

        const result = await resolveHost("example.com", true, capturingDns);

        expect(capturedFamily).toBe(6);
        expect(result.family).toBe(6);
    });

    it("uses the default dns.lookup when no custom resolver is supplied (localhost)", async () => {
        // Exercises the real Node.js resolver end-to-end.
        const result = await resolveHost("localhost", false, nodeDns);

        expect(typeof result.address).toBe("string");
        expect(result.address.length).toBeGreaterThan(0);
        expect(result.family).toBe(4);
    });

    it("defaults to IPv4 family when ipv6 is false", async () => {
        let capturedFamily: 4 | 6 = 4;
        const capturingDns = {
            lookup(_hostname: string, family: 4 | 6) {
                capturedFamily = family;
                return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
            },
        };

        const result = await resolveHost("example.com", false, capturingDns);

        expect(capturedFamily).toBe(4);
        expect(result.family).toBe(4);
    });
});
