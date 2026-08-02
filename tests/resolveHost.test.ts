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
});
