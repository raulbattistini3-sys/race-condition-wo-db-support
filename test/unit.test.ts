import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createApp } from "../src/app";
import { createLimiter } from "../src/limiter";
import { createOwner, type MessageLink } from "../src/owner";
import { createSeatClient } from "../src/seat-client";
import { createSharedState } from "../src/shared";
import { bucketSlot, issueIntent, issueSession, newSession, ownerHash, type SessionTimes } from "../src/tokens";

const secret = "test-secret-test-secret-test-secret!";
const times: SessionTimes = { idleSeconds: 600, maxSeconds: 86400 };
const hold = { holdTtlSeconds: 600, holdMaxSeconds: 1800 };
const T0 = Date.now();
const minutes = (n: number) => T0 + n * 60_000;

// Two emitters wired like a port pair, so tests cross the same "message" path as threads.
function links(): [MessageLink, MessageLink] {
  const a = new EventEmitter();
  const b = new EventEmitter();
  const link = (self: EventEmitter, other: EventEmitter) =>
    Object.assign(self, { postMessage: (message: unknown) => other.emit("message", message) }) as unknown as MessageLink;
  return [link(a, b), link(b, a)];
}

function setup(capacity = 5, perSecond = 1, sessionTimes = times) {
  const limiter = createLimiter(createSharedState(), { capacity, perSecond });
  const hub = createOwner(["seat-1"], hold, { append() {} }, limiter, 64);
  const [workerSide, ownerSide] = links();
  hub.connect(ownerSide);
  const state = { draining: false, inFlight: 0 };
  const app = createApp({
    seats: createSeatClient(["seat-1"], workerSide), secret, intentTtlSeconds: 300, maxWaitMs: 1000, session: sessionTimes, cookieSecure: true, state,
  });
  return { app, limiter, seats: hub.seats, state };
}

const cookie = async (user: string, sessionTimes = times) =>
  `session=${await issueSession(newSession(user), secret, sessionTimes)}`;

async function post(app: ReturnType<typeof setup>["app"], user: string, intent: string, seat = "seat-1") {
  return app.request(`/seats/${seat}/reservations`, {
    method: "POST",
    headers: { cookie: await cookie(user), "idempotency-token": intent },
  });
}

const owner = (user: string) => ownerHash(user, "seat-1", secret);

test("take grants the capacity, denies, then refills", () => {
  const { limiter } = setup(2, 1);
  expect(limiter.take(7, 1_000).allowed).toBe(true);
  expect(limiter.take(7, 1_000).allowed).toBe(true);
  expect(limiter.take(7, 1_000)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  expect(limiter.take(7, 2_000).allowed).toBe(true);
});

test("a denied take does not push the refill back", () => {
  const { limiter } = setup(1, 1);
  limiter.take(7, 1_000);
  for (let now = 1_100; now < 2_000; now += 100) expect(limiter.take(7, now).allowed).toBe(false);
  expect(limiter.take(7, 2_000).allowed).toBe(true);
});

test("a clock moving backwards never mints tokens", () => {
  const { limiter } = setup(1, 1);
  limiter.take(7, 10_000);
  expect(limiter.take(7, 1_000).allowed).toBe(false);
});

test("admit charges an attempt once, and only a denied attempt can try again", () => {
  const { limiter } = setup(1, 1);
  expect(limiter.admit(7, 11n, 1_000).allowed).toBe(true);
  expect(limiter.admit(7, 11n, 1_000).allowed).toBe(true);
  expect(limiter.admit(7, 22n, 1_000).allowed).toBe(false);
  expect(limiter.admit(7, 22n, 2_000).allowed).toBe(true);
});

test("one claim wins and its retry is recognised", () => {
  const { seats } = setup();
  expect(seats.claim("seat-1", owner("alice"), T0, true)).toBe("won");
  expect(seats.claim("seat-1", owner("bob"), T0, true)).toBe("taken");
  expect(seats.claim("seat-1", owner("alice"), T0, true)).toBe("replay");
});

test("a seat is taken for good unless a lease is asked for", () => {
  const { seats } = setup();
  expect(seats.claim("seat-1", owner("alice"), T0)).toBe("won");
  expect(seats.view("seat-1", owner("alice"), minutes(100))).toEqual({ state: "mine", confirmed: true, expiresInSeconds: null });

  seats.sweep(minutes(100));
  expect(seats.claim("seat-1", owner("bob"), minutes(100), true)).toBe("taken");
  expect(seats.release("seat-1", owner("alice"), minutes(100))).toBe(false);
});

test("a waiter on a confirmed seat is told at once instead of parking", async () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"));
  const started = Date.now();
  expect(await seats.wait("seat-1", owner("bob"), 60_000)).toBe("taken");
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a waiter keeps its own terms when a lease frees up", async () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), Date.now(), true);
  const parked = seats.wait("seat-1", owner("bob"), 1000);
  const late = seats.wait("seat-1", owner("carol"), 60_000);
  seats.release("seat-1", owner("alice"));

  expect(await parked).toBe("won");
  expect(await late).toBe("taken");
  expect(seats.view("seat-1", owner("bob"))).toEqual({ state: "mine", confirmed: true, expiresInSeconds: null });
});

