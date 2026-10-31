import { availableParallelism } from "node:os";

function number(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters");
  return value;
}

export const config = {
  authSecret: secret(),
  host: "127.0.0.1",
  basePort: number("BASE_PORT", 3001),
  workers: number("WORKERS", availableParallelism()) || 1,
  seats: (process.env.SEATS ?? "seat-1").split(","),
  intentTtlSeconds: number("INTENT_TTL_SECONDS", 300),
  rateCapacity: number("RATE_CAPACITY", 5),
  ratePerSecond: number("RATE_PER_SECOND", 1),
  maxWaitMs: number("MAX_WAIT_MS", 30000),
  // Requests the owner will hold before refusing with a 503.
  queueCapacity: number("QUEUE_CAPACITY", 4096) || 1,
  sessionIdleSeconds: number("SESSION_IDLE_SECONDS", 600),
  sessionMaxSeconds: number("SESSION_MAX_SECONDS", 86400),
  holdTtlSeconds: number("HOLD_TTL_SECONDS", 600),
  // Stops a holder rolling a hold forever without paying.
  holdMaxSeconds: number("HOLD_MAX_SECONDS", 1800),
  journalPath: process.env.JOURNAL_PATH ?? "confirmed-seats.log",
  // Set COOKIE_SECURE=0 only for plain http on a local machine.
  cookieSecure: process.env.COOKIE_SECURE !== "0",
  // Time for the proxy to see /healthz fail before the listener closes.
  drainGraceMs: number("DRAIN_GRACE_MS", 1000),
  // Hard limit on waiting for in-flight requests.
  shutdownDeadlineMs: number("SHUTDOWN_DEADLINE_MS", 10000),
  // Test hooks: hold each reservation open, and expose a route that kills the thread.
  debugDelayMs: number("DEBUG_DELAY_MS", 0),
  debugCrash: process.env.DEBUG_CRASH === "1",
};
