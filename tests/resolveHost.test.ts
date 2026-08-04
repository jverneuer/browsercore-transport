import { describe, expect, it } from "vitest";
import { resolveHost, DnsResolutionError } from "../src/index.js";

describe("resolveHost", () => {
    it("returns the address from a successful lookup", async () => {
        const fakeLookup = (
            _host: string,
            _opts: { family: 4 | 6 },
            cb: (err: Error | null, address: string, family: number) => void,
        ): void => {
            cb(null, "93.184.216.34", 4);
        };

        const result = await resolveHost("example.com", false, fakeLookup);

        expect(result.address).toBe("93.184.216.34");
        expect(result.family).toBe(4);
    });

    it("rejects with DnsResolutionError on lookup failure", async () => {
        const fakeLookup = (
            _host: string,
            _opts: { family: 4 | 6 },
            cb: (err: Error | null, _address: string, _family: number) => void,
        ): void => {
            cb(new Error("ENOTFOUND"), "", 0);
        };

        await expect(resolveHost("nx.example", false, fakeLookup)).rejects.toThrow(
            DnsResolutionError,
        );
    });

    it("falls back to the requested family when the lookup reports none (B78)", async () => {
        // Some lookup implementations call back with resolvedFamily=0/null/undefined
        // when they cannot determine the family. The `resolvedFamily ?? family`
        // fallback (resolveHost ~line 437) must then use the family we requested
        // rather than propagating a falsy value into ResolvedAddress.family.
        const fakeLookup = (
            _host: string,
            _opts: { family: 4 | 6 },
            cb: (err: Error | null, address: string, family: number) => void,
        ): void => {
            cb(null, "192.0.2.5", 0);
        };

        const result = await resolveHost("example.com", false, fakeLookup);

        expect(result.address).toBe("192.0.2.5");
        expect(result.family).toBe(4);
    });

    it("passes IPv6 family when requested", async () => {
        let capturedFamily = 0;
        const fakeLookup = (
            _host: string,
            opts: { family: 4 | 6 },
            cb: (err: Error | null, address: string, family: number) => void,
        ): void => {
            capturedFamily = opts.family;
            cb(null, "::1", 6);
        };

        const result = await resolveHost("example.com", true, fakeLookup);

        expect(capturedFamily).toBe(6);
        expect(result.family).toBe(6);
    });

    it("uses the default dns.lookup when no lookup function is supplied (localhost)", async () => {
        // The `= dnsLookup` default parameter branch only fires when the third
        // argument is omitted. "localhost" resolves on every platform to a
        // loopback address, so this exercises the real resolver end-to-end.
        const result = await resolveHost("localhost", false);

        expect(typeof result.address).toBe("string");
        expect(result.address.length).toBeGreaterThan(0);
        expect(result.family).toBe(4);
    });

    it("defaults to IPv4 family when ipv6 is false", async () => {
        let capturedFamily = 0;
        const fakeLookup = (
            _host: string,
            opts: { family: 4 | 6 },
            cb: (err: Error | null, address: string, family: number) => void,
        ): void => {
            capturedFamily = opts.family;
            cb(null, "127.0.0.1", 4);
        };

        const result = await resolveHost("example.com", false, fakeLookup);

        expect(capturedFamily).toBe(4);
        expect(result.family).toBe(4);
    });
});