test("a reservation is journaled only when it is definite", async () => {
  const appended: string[] = [];
  const limiter = createLimiter(createSharedState(), { capacity: 5, perSecond: 1 });
  const hub = createOwner(["seat-1"], hold, { append: (entries) => appended.push(...entries.map(([seat]) => seat)) }, limiter, 64);
  const seats = hub.seats;
  const [workerSide, ownerSide] = links();
  hub.connect(ownerSide);
  const app = createApp({
    seats: createSeatClient(["seat-1"], workerSide), secret,
    intentTtlSeconds: 300, maxWaitMs: 1000, session: times, cookieSecure: true, state: { draining: false, inFlight: 0 },
  });
  const reserve = async (user: string, query: string) =>
    app.request(`/seats/seat-1/reservations${query}`, {
      method: "POST",
      headers: { cookie: await cookie(user), "idempotency-token": await issueIntent(user, "seat-1", secret, 300) },
    });

  const leased = await reserve("alice", "?lease=true");
  expect(await leased.json()).toMatchObject({ confirmed: false, expiresInSeconds: 600 });
  expect(appended).toEqual([]);

  seats.release("seat-1", owner("alice"));
  const definite = await reserve("bob", "");
  expect(await definite.json()).toMatchObject({ confirmed: true, expiresInSeconds: null });
  expect(appended).toEqual(["seat-1"]);
});

test("a hold lapses after ten minutes and a claim beats the sweeper to it", () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), T0, true);
  expect(seats.view("seat-1", owner("alice"), minutes(9.9))).toMatchObject({ state: "mine" });
  expect(seats.claim("seat-1", owner("bob"), minutes(9.9), true)).toBe("taken");
  expect(seats.view("seat-1", owner("alice"), minutes(10))).toEqual({ state: "free" });
  expect(seats.claim("seat-1", owner("bob"), minutes(10), true)).toBe("won");
  expect(seats.view("seat-1", owner("bob"), minutes(10))).toMatchObject({ state: "mine", expiresInSeconds: 600 });
});

test("the sweeper hands an expired hold to the first waiter, once", async () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), Date.now(), true);
  const parked = seats.wait("seat-1", owner("bob"), 1000);
  seats.sweep(Date.now() + 599_000);
  expect(seats.view("seat-1", owner("alice"))).toMatchObject({ state: "mine" });
  seats.sweep(Date.now() + 600_000);
  seats.sweep(Date.now() + 600_000);
  expect(await parked).toBe("won");
});

test("heartbeats roll the hold, but never past the absolute cap", () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), T0, true);
  for (const at of [9, 18, 27]) expect(seats.heartbeat("seat-1", owner("alice"), minutes(at))).toBe(true);
  expect(seats.view("seat-1", owner("alice"), minutes(29.9))).toMatchObject({ state: "mine", expiresInSeconds: 6 });
  expect(seats.heartbeat("seat-1", owner("alice"), minutes(29.9))).toBe(true);
  expect(seats.view("seat-1", owner("alice"), minutes(30))).toEqual({ state: "free" });
});

test("a heartbeat cannot revive an expired hold or touch someone else's", () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), T0, true);
  expect(seats.heartbeat("seat-1", owner("bob"), minutes(1))).toBe(false);
  expect(seats.heartbeat("seat-1", owner("alice"), minutes(10))).toBe(false);
});

