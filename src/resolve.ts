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

/**
 * Resolve a host to candidate addresses across BOTH address families, ordered
 * with the preferred family first.
 *
 * `resolveHost` answers a single-family lookup, which makes the caller's
 * connectivity hinge on one family: a host with no AAAA record fails outright
 * under an IPv6 preference, and a host whose AAAA is unreachable at the
 * network level can never fall back. `TcpTransport._establish` uses this
 * resolver instead so a failed or unreachable first candidate can fall back
 * to the other family (happy-eyeballs-style sequential fallback).
 *
 * Both lookups are issued in parallel; the first address of each family is
 * kept. A family whose lookup fails or returns no addresses is simply absent
 * from the result — only when BOTH families are unavailable is a
 * {@link DnsResolutionError} thrown (surfacing the preferred family's error).
 *
 * @param host - DNS name (e.g. `"example.com"`) or IP literal to resolve.
 * @param ipv6 - Prefer IPv6 addresses when `true`, IPv4 otherwise (ordering only).
 * @param dns - Injectable DNS resolver.
 * @returns A promise resolving with at least one candidate address.
 * @throws {DnsResolutionError} If neither family resolves.
 *
 * @since 0.2.7
 */
export async function resolveHostCandidates(
    host: string,
    ipv6: boolean,
    dns: DnsResolver,
): Promise<ResolvedAddress[]> {
    const preferred = ipv6 ? 6 : 4;
    const alternate = ipv6 ? 4 : 6;
    const [preferredSettled, alternateSettled] = await Promise.allSettled([
        dns.lookup(host, preferred),
        dns.lookup(host, alternate),
    ]);

    const candidates: ResolvedAddress[] = [];
    const seen = new Set<string>();
    for (const [settled, family] of [
        [preferredSettled, preferred],
        [alternateSettled, alternate],
    ] as const) {
        if (settled.status !== "fulfilled") {
            continue;
        }
        const first = settled.value[0];
        if (!first) {
            continue;
        }
        // A resolver that ignores the requested family returns the same
        // address twice — connecting to it once is enough.
        if (seen.has(first.address)) {
            continue;
        }
        seen.add(first.address);
        // `||` (not `??`): a lookup reporting `0` means "unknown family" and
        // must fall back to the family we requested.
        const fam = (first.family || family) as ResolvedAddress["family"];
        candidates.push({ address: first.address, family: fam });
    }

    if (candidates.length === 0) {
        const preferredErr: unknown = preferredSettled.status === "rejected" ? preferredSettled.reason : undefined;
        const alternateErr: unknown =
            alternateSettled.status === "rejected" ? alternateSettled.reason : undefined;
        const cause: unknown = preferredErr ?? alternateErr ?? new Error("DNS lookup returned no addresses");
        throw new DnsResolutionError(host, {
            cause: cause instanceof Error ? cause : new Error(String(cause)),
        });
    }
    return candidates;
}
