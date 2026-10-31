# request-simul-access-cluster

To install dependencies:
A seat reservation server that stays correct when many users race for the same seat. It runs one Hono server per CPU thread on Bun
, with no database, no Redis and no memory shared between threads.

```bash
**A taken seat stays taken.** It doesn't expire, can't be released, and survives a crash. A seat is only temporary if the caller a
sks for a lease.

## Quick start

Requires [Bun](https://bun.com). The load test also needs [Rust](https://rustup.rs).

```powershell
bun install
Copy-Item .env.example .env   # then set AUTH_SECRET to 32 or more characters
$env:COOKIE_SECURE = "0"      # only for plain http on your own machine
bun run index.ts
```

To run:
Open <http://127.0.0.1:3001>. Each worker listens on its own port, starting at `BASE_PORT`.

```bash
bun run index.ts
## How it works

```text
             HTTP                     postMessage
clients ───────────► Hono worker 0 ──────────────────┐
clients ───────────► Hono worker 1 ──────────────────┤
clients ───────────► Hono worker N ──────────────
                         ▲                           ▼
                         │                  owner (main thread)
                         │                  bound
                         │                  seats, limiter, waiters
                         │                           │
                         │
                         │                  confirmed-seats.log
                         └── on("message") ──────────┘
```

This project was created using `bun init` in bun ) is a fast all-in-one JavaScript runtime.
Workers hold no seat state. They read the request, then ask the owner through `postMessage`, and the reply comes back as a `"messa
ge"` event.

1. **One writer:** the main thread owns all state, and it outlives any worker that crashes.
2. **Ordering instead of locks:** requests join oo completion, so two can't overlap. The owner's hand
lers never `await` between reading a seat and writing it.
3. **Batched durability:** the owner runs a batch, makes one `fsync`, then sends the replies. Nobody is told they own a seat until
 it would survive a crash.
4. **Bounded queue:** when the queue is full, the request gets `503` with `Retry-After`. The client retries with the same intent t
oken, so nothing runs twice.
5. **First come, first served:** users waiting on order, and a lapsed lease goes to the longest waite
r first.

Paid seats are protected by structure as well as by checks. Expiry and release only look at the lease map, and confirming a seat m
oves it out of that map, so neither can reach it.

### Crashes and shutdown

| Event | What happens |
|---|---|
| A worker crashes | The owner keeps all state, removes that worker's waiters and starts a new worker |
| The process is killed | Leases are lost, and coom the journal at boot |
| A write was cut short | The torn last line is removed at boot, because its user was never told they had the seat |
| The journal is corrupt or names an unknown seat rather than risk selling a seat twice |
| An `fsync` fails | The process exits with no reply sent, so no unsafe promise is made |
| `SIGINT`, `SIGTERM` | `/healthz` fails, waiters get `503`, in-flight requests finish, then the journal is flushed and closed |

## API

Log in with `POST /session` and a body of `{ "namse the session cookie that returns.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/session` | Log in |
| `GET` | `/session` | Show the current user |
| `DELETE` | `/session` | Log out |
| `GET` | `/healthz` | `200`, or `503` while draining |
| `POST` | `/seats/:id/intents` | Get an intent token |
| `POST` | `/seats/:id/reservations` | Take the s
| `POST` | `/seats/:id/reservations?lease=true` | Take a temporary lease |
| `POST` | `/seats/:id/payment` | Turn your lease into a confirmed seat |
| `POST` | `/seats/:id/heartbeat` | Extend your l
| `DELETE` | `/seats/:id/reservations` | Release your lease |
| `GET` | `/seats/:id/status` | Show `free`, `taken` or `mine` |

A reservation needs the token from `/intents` in an `idempotency-token` header. Add `waitMs` to queue for a seat that's taken, up
to `MAX_WAIT_MS`.

| Status | Meaning |
|---|---|
| `201` | You have the seat. A retry also adds the header `idempotent-replay: true` |
| `403` | Bad intent token, or on release, a seat|
| `409` | Someone else has the seat |
| `410` | Your lease expired before you paid |
| `429` | Rate limited |
| `503` | Server busy or shutting down, so retry with the same token |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_SECRET` | required | Signs tokens, 32 or more characters |
| `BASE_PORT` | `3001` | First worker's port |
| `WORKERS` | CPU count | Number of Hono workers |
| `SEATS` | `seat-1` | Comma-separated seat ids |
| `QUEUE_CAPACITY` | `4096` | Requests the owner
| `JOURNAL_PATH` | `confirmed-seats.log` | Durable record of confirmed seats |
| `HOLD_TTL_SECONDS` | `600` | Length of a lease
| `HOLD_MAX_SECONDS` | `1800` | Longest a lease can be extended to |
| `MAX_WAIT_MS` | `30000` | Longest a request can wait for a seat |
| `INTENT_TTL_SECONDS` | `300` | Lifetime of an i
| `RATE_CAPACITY` | `5` | Reservation attempts in a burst, per user |
| `RATE_PER_SECOND` | `1` | Rate limit refill |
| `SESSION_IDLE_SECONDS` | `600` | Session idle timeout |
| `SESSION_MAX_SECONDS` | `86400` | Absolute session limit |
| `COOKIE_SECURE` | on | Set to `0` only for local plain http |
| `DRAIN_GRACE_MS` | `1000` | Time for a proxy to see `/healthz` fail |
| `SHUTDOWN_DEADLINE_MS` | `10000` | Hard limit on draining |

`DEBUG_DELAY_MS` and `DEBUG_CRASH` are test hooks, so leave them unset in production.

To reset seats, stop the server and delete `confi

## Testing

```powershell
bun test
bunx tsc --noEmit
```

The load test starts its own server, attacks it over HTTP only, and exits non-zero if any guarantee breaks:

```powershell
cd loadtest
cargo run --release
cargo run --release -- --users 1000 --rounds 10 --seconds 10
```

It uses ports 4300-4303 by default and refuses to run if they're busy. It checks that:

- Each seat has one winner.
- Double clicks stay idempotent.
- Rate limits hold across ports.
- An expired lease goes to one waiter.
- Payment and expiry never both succeed.
- A released seat has one holder at a time.
- Confirmed seats survive a hard kill.

It also reports sustained throughput and latency.

## Limitations

- **One machine:** the owner can't span servers and has no replica, so back up the journal. Move to Redis or a database when you n
eed a second server or failover.
- **One bottleneck:** every seat operation passes through the owner thread, and writes wait for the disk.
- **Abandoned waiters:** if a client disconnects while waiting, it can still win the seat. With a plain reservation that win is pe
rmanent.
- **Payment is a stub:** with a real gateway, take a short lease first and confirm only after the charge succeeds.
- **No TLS:** workers bind to `127.0.0.1` and speroxy in front. Traffic between threads never leaves
the process.
- **Journal growth:** it's never compacted. It adt, and so does 
startup replay time.
- **Showcase project:** it can be done in several other manners including database indexes, Redis integrations, mutexes in languages like Go without workarounds -- however it goes to show that it is possible to solve this issue with little