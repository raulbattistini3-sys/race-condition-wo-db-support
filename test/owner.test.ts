import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFifo } from "../src/fifo";
import { openJournal, readConfirmed } from "../src/journal";
import { createOwner, type MessageLink, type SeatReply, type SeatRequest } from "../src/owner";
import { createSeatClient, SeatsUnavailable } from "../src/seat-client";

const hold = { holdTtlSeconds: 600, holdMaxSeconds: 1800 };
const limiter = { admit: () => ({ allowed: true as const }) };
const noJournal = { append() {} };

function link() {
  const emitter = new EventEmitter();
  const sent: SeatReply[] = [];
  const port = Object.assign(emitter, { postMessage: (reply: SeatReply) => sent.push(reply) }) as unknown as MessageLink & EventEmitter;
  return { port, sent, send: (request: SeatRequest) => port.emit("message", request) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the queue keeps order, wraps around, and refuses past its size", () => {
  const fifo = createFifo<number>(2);
  expect([fifo.push(1), fifo.push(2), fifo.push(3)]).toEqual([true, true, false]);
  expect(fifo.shift()).toBe(1);
  expect(fifo.push(3)).toBe(true);
  expect([fifo.shift(), fifo.shift(), fifo.shift()]).toEqual([2, 3, undefined]);
  expect(fifo.size).toBe(0);
});

test("a full queue answers busy at once and the queued requests still run", async () => {
  const owner = createOwner(["seat-1"], hold, noJournal, limiter, 2);
  const { port, sent, send } = link();
  owner.connect(port);
  for (const id of [1, 2, 3]) send({ id, type: "view", seat: "seat-1", owner: 1n });
  expect(sent).toEqual([{ id: 3, error: "busy" }]);
  await tick();
  expect(sent.map((reply) => reply.id)).toEqual([3, 1, 2]);
});

test("requests from every worker run in arrival order", async () => {
  const owner = createOwner(["seat-1"], hold, noJournal, limiter, 8);
  const [first, second] = [link(), link()];
  owner.connect(first.port);
  owner.connect(second.port);
  second.send({ id: 1, type: "reserve", seat: "seat-1", owner: 2n, lease: false, waitMs: 0 });
  first.send({ id: 2, type: "reserve", seat: "seat-1", owner: 1n, lease: false, waitMs: 0 });
  await tick();
  expect(second.sent[0]).toMatchObject({ id: 1, result: { result: "won" } });
  expect(first.sent[0]).toMatchObject({ id: 2, result: { result: "taken" } });
});

test("a batch shares one fsync and no reply leaves before it", async () => {
  const order: string[] = [];
  const owner = createOwner(["a", "b", "c"], hold, { append: (entries) => order.push(`sync ${entries.length}`) }, limiter, 8);
  const { port, send } = link();
  port.postMessage = () => order.push("reply");
  owner.connect(port);
  ["a", "b", "c"].forEach((seat, i) => send({ id: i, type: "reserve", seat, owner: 1n, lease: false, waitMs: 0 }));
  await tick();
  expect(order).toEqual(["sync 3", "reply", "reply", "reply"]);
});

test("a waiter who wins on a sweep is synced before it hears", async () => {
  const order: string[] = [];
  const owner = createOwner(["seat-1"], { holdTtlSeconds: 0, holdMaxSeconds: 0 }, { append: () => order.push("sync") }, limiter, 8);
  owner.seats.claim("seat-1", 1n, Date.now(), true);
  const { port, send } = link();
  port.postMessage = () => order.push("reply");
  owner.connect(port);
  send({ id: 1, type: "reserve", seat: "seat-1", owner: 2n, lease: false, waitMs: 1000 });
  await tick();
  await tick();
  expect(order).toEqual(["sync", "reply"]);
});

test("paying takes the seat out of the lease map at once", () => {
  const { seats } = createOwner(["seat-1"], hold, noJournal, limiter, 8);
  seats.claim("seat-1", 1n, Date.now(), true);
  expect(seats.pay("seat-1", 1n)).toBe("paid");
  expect(seats.release("seat-1", 1n)).toBe(false);
  expect(seats.heartbeat("seat-1", 1n)).toBe(false);
});

test("waiters are served first come, first served", async () => {
  const { seats } = createOwner(["seat-1"], hold, noJournal, limiter, 8);
  seats.claim("seat-1", 1n, Date.now(), true);
  const first = seats.wait("seat-1", 2n, 1000, true);
  const second = seats.wait("seat-1", 3n, 1000, true);

  seats.release("seat-1", 1n);
  expect(await first).toBe("won");
  seats.release("seat-1", 2n);
  expect(await second).toBe("won");
});

test("a lapsed lease goes to the queue, not to whoever claims first", async () => {
  const { seats } = createOwner(["seat-1"], { holdTtlSeconds: 1, holdMaxSeconds: 1 }, noJournal, limiter, 8);
  const now = Date.now();
  seats.claim("seat-1", 1n, now, true);
  const parked = seats.wait("seat-1", 2n, 5000);
  expect(seats.claim("seat-1", 3n, now + 1000)).toBe("taken");
  expect(await parked).toBe("won");
});

test("a dead worker's waiters leave the line and its listener is removed", async () => {
  const owner = createOwner(["seat-1"], hold, noJournal, limiter, 8);
  owner.seats.claim("seat-1", 1n, Date.now(), true);
  const { port } = link();
  owner.connect(port);
  expect(port.listenerCount("message")).toBe(1);
  const parked = owner.seats.wait("seat-1", 2n, 60_000, false, port);

  owner.disconnect(port);
  expect(await parked).toBe("draining");
  expect(port.listenerCount("message")).toBe(0);
  expect(owner.seats.waiters).toBe(0);
  owner.seats.release("seat-1", 1n);
  expect(owner.seats.view("seat-1", 2n)).toEqual({ state: "free" });
});

test("many requests share one listener and leave nothing pending", async () => {
  const owner = createOwner(["seat-1"], hold, noJournal, limiter, 2048);
  const worker = new EventEmitter();
  const main = new EventEmitter();
  const wire = (self: EventEmitter, other: EventEmitter) =>
    Object.assign(self, { postMessage: (message: unknown) => other.emit("message", message) }) as unknown as MessageLink;
  owner.connect(wire(main, worker));
  const client = createSeatClient(["seat-1"], wire(worker, main));

  await Promise.all(Array.from({ length: 1000 }, () => client.view("seat-1", 1n)));

  expect(worker.listenerCount("message")).toBe(1);
  expect(main.listenerCount("message")).toBe(1);
  expect(client.pending).toBe(0);
});

test("an unanswered request times out, and close rejects the rest", async () => {
  const silent = link();
  const client = createSeatClient(["seat-1"], silent.port, 10);
  await expect(client.view("seat-1", 1n)).rejects.toBeInstanceOf(SeatsUnavailable);
  expect(client.pending).toBe(0);

  const slow = createSeatClient(["seat-1"], link().port, 60_000);
  const hanging = slow.view("seat-1", 1n);
  slow.close();
  await expect(hanging).rejects.toBeInstanceOf(SeatsUnavailable);
  expect(slow.pending).toBe(0);
});

test("a torn journal tail is cut off, so the next entry starts a fresh line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "journal-")), "confirmed.log");
  writeFileSync(path, "seat-1 ab\nseat-2 c");
  expect(readConfirmed(path)).toEqual([["seat-1", 0xabn]]);

  const journal = openJournal(path);
  journal.append([["seat-3", 0xcdn]]);
  journal.close();
  expect(readFileSync(path, "utf8")).toBe("seat-1 ab\nseat-3 cd\n");
});
