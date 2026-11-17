# @browsercore/transport

[![npm version](https://img.shields.io/npm/v/@browsercore/transport)](https://www.npmjs.com/package/@browsercore/transport)
[![CI](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-transport/ci.yml?label=ci)](https://github.com/jverneuer/browsercore-transport/actions/workflows/ci.yml)

@browsercore/transport abstracts socket management, DNS resolution, connection lifecycle, backpressure, and timeouts behind a small, strongly typed interface. It deliberately knows nothing about TLS, HTTP, QUIC, proxies, or browser fingerprinting, making it the foundation on which higher protocol layers are built. This package forms the lowest layer of the BrowserCore networking stack.

This package contains **zero `node:*` imports** in `src/`. The event backend
is injected via `TransportOptions.events`, a composable `EventProvider` that
decouples the transport from `node:events`. Time and timers are injected via
`TransportOptions.clock`, the canonical `Clock` from `@browsercore/contracts`
(see [The clock seam](#the-clock-seam-deterministic-time)).

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

## The clock seam (deterministic time)

Every timer this package arms (the connect timeout, the happy-eyeballs
per-attempt fallback cap, idle eviction, the per-read deadline) and every
timestamp it mints (correlation ids) runs through the **canonical `Clock`
contract** from `@browsercore/contracts` (`src/time.ts`), never through bare
`setTimeout`/`Date.now`. The same contract supersedes the former
package-local clock shapes in tls/http1/http2/http3/quic.

```ts
export interface Clock {
    now(): number;                                  // wall time (epoch ms), ids and logs
    monotonic(): number;                            // ms, never backwards, for deadlines
    sleep(ms: number): Promise<void>;               // setTimeout-as-sleep replacement
    setTimeout(ms: number, fn: () => void): TimerHandle;
    clearTimeout(handle: TimerHandle): void;        // TimerHandle = opaque object
}
```

Pass `clock` in `TransportOptions` (both `connect()` and
`TcpTransport.create()` accept it). Omit it and the transport runs on the
exported `systemClock` default, which delegates to the platform globals
(`Date.now()`, `performance.now()`, `setTimeout`), behavior identical to
earlier versions. Composition roots that assemble a `Platform` can thread
`platform.time` straight through: the field is already the `Clock` contract.

Unit contract honored throughout this package:

- **`monotonic()` for elapsed/deadline math**: the connect budget, the
  300 ms non-final fallback cap, and the `remaining` recomputation all read
  the monotonic clock, so an NTP wall-clock step mid-connect can neither
  fire the timeout early nor stretch the budget.
- **`now()` only where wall time is semantically required**, for correlation-id
  minting (`connect()` ids are `transport_${clock.now().toString(36)}`).
- **`TimerHandle` is opaque**: timer tokens are `object`, killing what the
  runtime-coupling audit flagged as the polyrepo's only `NodeJS.Timeout`
  leak into published `.d.ts` (`src/timers.ts` used to annotate its handles
  with it).

### Deterministic testing

Inject a manual-advance `Clock` and every lifecycle timeout becomes an exact
virtual instant. No real timers, no sleeps, no flakiness at boundary values:

```ts
import { connect, systemClock } from "@browsercore/transport";
import type { Clock, TimerHandle } from "@browsercore/transport";

class ManualClock implements Clock {
    /* now()/monotonic() return counters; advance(ms) fires due timers */
}

const clock = new ManualClock();
const attempt = connect({ host: "hang.example", port: 443,
    connectTimeoutMs: 5_000, net, dns, events, clock });

clock.advance(4_999);               // still pending, exactly
clock.advance(1);                   // ConnectTimeoutError, "timed out after 5000ms"
```

The package's own suite exercises both sides: the pre-existing tests run on
the default `systemClock` (real platform timers), while
`tests/deterministic-clock.test.ts` drives connect timeouts, idle eviction,
and read deadlines at exact virtual deadlines, including a wall-clock-jump
simulation proving deadline math ignores `now()`.

## Public API

| Export | Kind | Purpose |
| --- | --- | --- |
| `connect()` | function | Resolve DNS and establish a TCP transport |
| `resolveHost()` | function | Resolve a host to an address (injectable lookup) |
| `TcpTransport` | class | Concrete `Transport` implementation |
| `Transport` | interface | Public contract higher layers depend on (extends `EventProvider`) |
| `TransportOptions` | interface | Options for `connect()` (timeouts, IPv6, DNS, no-delay, events, clock) |
| `TransportState` | discriminated union | `connecting \| open \| closing \| closed` |
| `CloseReason` | discriminated union | Why a transport closed (`client_close`, `remote_close`, `error`, `timeout`) |
| `ResolvedAddress` | interface | Address family + IP returned by `resolveHost()` |
| `TransportError` | class | Base typed error (with `details` and `cause`) |
| `ConnectTimeoutError` | class | Connection timed out |
| `DnsResolutionError` | class | DNS lookup failed |
| `IdleTimeoutError` | class | No data flowed within the idle timeout |
| `ReadTimeoutError` | class | A `read()` saw no data within the per-read timeout |
| `systemClock` | const | Default `Clock`, platform globals (`Date.now`, `performance.now`, `setTimeout`) |
| `Clock` / `TimerHandle` | interface / type | Canonical time contract re-exported from `@browsercore/contracts` |


## Package Dependencies

```
@browsercore/transport
├── node:net   (injected via TransportOptions.net)
├── node:dns   (injected via TransportOptions.dns)
├── (event backend injected via TransportOptions.events, no node:events import)
└── (time + timers injected via TransportOptions.clock, no bare setTimeout/Date.now)
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

## Contributing

Contributions are welcome: bug reports, reproductions, docs and code alike. Start with [CONTRIBUTING.md](CONTRIBUTING.md); the full guide lives in the [browsersmith repo](https://github.com/jverneuer/browsersmith/blob/main/CONTRIBUTING.md). First timer? Check the [`good first issue`](https://github.com/jverneuer/browsercore-transport/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label. Security issues: [SECURITY.md](SECURITY.md), never a public issue.

## License

MIT
