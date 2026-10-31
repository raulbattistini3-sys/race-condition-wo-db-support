import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueIntent, issueSession, newSession } from "../src/tokens";

const secret = "test-secret-test-secret-test-secret!";
const WORKERS = 4;
let nextPort = 4100;
let cleanup: (() => Promise<void>) | null = null;

const stopCluster = async () => {
  await cleanup?.();
  cleanup = null;
};

afterEach(stopCluster);

const journalPath = () => join(mkdtempSync(join(tmpdir(), "seats-")), "confirmed.log");

async function waitForHealth(port: number) {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`port ${port} never became healthy`);
}

async function startCluster(env: Record<string, string> = {}) {
  const basePort = nextPort;
  nextPort += WORKERS;
  const proc = Bun.spawn(["bun", "index.ts"], {
    env: {
      ...process.env,
      AUTH_SECRET: secret,
      BASE_PORT: String(basePort),
      WORKERS: String(WORKERS),
      DRAIN_GRACE_MS: "100",
      JOURNAL_PATH: journalPath(),
      ...env,
    },
    stdout: "ignore",
    stderr: "ignore",
    ipc() {},
  });
  const ports = Array.from({ length: WORKERS }, (_, i) => basePort + i);
  await Promise.all(ports.map(waitForHealth));
  cleanup = async () => {
    if (proc.exitCode === null) proc.send({ type: "shutdown" });
    await Promise.race([proc.exited, Bun.sleep(5000)]);
    proc.kill();
    await proc.exited;
  };
  return { proc, ports };
}

const sessionCookie = async (user: string) =>
  `session=${await issueSession(newSession(user), secret, { idleSeconds: 600, maxSeconds: 86400 })}`;

async function request(port: number, user: string, method: string, path: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/seats/seat-1${path}`, {
    method,
    headers: { cookie: await sessionCookie(user), ...headers },
  });
}

const reserve = (port: number, user: string, intent: string, query = "") =>
  request(port, user, "POST", `/reservations${query}`, { "idempotency-token": intent });

const hold = async (port: number, user: string, query = "") =>
  reserve(port, user, await issueIntent(user, "seat-1", secret, 300), `${query ? `${query}&` : "?"}lease=true`);

const take = async (port: number, user: string) => reserve(port, user, await issueIntent(user, "seat-1", secret, 300));

async function seatState(port: number, user: string) {
  return ((await (await request(port, user, "GET", "/status")).json()) as { state: string }).state;
}

test("many users racing across four ports produce exactly one winner", async () => {
  const { ports } = await startCluster();
  const users = Array.from({ length: 200 }, (_, i) => `user-${i}`);
  const intents = await Promise.all(users.map((user) => issueIntent(user, "seat-1", secret, 300)));

  const responses = await Promise.all(users.map((user, i) => reserve(ports[i % WORKERS]!, user, intents[i]!)));
  const statuses = responses.map((response) => response.status);

  expect(statuses.filter((status) => status === 201)).toHaveLength(1);
  expect(statuses.filter((status) => status === 409)).toHaveLength(199);
  const winner = users[statuses.indexOf(201)]!;
  for (const port of ports) expect(await seatState(port, winner)).toBe("mine");
  expect(await seatState(ports[0]!, "someone-else")).toBe("taken");
}, 30_000);

test("simultaneous double clicks spend one rate token across every port", async () => {
  // The delay holds every click past the first holder check before any of them swaps.
  const { ports } = await startCluster({ RATE_CAPACITY: "1", RATE_PER_SECOND: "0.01", DEBUG_DELAY_MS: "300" });
  const intent = await issueIntent("alice", "seat-1", secret, 300);

  const responses = await Promise.all(ports.flatMap((port) => [reserve(port, "alice", intent), reserve(port, "alice", intent)]));

  expect(responses.map((response) => response.status)).toEqual(Array(WORKERS * 2).fill(201));
}, 30_000);

test("the rate limit is shared across every port", async () => {
  const seats = Array.from({ length: 40 }, (_, i) => `seat-${i}`);
  const { ports } = await startCluster({ RATE_CAPACITY: "3", RATE_PER_SECOND: "0.01", SEATS: seats.join(",") });
  const cookie = await sessionCookie("alice");

  const responses = await Promise.all(
    seats.map(async (seat, i) =>
      fetch(`http://127.0.0.1:${ports[i % WORKERS]}/seats/${seat}/reservations`, {
        method: "POST",
        headers: { cookie, "idempotency-token": await issueIntent("alice", seat, secret, 300) },
      }),
    ),
  );

  expect(responses.filter((response) => response.status === 201)).toHaveLength(3);
  expect(responses.filter((response) => response.status === 429)).toHaveLength(37);
}, 30_000);

