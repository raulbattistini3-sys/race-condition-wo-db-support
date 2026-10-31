import type { Take } from "./limiter";
import type { MessageLink, Reservation, SeatReply, SeatRequest, SeatResult } from "./owner";
import type { Payment, SeatView } from "./seats";

const REPLY_TIMEOUT_MS = 5000;

// Becomes a 503, so the client retries with the same intent.
export class SeatsUnavailable extends Error {}

interface Pending {
  resolve(result: SeatResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type Outgoing = SeatRequest extends infer R ? (R extends SeatRequest ? Omit<R, "id"> : never) : never;

// A worker's side of the owner. One "message" listener serves every request, so
// the only per-request memory is an entry here, and every path out removes it.
export function createSeatClient(seatIds: string[], link: MessageLink, timeoutMs = REPLY_TIMEOUT_MS) {
  const known = new Set(seatIds);
  const pending = new Map<number, Pending>();
  let nextId = 1;

  function call<T extends SeatResult>(request: Outgoing, waitMs = 0): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new SeatsUnavailable("owner did not reply"));
      }, timeoutMs + waitMs);
      pending.set(id, { resolve: resolve as Pending["resolve"], reject, timer });
      link.postMessage({ ...request, id });
    });
  }

  const onMessage = (reply: SeatReply | { type: string }) => {
    if (!("id" in reply)) return;
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if ("error" in reply) entry.reject(new SeatsUnavailable(reply.error));
    else entry.resolve(reply.result);
  };
  link.on("message", onMessage);

  return {
    has: (seat: string) => known.has(seat),
    view: (seat: string, owner: bigint) => call<SeatView>({ type: "view", seat, owner }),
    heartbeat: (seat: string, owner: bigint) => call<SeatView>({ type: "heartbeat", seat, owner }),
    pay: (seat: string, owner: bigint) => call<Payment>({ type: "pay", seat, owner }),
    release: (seat: string, owner: bigint) => call<boolean>({ type: "release", seat, owner }),
    admit: (seat: string, slot: number, owner: bigint) => call<Take>({ type: "admit", seat, slot, owner }),
    reserve: (seat: string, owner: bigint, lease: boolean, waitMs: number) =>
      call<Reservation>({ type: "reserve", seat, owner, lease, waitMs }, waitMs),

    close() {
      link.off("message", onMessage);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new SeatsUnavailable("shutting down"));
      }
      pending.clear();
    },

    get pending() {
      return pending.size;
    },
  };
}

export type SeatClient = ReturnType<typeof createSeatClient>;