test("a paid seat never expires and cannot be released or sold again", () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), T0, true);
  expect(seats.pay("seat-1", owner("alice"), minutes(9))).toBe("paid");
  expect(seats.pay("seat-1", owner("alice"), minutes(9))).toBe("replay");

  seats.sweep(minutes(100));
  expect(seats.view("seat-1", owner("alice"), minutes(100))).toEqual({ state: "mine", confirmed: true, expiresInSeconds: null });
  expect(seats.claim("seat-1", owner("bob"), minutes(100), true)).toBe("taken");
  expect(seats.release("seat-1", owner("alice"), minutes(100))).toBe(false);
});

test("paying after expiry fails even if the sweeper has not run", () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), T0, true);
  expect(seats.pay("seat-1", owner("alice"), minutes(10))).toBe("expired");
  expect(seats.pay("seat-1", owner("bob"), minutes(1))).toBe("expired");
});

test("a late payer loses to the next holder", () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), T0, true);
  seats.claim("seat-1", owner("bob"), minutes(10), true);
  expect(seats.pay("seat-1", owner("alice"), minutes(10))).toBe("expired");
  expect(seats.pay("seat-1", owner("bob"), minutes(10))).toBe("paid");
});

test("only the holder can release", () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), T0, true);
  expect(seats.release("seat-1", owner("bob"), T0)).toBe(false);
  expect(seats.release("seat-1", owner("alice"), T0)).toBe(true);
});

test("a release wakes a parked loser", async () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), Date.now(), true);
  const parked = seats.wait("seat-1", owner("bob"), 1000);

  seats.release("seat-1", owner("alice"));

  expect(await parked).toBe("won");
});

test("a waiter times out as taken, and draining settles waiters at once", async () => {
  const { seats } = setup();
  seats.claim("seat-1", owner("alice"), Date.now(), true);
  expect(await seats.wait("seat-1", owner("bob"), 20)).toBe("taken");
  const parked = seats.wait("seat-1", owner("carol"), 60_000);
  seats.drain();
  expect(await parked).toBe("draining");
});

test("session cookies are HttpOnly, Secure and SameSite=Strict", async () => {
  const { app } = setup();
  const response = await app.request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "alice" }),
  });
  const setCookie = response.headers.get("set-cookie")!;
  expect(response.status).toBe(201);
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Max-Age=600");
});

test("a write rolls the session, and a read does not", async () => {
  const { app } = setup();
  const headers = { cookie: await cookie("alice") };
  const read = await app.request("/seats/seat-1/status", { headers });
  const write = await app.request("/seats/seat-1/heartbeat", { method: "POST", headers });
  expect(read.headers.get("set-cookie")).toBeNull();
  expect(write.headers.get("set-cookie")).toContain("session=");
});

test("the session cap stops rolling however active the user is", async () => {
  const { app } = setup(5, 1, { idleSeconds: 600, maxSeconds: 100 });
  const old = { ...newSession("alice"), start: Math.floor(Date.now() / 1000) - 90 };
  const response = await app.request("/seats/seat-1/heartbeat", {
    method: "POST",
    headers: { cookie: `session=${await issueSession(old, secret, { idleSeconds: 600, maxSeconds: 100 })}` },
  });
  expect(((await response.json()) as { sessionExpiresInSeconds: number }).sessionExpiresInSeconds).toBeLessThanOrEqual(10);
});

test("an expired or forged session is refused", async () => {
  const { app } = setup();
  const expired = await issueSession(newSession("alice"), secret, { idleSeconds: -1, maxSeconds: 100 });
  const forged = await issueSession(newSession("alice"), "x".repeat(40), times);
  for (const value of [expired, forged, "garbage"]) {
    const response = await app.request("/seats/seat-1/status", { headers: { cookie: `session=${value}` } });
    expect(response.status).toBe(401);
  }
});

test("an intent token cannot pass as a session", async () => {
  const { app } = setup();
  const intent = await issueIntent("alice", "seat-1", secret, 300);
  const response = await app.request("/seats/seat-1/status", { headers: { cookie: `session=${intent}` } });
  expect(response.status).toBe(401);
});

