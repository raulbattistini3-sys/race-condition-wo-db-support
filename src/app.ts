import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { SeatsUnavailable, type SeatClient } from "./seat-client";
import type { Reservation } from "./owner";
import {
  bucketSlot,
  issueIntent,
  issueSession,
  newSession,
  ownerHash,
  readIntent,
  readSession,
  sessionExpiry,
  type Session,
  type SessionTimes,
} from "./tokens";

const COOKIE = "session";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 64;

export interface AppState {
  draining: boolean;
  inFlight: number;
}

interface AppOptions {
  seats: SeatClient;
  secret: string;
  intentTtlSeconds: number;
  maxWaitMs: number;
  session: SessionTimes;
  cookieSecure: boolean;
  state: AppState;
  debugDelayMs?: number;
  debugCrash?: boolean;
}

type Env = { Variables: { session: Session; sessionExp: number } };

export function createApp(options: AppOptions) {
  const { seats, secret, intentTtlSeconds, maxWaitMs, session, cookieSecure, state, debugDelayMs = 0, debugCrash } = options;
  const app = new Hono<Env>();

  const writeSession = async (c: Parameters<typeof deleteCookie>[0], value: Session) => {
    setCookie(c, COOKIE, await issueSession(value, secret, session), {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "Strict",
      path: "/",
      maxAge: session.idleSeconds,
    });
    return sessionExpiry(value, session);
  };

  app.onError((error, c) => {
    if (!(error instanceof SeatsUnavailable)) throw error;
    c.header("retry-after", "1");
    return c.json({ error: "busy" }, 503);
  });

  const secondsLeft = (exp: number) => Math.max(0, exp - Math.floor(Date.now() / 1000));

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "body_too_large" }, 413) }));

  // SameSite stops the cookie travelling cross-site; this catches what it misses.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && origin && URL.parse(origin)?.host !== c.req.header("host")) {
      return c.json({ error: "bad_origin" }, 403);
    }
    await next();
  });

  app.get("/healthz", (c) =>
    state.draining ? c.json({ status: "draining" }, 503) : c.json({ status: "ok" }),
  );

  if (debugCrash) app.post("/debug/crash", () => process.exit(1));

  app.use("/seats/*", async (c, next) => {
    if (state.draining) {
      c.header("connection", "close");
      c.header("retry-after", "1");
      return c.json({ error: "shutting_down" }, 503);
    }
    state.inFlight++;
    try {
      await next();
    } finally {
      state.inFlight--;
    }
  });

  // The user only ever comes from the signed session, never from the body or token claims.
  // Only non-GET requests roll it, so a polling tab left idle still times out.
  const authenticated = async (c: Parameters<typeof deleteCookie>[0], next: () => Promise<void>) => {
    const current = await readSession(getCookie(c, COOKIE) ?? "", secret);
    if (!current) {
      deleteCookie(c, COOKIE, { path: "/" });
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("session", current);
    c.set("sessionExp", c.req.method === "GET" ? current.exp : await writeSession(c, current));
    await next();
  };

  app.use("/seats/*", authenticated);
  app.get("/session", authenticated);
  app.delete("/session", authenticated);

  app.post("/session", async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = body?.name;
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return c.json({ error: "invalid_name" }, 400);
    }
    const exp = await writeSession(c, newSession(name));
    return c.json({ user: name, expiresInSeconds: secondsLeft(exp) }, 201);
  });

  app.get("/session", (c) =>
    c.json({ user: c.get("session").sub, expiresInSeconds: secondsLeft(c.get("sessionExp")) }),
  );

  app.delete("/session", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  app.use("/seats/:id/*", async (c, next) => {
    if (!seats.has(c.req.param("id"))) return c.json({ error: "seat_not_found" }, 404);
    await next();
  });

  const ownerFor = (userId: string, seat: string) => ownerHash(userId, seat, secret);

  app.post("/seats/:id/intents", async (c) => {
    const token = await issueIntent(c.get("session").sub, c.req.param("id"), secret, intentTtlSeconds);
    return c.json({ intent: token }, 201);
  });

  app.get("/seats/:id/status", async (c) => {
    const seat = c.req.param("id");
    return c.json({ seat, ...(await seats.view(seat, ownerFor(c.get("session").sub, seat))) });
  });

  app.post("/seats/:id/heartbeat", async (c) => {
    const seat = c.req.param("id");
    const view = await seats.heartbeat(seat, ownerFor(c.get("session").sub, seat));
    return c.json({ seat, ...view, sessionExpiresInSeconds: secondsLeft(c.get("sessionExp")) });
  });

  app.post("/seats/:id/reservations", async (c) => {
    const userId = c.get("session").sub;
    const seat = c.req.param("id");
    const intent = await readIntent(c.req.header("idempotency-token") ?? "", secret);
    if (!intent || intent.sub !== userId || intent.seat !== seat) {
      return c.json({ error: "invalid_intent" }, 403);
    }

    const owner = ownerFor(userId, seat);
    const won = (replayed: boolean, view: Reservation["view"]) => {
      if (replayed) c.header("idempotent-replay", "true");
      return c.json({ result: "won", ...view, seat }, 201);
    };

    const current = await seats.view(seat, owner);
    if (current.state === "mine") return won(true, current);

    if (debugDelayMs) await Bun.sleep(debugDelayMs);

    const admission = await seats.admit(seat, bucketSlot(userId, secret), owner);
    if (!admission.allowed) {
      c.header("retry-after", String(admission.retryAfterSeconds));
      return c.json({ error: "rate_limited" }, 429);
    }

    const lease = c.req.query("lease") === "true";
    const waitMs = Math.min(Number(c.req.query("waitMs")) || 0, maxWaitMs);
    const { result, view } = await seats.reserve(seat, owner, lease, waitMs);
    if (result === "draining") {
      c.header("retry-after", "1");
      return c.json({ error: "shutting_down" }, 503);
    }
    return result === "taken" ? c.json({ seat, result: "taken" }, 409) : won(result === "replay", view);
  });

  app.post("/seats/:id/payment", async (c) => {
    const seat = c.req.param("id");
    const payment = await seats.pay(seat, ownerFor(c.get("session").sub, seat));
    if (payment === "expired") return c.json({ error: "hold_expired" }, 410);
    if (payment === "replay") c.header("idempotent-replay", "true");
    return c.json({ seat, result: "paid" });
  });

  app.delete("/seats/:id/reservations", async (c) => {
    const seat = c.req.param("id");
    const released = await seats.release(seat, ownerFor(c.get("session").sub, seat));
    return released ? c.body(null, 204) : c.json({ error: "not_holder" }, 403);
  });

  app.use("/*", serveStatic({ root: "./public" }));

  return app;
}