test("a release on one port hands the seat to the longest waiter on another", async () => {
  const { ports } = await startCluster();
  await hold(ports[0]!, "alice");
  const bob = hold(ports[1]!, "bob", "?waitMs=2500");
  await Bun.sleep(100);
  const carol = hold(ports[2]!, "carol", "?waitMs=2500");
  await Bun.sleep(100);
  const dave = hold(ports[3]!, "dave", "?waitMs=2500");
  await Bun.sleep(100);

  await request(ports[0]!, "alice", "DELETE", "/reservations");
  expect((await bob).status).toBe(201);
  await request(ports[1]!, "bob", "DELETE", "/reservations");
  expect((await carol).status).toBe(201);
  expect((await dave).status).toBe(409);
}, 30_000);

test("a release on one port lets exactly one waiter win on another", async () => {
  const { ports } = await startCluster();
  await hold(ports[0]!, "alice");
  const bob = hold(ports[1]!, "bob", "?waitMs=1500");
  const carol = hold(ports[2]!, "carol", "?waitMs=1500");
  await Bun.sleep(300);

  expect((await request(ports[0]!, "alice", "DELETE", "/reservations")).status).toBe(204);

  expect([(await bob).status, (await carol).status].sort()).toEqual([201, 409]);
}, 30_000);

test("an unpaid hold expires by itself and a waiter on another port wins it", async () => {
  const { ports } = await startCluster({ HOLD_TTL_SECONDS: "2" });
  expect((await hold(ports[0]!, "alice")).status).toBe(201);

  const started = Date.now();
  const bob = await hold(ports[1]!, "bob", "?waitMs=6000");

  expect(bob.status).toBe(201);
  expect(Date.now() - started).toBeGreaterThan(900);
  expect(await seatState(ports[2]!, "bob")).toBe("mine");
  expect(await seatState(ports[3]!, "alice")).toBe("taken");
}, 30_000);

test("a heartbeat on one port keeps a hold alive past its first deadline", async () => {
  const { ports } = await startCluster({ HOLD_TTL_SECONDS: "2", HOLD_MAX_SECONDS: "60" });
  await hold(ports[0]!, "alice");

  for (const port of [ports[1]!, ports[2]!, ports[3]!]) {
    await Bun.sleep(1000);
    await request(port, "alice", "POST", "/heartbeat");
  }

  expect(await seatState(ports[0]!, "alice")).toBe("mine");
}, 30_000);

test("a paid seat outlives its deadline, and the late payer loses", async () => {
  const { ports } = await startCluster({ HOLD_TTL_SECONDS: "1" });
  await hold(ports[0]!, "alice");
  expect((await request(ports[1]!, "alice", "POST", "/payment")).status).toBe(200);
  await Bun.sleep(2300);

  expect(await seatState(ports[2]!, "alice")).toBe("mine");
  expect((await hold(ports[3]!, "bob")).status).toBe(409);
}, 30_000);

test("paying after expiry is refused with 410", async () => {
  const { ports } = await startCluster({ HOLD_TTL_SECONDS: "1" });
  await hold(ports[0]!, "alice");
  await Bun.sleep(2300);

  expect((await request(ports[1]!, "alice", "POST", "/payment")).status).toBe(410);
  expect(await seatState(ports[2]!, "alice")).toBe("free");
}, 30_000);

