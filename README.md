# @browsercore/transport

[![npm version](https://img.shields.io/npm/v/@browsercore/transport)](https://www.npmjs.com/package/@browsercore/transport)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/jverneuer/browsercore-transport/coverage/coverage/badge.json)](https://github.com/jverneuer/browsercore-transport/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-transport/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-transport/actions/workflows/ci.yml)

@browsercore/transport abstracts socket management, DNS resolution, connection lifecycle, backpressure, and timeouts behind a small, strongly typed interface. It deliberately knows nothing about TLS, HTTP, QUIC, proxies, or browser fingerprinting, making it the foundation on which higher protocol layers are built. This package forms the lowest layer of the BrowserCore networking stack.

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

## Package Dependencies

```
@browsercore/transport
├── node:net
├── node:dns
└── node:events
```

This package has no runtime dependencies and imports no other @browsercore/* packages.

## Position in BrowserCore

```
Application
      │
 HTTP/3 / HTTP/2 / HTTP/1
      │
      TLS
      │
@browsercore/transport
      │
     TCP
      │
      IP
```

Every higher networking layer communicates with the network exclusively through the Transport interface.

## Documentation

Full API documentation (generated from TSDoc annotations): [docs/README.md](docs/README.md)

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
