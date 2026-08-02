/**
 * Connection entry point for @browsercore/transport.
 *
 * `connect` is the single public way to open a transport: it mintes a
 * correlation id, delegates to {@link TcpTransport.create} for DNS + socket
 * setup, and resolves once the connection is established.
 */

import type { Transport, TransportId, TransportOptions } from "./types.js";
import { TcpTransport } from "./transport.js";

/**
 * Establish a TCP transport connection.
 *
 * Resolves DNS (via {@link resolveHost}), opens a `node:net.Socket`, wires
 * timeouts/backpressure/idle, and resolves once the connection is established.
 *
 * @example
 * ```ts
 * const transport = await connect({ host: "example.com", port: 443 });
 * await transport.write(handshakeBytes);
 * const chunk = await transport.read();
 * await transport.close();
 * ```
 */
export function connect(options: TransportOptions): Promise<Transport> {
    const id = `transport_${Date.now().toString(36)}` as TransportId;
    return TcpTransport.create(id, options);
}