test("the rolling session lives on writes and dies after sitting idle", async () => {
  const { ports } = await startCluster({ SESSION_IDLE_SECONDS: "3", COOKIE_SECURE: "0" });
  const url = `http://127.0.0.1:${ports[0]}`;
  const login = await fetch(`${url}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "alice" }),
  });
  let cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  for (let i = 0; i < 3; i++) {
    await Bun.sleep(1100);
    const response = await fetch(`${url}/seats/seat-1/heartbeat`, { method: "POST", headers: { cookie } });
    expect(response.status).toBe(200);
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  }

  await Bun.sleep(3300);
  expect((await fetch(`${url}/session`, { headers: { cookie } })).status).toBe(401);
}, 30_000);

test("shutdown finishes the in-flight reservation, then refuses connections", async () => {
  const { proc, ports } = await startCluster({ DEBUG_DELAY_MS: "1000" });
  const inFlight = hold(ports[0]!, "alice");
  await Bun.sleep(300);
  proc.send({ type: "shutdown" });

  expect((await inFlight).status).toBe(201);
  expect(await proc.exited).toBe(0);
  await expect(fetch(`http://127.0.0.1:${ports[0]}/healthz`)).rejects.toThrow();
}, 30_000);

test("shutdown releases parked waiters with a 503 instead of holding them", async () => {
  const { proc, ports } = await startCluster();
  await hold(ports[0]!, "alice");
  const parked = hold(ports[1]!, "bob", "?waitMs=20000");
  await Bun.sleep(300);

  proc.send({ type: "shutdown" });

  expect((await parked).status).toBe(503);
  expect(await proc.exited).toBe(0);
}, 30_000);

test("the deadline stops a stuck worker from blocking shutdown forever", async () => {
  const { proc, ports } = await startCluster({ DEBUG_DELAY_MS: "30000", SHUTDOWN_DEADLINE_MS: "500" });
  void hold(ports[0]!, "alice").catch(() => {});
  await Bun.sleep(300);
  const started = Date.now();
  proc.send({ type: "shutdown" });
  await Promise.race([proc.exited, Bun.sleep(5000)]);

  expect(proc.exitCode).not.toBeNull();
  expect(Date.now() - started).toBeLessThan(4000);
}, 30_000);

test("a paid seat survives a hard kill and stays with its owner", async () => {
  const JOURNAL_PATH = journalPath();
  const first = await startCluster({ JOURNAL_PATH, HOLD_TTL_SECONDS: "1" });
  const alice = await sessionCookie("alice");
  await fetch(`http://127.0.0.1:${first.ports[0]}/seats/seat-1/reservations?lease=true`, {
    method: "POST",
    headers: { cookie: alice, "idempotency-token": await issueIntent("alice", "seat-1", secret, 300) },
  });
  const paid = await fetch(`http://127.0.0.1:${first.ports[1]}/seats/seat-1/payment`, { method: "POST", headers: { cookie: alice } });
  expect(paid.status).toBe(200);
  first.proc.kill(9);
  await first.proc.exited;

  const second = await startCluster({ JOURNAL_PATH, HOLD_TTL_SECONDS: "1" });
  await Bun.sleep(2300);
  const status = await fetch(`http://127.0.0.1:${second.ports[2]}/seats/seat-1/status`, { headers: { cookie: alice } });
  expect(await status.json()).toMatchObject({ state: "mine", confirmed: true });
  expect((await hold(second.ports[3]!, "bob")).status).toBe(409);
}, 30_000);

test("an unpaid reservation is definite: no expiry, no release, and it survives a hard kill", async () => {
  const JOURNAL_PATH = journalPath();
  const first = await startCluster({ JOURNAL_PATH, HOLD_TTL_SECONDS: "1" });
  expect((await take(first.ports[0]!, "alice")).status).toBe(201);
  await Bun.sleep(2300);
  expect((await request(first.ports[1]!, "alice", "DELETE", "/reservations")).status).toBe(403);
  first.proc.kill(9);
  await first.proc.exited;

  const second = await startCluster({ JOURNAL_PATH, HOLD_TTL_SECONDS: "1" });
  await Bun.sleep(2300);
  expect(await seatState(second.ports[2]!, "alice")).toBe("mine");
  expect((await take(second.ports[3]!, "bob")).status).toBe(409);
}, 30_000);

test("a torn last line is ignored, and corruption refuses to boot", async () => {
  const JOURNAL_PATH = journalPath();
  writeFileSync(JOURNAL_PATH, "seat-1 ab");
  const { ports } = await startCluster({ JOURNAL_PATH });
  expect(await seatState(ports[0]!, "alice")).toBe("free");
  expect((await take(ports[0]!, "alice")).status).toBe(201);
  await stopCluster();

  // The win landed after the torn tail, so that tail must be gone by now.
  const reopened = await startCluster({ JOURNAL_PATH });
  expect(await seatState(reopened.ports[0]!, "alice")).toBe("mine");
  await stopCluster();

  writeFileSync(JOURNAL_PATH, "seat-404 ab\n");
  const proc = Bun.spawn(["bun", "index.ts"], {
    env: { ...process.env, AUTH_SECRET: secret, JOURNAL_PATH, BASE_PORT: "4090", WORKERS: "1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await proc.exited).not.toBe(0);
}, 30_000);

test("a crashed thread comes back on its port and the winner survives", async () => {
  const { ports } = await startCluster({ DEBUG_CRASH: "1" });
  await hold(ports[0]!, "alice");

  await fetch(`http://127.0.0.1:${ports[0]}/debug/crash`, { method: "POST" }).catch(() => {});
  await Bun.sleep(300);
  await waitForHealth(ports[0]!);

  expect(await seatState(ports[0]!, "alice")).toBe("mine");
  expect(await seatState(ports[1]!, "alice")).toBe("mine");
}, 30_000);
