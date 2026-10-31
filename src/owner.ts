import { createFifo } from "./fifo";
import type { Journal } from "./journal";
import type { Limiter, Take } from "./limiter";
import { createSeats, type Claim, type HoldOptions, type Payment, type SeatView, type Waited } from "./seats";

const MAX_BATCH = 512;

// What both ends of a thread boundary look like: an emitter with an "on message".
// A Worker and parentPort both already are one.
export interface MessageLink {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: any) => void): unknown;
  off(event: "message", listener: (message: any) => void): unknown;
}

interface Target {
  id: number;
  seat: string;
  owner: bigint;
}

export type SeatRequest = Target &
  (
    | { type: "view" | "heartbeat" | "pay" | "release" }
    | { type: "admit"; slot: number }
    | { type: "reserve"; lease: boolean; waitMs: number }
  );

export type Reservation = { result: Waited | Claim; view: SeatView };
export type SeatResult = SeatView | Payment | boolean | Reservation | Take;
export type SeatReply = { id: number; result: SeatResult } | { id: number; error: "busy" };

type Reply = (reply: SeatReply) => void;

interface Queued {
  request: SeatRequest;
  client: unknown;
  reply: Reply;
}

// The one writer. Every worker's requests join a single line and run to
// completion in order, which is what stops two of them overlapping.
export function createOwner(
  seatIds: string[],
  hold: HoldOptions,
  journal: Pick<Journal, "append">,
  limiter: Pick<Limiter, "admit">,
  capacity: number,
) {
  const queue = createFifo<Queued>(capacity);
  const unsynced: [string, bigint][] = [];
  const outbox: (() => void)[] = [];
  const links = new Map<MessageLink, (message: any) => void>();
  const seats = createSeats(seatIds, hold, (seat, owner) => unsynced.push([seat, owner]));
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(run);
  }

  // Replies wait for the fsync, so nobody hears they own a seat until it would
  // survive a crash. One fsync covers everything in the batch. If it fails the
  // disk can no longer be trusted, and dying leaves every promise unmade.
  function commit() {
    try {
      if (unsynced.length > 0) journal.append(unsynced.splice(0));
    } catch (error) {
      console.error("journal write failed", error);
      process.exit(1);
    }
    for (const send of outbox.splice(0)) send();
  }

  function answer({ id }: SeatRequest, reply: Reply, result: SeatResult) {
    outbox.push(() => reply({ id, result }));
  }

  function apply({ request, client, reply }: Queued) {
    const { seat, owner } = request;
    switch (request.type) {
      case "view":
        return answer(request, reply, seats.view(seat, owner));
      case "heartbeat":
        seats.heartbeat(seat, owner);
        return answer(request, reply, seats.view(seat, owner));
      case "pay":
        return answer(request, reply, seats.pay(seat, owner));
      case "release":
        return answer(request, reply, seats.release(seat, owner));
      case "admit":
        return answer(request, reply, limiter.admit(request.slot, owner));
      case "reserve": {
        const { lease, waitMs } = request;
        if (waitMs <= 0) {
          const result = seats.claim(seat, owner, Date.now(), lease);
          return answer(request, reply, { result, view: seats.view(seat, owner) });
        }
        void seats.wait(seat, owner, waitMs, lease, client).then((result) => {
          answer(request, reply, { result, view: seats.view(seat, owner) });
          schedule();
        });
      }
    }
  }

  function run() {
    scheduled = false;
    for (let i = 0; i < MAX_BATCH && queue.size > 0; i++) apply(queue.shift()!);
    commit();
    if (queue.size > 0) schedule();
  }

  return {
    seats,

    // One listener per link, however many requests pass through it.
    connect(link: MessageLink) {
      const listener = (message: SeatRequest | { type: "ready" }) => {
        if (!("id" in message)) return;
        // A full queue answers at once, because making a caller wait is what fills it.
        const reply: Reply = (answer) => link.postMessage(answer);
        if (queue.push({ request: message, client: link, reply })) schedule();
        else reply({ id: message.id, error: "busy" });
      };
      links.set(link, listener);
      link.on("message", listener);
    },

    disconnect(link: MessageLink) {
      const listener = links.get(link);
      if (listener) link.off("message", listener);
      links.delete(link);
      seats.drop(link);
    },

    sweep(now = Date.now()) {
      seats.sweep(now);
      commit();
    },

    drain() {
      seats.drain();
    },

    // Runs after the workers are gone, so anything left has nobody to answer to.
    flush() {
      while (queue.size > 0) run();
      commit();
    },
  };
}

export type Owner = ReturnType<typeof createOwner>;
