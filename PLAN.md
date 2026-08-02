# @browsercore/transport — Implementation Plan

This package is the foundation everything else builds on. Implement in this order;
each step is independently testable.

## Step 1 — DNS resolution (DONE)

`resolveHost()` is implemented and tested. The `lookup` parameter is injectable so
higher layers can supply DNS-over-HTTPS later without changing this code.

## Step 2 — Socket wiring + lifecycle state machine

Implement `connect()` and `TcpTransport`:

1. Call `resolveHost()` to get the address.
2. Open a `net.Socket` via `net.connect({ host, port, ...socketOptions })`.
3. Drive `TransportState` through `connecting → open → closing → closed`.
4. Set `noDelay` by default (protocol stacks want low latency).
5. Implement `connectTimeoutMs` — reject with `ConnectTimeoutError` if the socket
   does not emit `connect` in time.

Tests: use a real `net.Server` loopback on an ephemeral port. Assert state transitions
and that `connectTimeoutError` fires when the server never accepts.

## Step 3 — Read path + buffering

The socket delivers data in chunks via `"data"` events. `Transport` must:

1. Buffer incoming bytes in a `Uint8Array` growable buffer (or a deque of chunks).
2. `read()` resolves with the next available chunk (FIFO) — or, for a streaming API,
   emit `"data"` events and let callers consume.
3. Handle `"end"` from the remote → transition to `closed` with `remote_close`.

Tests: server writes known bytes; client reads them back in order. Verify ordering is
preserved across multiple small writes.

## Step 4 — Write path + backpressure

1. `write(data)` calls `socket.write(data)` and resolves on the `drain`-style callback.
2. If `socket.write()` returns `false` (kernel buffer full), wait for `"drain"` before
   resolving the promise — this is backpressure propagation.
3. Track an in-flight write queue so high layers can await backpressure.

Tests: write a payload larger than the kernel buffer; assert the promise does not
resolve until the server reads (drain).

## Step 5 — Timeouts + error mapping

1. `idleTimeoutMs`: reset a timer on every byte in/out; fire `IdleTimeoutError` and
   close if it elapses.
2. Map socket `"error"` events to typed errors and transition state to `closed` with
   the `error` reason.
3. Ensure `close()` is idempotent and resolves once even if called multiple times.

Tests:
- Connect then never send data → `IdleTimeoutError` fires.
- Server resets connection → client sees `closed` with `error` reason.
- Double `close()` resolves once.

## Step 6 — Observability seam

1. Emit structured events (`"data"`, `"close"`, `"error"`) so devtools can subscribe.
2. Include `TransportId` in every event for correlation.

No new public types needed — this is purely additive.

## Definition of done

- [ ] `connect()` succeeds against a loopback server.
- [ ] Read/write preserve byte order.
- [ ] Backpressure propagates (write awaits drain).
- [ ] All timeouts fire with typed errors.
- [ ] State machine reaches a `closed` terminal state in every path.
- [ ] Every test in `tests/` passes; `tsc --build` is clean.
