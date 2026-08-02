# @browsercore/transport

A generic byte-stream transport abstraction independent of TLS or HTTP.

## Responsibility

Provide reliable, ordered byte delivery over TCP. Owns connection lifecycle,
read/write buffering, backpressure, timeouts, DNS resolution, and IPv4/IPv6.

## What it does NOT know about

- TLS
- HTTP (any version)
- Browser fingerprints
- Cookies

## Public API

```ts
import { connect, resolveHost, TransportError } from "@browsercore/transport";

const transport = await connect({
    host: "example.com",
    port: 443,
    connectTimeoutMs: 10_000,
    idleTimeoutMs: 60_000,
});

await transport.write(bytes);
const chunk = await transport.read();

transport.on("data", (chunk: Uint8Array) => { /* streaming */ });
transport.on("close", (reason: CloseReason) => { /* ... */ });

await transport.close();
```

## Types

| Export | Kind | Purpose |
| --- | --- | --- |
| `Transport` | interface | Public contract higher layers depend on |
| `connect()` | function | Establish a TCP connection |
| `resolveHost()` | function | DNS resolution (injectable lookup) |
| `TransportState` | discriminated union | `connecting \| open \| closing \| closed` |
| `CloseReason` | discriminated union | Why a transport closed |
| `TransportError` | class | Base typed error |

## Dependency graph

```
@browsercore/transport
  └─ node:net / node:dns / node:crypto
```

No other `@browsercore/*` packages are imported.
