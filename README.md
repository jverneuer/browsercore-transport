# @browsercore/transport

[![npm version](https://img.shields.io/npm/v/@browsercore/transport)](https://www.npmjs.com/package/@browsercore/transport)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/jverneuer/browsercore-transport/main/coverage/badge.json)](https://github.com/jverneuer/browsercore-transport/blob/main/COVERAGE.md)
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
| `ensureTransportError()` | function | Narrow a caught error to `TransportError`, wrapping if needed |

## Lifecycle

A transport progresses through a strict state machine. The current state lives in a
private `stateValue` backing field and is exposed through the public readonly `state`
getter (and the `"state"` event):

```
connecting → open → closing → closed
```

- `connecting` → `open`: the TCP socket has connected; `read()`/`write()` are now allowed.
- `open` → `closing`: a graceful `close()` was requested.
- Any state → `closed`: the socket closed, carrying a `CloseReason` (`client_close`,
  `remote_close`, `error`, or `timeout`).

`write()` and `read()` throw a typed `TransportError` unless the transport is `open`.

## Dependency graph

Runtime — what `src/` actually imports:

```
@browsercore/transport
  └─ node:net / node:dns / node:events
```

No other `@browsercore/*` packages are imported at runtime.

Build, lint, and test configuration is shared across every `@browsercore/*` package via
[`@browsercore/dev`](https://www.npmjs.com/package/@browsercore/dev). This package
consumes it as a devDependency (`file:../dev` during development) for:

```ts
// vitest.config.ts
import { definePackageConfig } from "@browsercore/dev/vitest";
export default definePackageConfig({ name: "transport" });
```

— and `oxlint.config.ts` extends the shared oxlint base, and `tsconfig.json` extends
`@browsercore/dev/tsconfig.base.json`.

## Development

This package follows the shared `@browsercore/*` workflow. Commands run from this repo:

```sh
npm install
npm run build      # tsc -p tsconfig.build.json (emit to dist/)
npm run typecheck  # tsc -p tsconfig.json --noEmit (type-check only, no emit)
npm test           # vitest run
npm run lint       # oxlint --type-aware src/
```

CI runs **typecheck → lint → test → build**. If the version in `package.json` changes on
`main`, it auto-publishes to npm with provenance and tags a release.

Requires **Node >= 26**. ESM only (`"type": "module"`).

## License

MIT
