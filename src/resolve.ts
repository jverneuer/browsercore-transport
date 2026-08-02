/**
 * DNS resolution for @browsercore/transport.
 *
 * `resolveHost` turns a hostname into a concrete address using the configured
 * (or default) DNS lookup, honoring the IPv6 preference. It is the one place
 * that knows about DNS; the rest of the package operates on resolved addresses.
 */

import { lookup as dnsLookup } from "node:dns";
import type { ResolvedAddress } from "./types.js";
import { DnsResolutionError } from "./errors.js";

/**
 * Resolve a host to an address using the configured (or default) DNS lookup.
 *
 * @param host - DNS name or IP literal to resolve.
 * @param ipv6 - Prefer IPv6 addresses when `true`, IPv4 otherwise.
 * @param lookup - Injectable lookup (e.g. for DoH). Defaults to `dns.lookup`.
 */
export function resolveHost(
    host: string,
    ipv6: boolean,
    lookup: (
        hostname: string,
        options: { family: 4 | 6 },
        callback: (err: Error | null, address: string, family: number) => void,
    ) => void = dnsLookup,
): Promise<ResolvedAddress> {
    return new Promise((resolve, reject) => {
        const family = ipv6 ? 6 : 4;
        lookup(host, { family }, (err, address, resolvedFamily) => {
            if (err) {
                reject(new DnsResolutionError(host, { cause: err }));
                return;
            }
            // `||` (not `??`) is intentional: a lookup reporting `0` means
            // "unknown family" and must fall back to the family we requested.
            const fam = (resolvedFamily || family) as ResolvedAddress["family"];
            resolve({ address, family: fam });
        });
    });
}
