/**
 * DNS resolution for @browsercore/transport.
 *
 * `resolveHost` turns a hostname into a concrete address using the injected
 * {@link DnsResolver}, honoring the IPv6 preference. It is the one place
 * that knows about DNS; the rest of the package operates on resolved addresses.
 */

import type { DnsResolver } from "@browsercore/contracts";
import type { ResolvedAddress } from "./types.js";
import { DnsResolutionError } from "./errors.js";

/**
 * Resolve a host to a concrete address using the injected DNS resolver.
 *
 * This is the single DNS-aware entry point in the package; the rest of the
 * transport layer operates only on resolved addresses. The resolver is
 * injectable so tests and DoH-based resolvers can replace the default.
 *
 * @param host - DNS name (e.g. `"example.com"`) or IP literal to resolve.
 * @param ipv6 - Prefer IPv6 addresses when `true`, IPv4 otherwise.
 * @param dns - Injectable DNS resolver (defaults to Node's `dns.lookup` when injected by browsersmith).
 * @returns A promise that resolves with the {@link ResolvedAddress}.
 * @throws {DnsResolutionError} If the lookup fails.
 *
 * @example
 * ```ts
 * // With injected resolver:
 * const { address, family } = await resolveHost("example.com", false, dnsResolver);
 * ```
 *
 * @since 0.1.0
 */
export function resolveHost(
    host: string,
    ipv6: boolean,
    dns: DnsResolver,
): Promise<ResolvedAddress> {
    const family = ipv6 ? 6 : 4;
    return dns.lookup(host, family).then(
        (addresses) => {
            const first = addresses[0];
            if (!first) {
                throw new DnsResolutionError(host, { cause: new Error("DNS lookup returned no addresses") });
            }
            // `||` (not `??`) is intentional: a lookup reporting `0` means
            // "unknown family" and must fall back to the family we requested.
            const fam = (first.family || family) as ResolvedAddress["family"];
            return { address: first.address, family: fam };
        },
        (err) => {
            // Wrap the underlying DNS error in a typed DnsResolutionError.
            throw new DnsResolutionError(host, { cause: err instanceof Error ? err : new Error(String(err)) });
        },
    );
}