test("a cross-origin write is refused", async () => {
  const { app } = setup();
  const response = await app.request("http://seats.test/seats/seat-1/heartbeat", {
    method: "POST",
    headers: { cookie: await cookie("alice"), origin: "https://evil.test", host: "seats.test" },
  });
  expect(response.status).toBe(403);
});

test("a same-origin write is accepted", async () => {
  const { app } = setup();
  const response = await app.request("http://seats.test/seats/seat-1/heartbeat", {
    method: "POST",
    headers: { cookie: await cookie("alice"), origin: "http://seats.test", host: "seats.test" },
  });
  expect(response.status).toBe(200);
});

test("hostile login bodies are rejected or stay plain data", async () => {
  const { app } = setup();
  const login = (body: string) =>
    app.request("/session", { method: "POST", headers: { "content-type": "application/json" }, body });

  expect((await login("not json")).status).toBe(400);
  expect((await login(JSON.stringify({ name: "" }))).status).toBe(400);
  expect((await login(JSON.stringify({ name: { $ne: null } }))).status).toBe(400);
  expect((await login(JSON.stringify({ name: "a".repeat(65) }))).status).toBe(400);
  expect((await login(JSON.stringify({ name: "a".repeat(20_000) }))).status).toBe(413);

  const payload = `<img src=x onerror=alert(1)>`;
  const response = await login(JSON.stringify({ name: payload }));
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({ user: payload });
});

test("a user field in the body cannot choose the winner", async () => {
  const { app, seats } = setup();
  const intent = await issueIntent("alice", "seat-1", secret, 300);
  await app.request("/seats/seat-1/reservations", {
    method: "POST",
    headers: { cookie: await cookie("alice"), "idempotency-token": intent, "content-type": "application/json" },
    body: JSON.stringify({ user: "mallory", sub: "mallory", owner: "1" }),
  });
  expect(seats.view("seat-1", owner("alice"))).toMatchObject({ state: "mine" });
  expect(seats.view("seat-1", owner("mallory"))).toEqual({ state: "taken" });
});

test("the page ships a strict CSP and its scripts load from files", async () => {
  const { app } = setup();
  const response = await app.request("/");
  const csp = response.headers.get("content-security-policy")!;
  expect(response.status).toBe(200);
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe-inline");
  expect(await response.text()).toContain(`<script src="/app.js" defer>`);
});

test("a double click replays the win without spending a rate token", async () => {
  const { app } = setup(1, 0.001);
  const intent = await issueIntent("alice", "seat-1", secret, 300);

  const first = await post(app, "alice", intent);
  const second = await post(app, "alice", intent);

  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(second.headers.get("idempotent-replay")).toBe("true");
});

test("a stolen intent is useless to another session", async () => {
  const { app, seats } = setup();
  const stolen = await issueIntent("alice", "seat-1", secret, 300);
  expect((await post(app, "mallory", stolen)).status).toBe(403);
  expect(seats.view("seat-1", owner("alice"))).toEqual({ state: "free" });
});

test("expired, forged and session tokens are rejected as intents", async () => {
  const { app } = setup();
  expect((await post(app, "alice", await issueIntent("alice", "seat-1", secret, -1))).status).toBe(403);
  expect((await post(app, "alice", await issueIntent("alice", "seat-1", "x".repeat(40), 300))).status).toBe(403);
  expect((await post(app, "alice", await issueSession(newSession("alice"), secret, times))).status).toBe(403);
});

test("a rate-limited attempt can still win with the same intent later", async () => {
  const { app, limiter } = setup(1, 2);
  limiter.take(bucketSlot("alice", secret), Date.now());
  const intent = await issueIntent("alice", "seat-1", secret, 300);

  expect((await post(app, "alice", intent)).status).toBe(429);
  await Bun.sleep(600);
  expect((await post(app, "alice", intent)).status).toBe(201);
});

test("an unknown seat is a 404, even with a valid intent", async () => {
  const { app } = setup();
  expect((await post(app, "alice", await issueIntent("alice", "nope", secret, 300), "nope")).status).toBe(404);
});

test("draining refuses new work but keeps health honest", async () => {
  const { app, state } = setup();
  state.draining = true;
  expect((await app.request("/healthz")).status).toBe(503);
  expect((await post(app, "alice", "x")).status).toBe(503);
});
