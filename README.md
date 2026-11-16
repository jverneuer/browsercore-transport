# @browsercore/transport

[![npm version](https://img.shields.io/npm/v/@browsercore/transport)](https://www.npmjs.com/package/@browsercore/transport)
[![coverage](https://img.shields.io/endpoint?url=https://jverneuer.github.io/browsercore-transport/badge.json)](https://github.com/jverneuer/browsercore-transport/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-transport/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-transport/actions/workflows/ci.yml)

@browsercore/transport abstracts socket management, DNS resolution, connection lifecycle, backpressure, and timeouts behind a small, strongly typed interface. It deliberately knows nothing about TLS, HTTP, QUIC, proxies, or browser fingerprinting, making it the foundation on which higher protocol layers are built. This package forms the lowest layer of the BrowserCore networking stack.

This package contains **zero `node:*` imports** in `src/`. The event backend
is injected via `TransportOptions.events` — a composable `EventProvider` that
decouples the transport from `node:events`.

## Install

```bash
npm install @browsercore/transport
```

## Quick usage

```ts
import { connect } from "@browsercore/transport";
import { nodeEventProvider } from "@browsercore/browsersmith";

const transport = await connect({
    host: "example.com",
    port: 443,
    net: nodeNet,
    dns: nodeDns,
    events: nodeEventProvider,   // injected EventProvider
});

await transport.write(handshakeBytes);
const chunk = await transport.read();

// Events via the injected provider:
transport.on("data", (chunk: Uint8Array) => { /* ... */ });
transport.on("state", (s) => { /* connecting -> open -> closing -> closed */ });

await transport.close();
```

Event delivery is scoped per transport instance: registrations and emissions
are namespaced onto the injected provider under a transport-unique channel, so
a shared provider (e.g. a process-wide `nodeEventProvider` singleton) never
cross-delivers `data`/`close`/`error` events between transports.

## Package Dependencies

```
@browsercore/transport
├── node:net   (injected via TransportOptions.net)
├── node:dns   (injected via TransportOptions.dns)
└── (event backend injected via TransportOptions.events — no node:events import)
```

This package imports no other `@browsercore/*` packages (only interfaces from
`@browsercore/contracts`).

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
| `TcpTransport` | class | Concrete `Transport` implementation |
| `Transport` | interface | Public contract higher layers depend on (extends `EventProvider`) |
| `TransportOptions` | interface | Options for `connect()` (timeouts, IPv6, DNS, no-delay, events) |
| `TransportState` | discriminated union | `connecting \| open \| closing \| closed` |
| `CloseReason` | discriminated union | Why a transport closed (`client_close`, `remote_close`, `error`, `timeout`) |
| `ResolvedAddress` | interface | Address family + IP returned by `resolveHost()` |
| `TransportError` | class | Base typed error (with `details` and `cause`) |
| `ConnectTimeoutError` | class | Connection timed out |
| `DnsResolutionError` | class | DNS lookup failed |
| `IdleTimeoutError` | class | No data flowed within the idle timeout |
| `ReadTimeoutError` | class | A `read()` saw no data within the per-read timeout |


## Contributing

Contributions are welcome — bug reports, reproductions, docs and code alike. Start with [CONTRIBUTING.md](CONTRIBUTING.md); the full guide lives in the [browsersmith repo](https://github.com/jverneuer/browsersmith/blob/main/CONTRIBUTING.md). First timer? Check the [`good first issue`](https://github.com/jverneuer/browsercore-transport/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label. Security issues: [SECURITY.md](SECURITY.md), never a public issue.

## License

MIT
