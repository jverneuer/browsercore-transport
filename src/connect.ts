/**
 * Connection entry point for @browsercore/transport.
 *
 * `connect` is the single public way to open a transport: it mints a
 * correlation id, delegates to {@link TcpTransport.create} for DNS + socket
 * setup, and resolves once the connection is established.
 */

import { systemClock, type Transport, type TransportId, type TransportOptions } from "./types.js";
import { TcpTransport } from "./transport.js";

/**
 * Establish a TCP transport connection.
 *
 * The single public way to open a transport: it mints a correlation id, delegates
 * to {@link TcpTransport.create} for DNS + socket setup, and resolves once the
 * connection is established. Resolves DNS (via {@link resolveHost}), opens a
 * socket via the injected {@link Net} implementation, wires
 * timeouts/backpressure/idle, and resolves once the connection is established.
 *
 * @param options - Connection target and timeout/backpressure configuration.
 *   See {@link TransportOptions} for all available options.
 * @returns A promise that resolves with a live {@link Transport} once connected.
 * @throws {DnsResolutionError} If the host cannot be resolved.
 * @throws {ConnectTimeoutError} If the TCP handshake does not complete in time.
 * @throws {TransportError} On socket errors during connection.
 *
 * @example
 * ```ts
 * const transport = await connect({ host: "example.com", port: 443 });
 * await transport.write(handshakeBytes);
 * const chunk = await transport.read();
 * await transport.close();
 * ```
 *
 * @example
 * ```ts
 * // With custom timeouts:
 * const transport = await connect({
 *     host: "example.com",
 *     port: 443,
 *     connectTimeoutMs: 5000,
 *     idleTimeoutMs: 30_000,
 * });
 * ```
 *
 * @see TcpTransport for the concrete implementation.
 * @since 0.1.0
 */
export function connect(options: TransportOptions): Promise<Transport> {
    // Ids are correlation handles, so the wall clock (`now()`) is the right
    // source — deadline math elsewhere in the package uses `monotonic()`.
    // Resolving the clock here keeps the id and the transport's timers on the
    // same injected source (or the same systemClock default).
    const clock = options.clock ?? systemClock;
    const id = `transport_${clock.now().toString(36)}` as TransportId;
    return TcpTransport.create(id, options);
}
