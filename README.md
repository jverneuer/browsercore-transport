# @browsercore/transport

[![npm version](https://img.shields.io/npm/v/@browsercore/transport)](https://www.npmjs.com/package/@browsercore/transport)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/jverneuer/browsercore-transport/coverage/coverage/badge.json)](https://github.com/jverneuer/browsercore-transport/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-transport/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-transport/actions/workflows/ci.yml)

A generic byte-stream transport abstraction: reliable, ordered bytes over TCP with
connection lifecycle, backpressure, timeouts, and DNS resolution. It owns no knowledge
of TLS, HTTP, or browser fingerprints — higher layers (`tls`, `http1`, `http2`) compose
exclusively through its public interface. This is the bottom of the browsercore stack.

## Install

```bash
npm install @browsercore/transport
```

## Quick usage

```ts
import { connect } from "@browsercore/transport";

const transport = await connect({ host: "example.com", port: 443 });

await transport.write(handshakeBytes);
const chunk = await transport.read();

// Or stream via events:
transport.on("data", (chunk: Uint8Array) => { /* ... */ });
transport.on("state", (s) => { /* connecting -> open -> closing -> closed */ });

await transport.close();
```

## Public API

| Export | Kind | Purpose |
| --- | --- | --- |
| `connect()` | function | Resolve DNS and establish a TCP transport |
| `resolveHost()` | function | Resolve a host to an address (injectable lookup) |
| `TcpTransport` | class | Concrete `Transport` implementation over `node:net.Socket` |
| `Transport` | interface | Public contract higher layers depend on |
| `TransportOptions` | interface | Options for `connect()` (timeouts, IPv6, DNS, no-delay) |
| `TransportState` | discriminated union | `connecting \| open \| closing \| closed` |
| `CloseReason` | discriminated union | Why a transport closed (`client_close`, `remote_close`, `error`, `timeout`) |
| `ResolvedAddress` | interface | Address family + IP returned by `resolveHost()` |
| `TransportError` | class | Base typed error (with `details` and `cause`) |
| `ConnectTimeoutError` | class | Connection timed out |
| `DnsResolutionError` | class | DNS lookup failed |
| `IdleTimeoutError` | class | No data flowed within the idle timeout |
| `ReadTimeoutError` | class | A `read()` saw no data within the per-read timeout |

## Dependency graph

```
@browsercore/transport
  └─ node:net / node:dns / node:events
```

No other `@browsercore/*` packages are imported.

## License

MIT
