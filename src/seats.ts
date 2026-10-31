export type Claim = "won" | "replay" | "taken";
export type Waited = Claim | "draining";
export type Payment = "paid" | "replay" | "expired";
export type SeatView =
  | { state: "free" | "taken" }
  | { state: "mine"; confirmed: boolean; expiresInSeconds: number | null };

export interface HoldOptions {
  holdTtlSeconds: number;
  holdMaxSeconds: number;
}

interface Lease {
  owner: bigint;
  deadline: number;
  wonAt: number;
}

interface Waiter {
  owner: bigint;
  lease: boolean;
  client: unknown;
  settle(result: Waited): void;
}

// Only the owner thread touches this, one call at a time, so nothing here may
// await between reading a seat and writing it.
export function createSeats(
  seatIds: string[],
  { holdTtlSeconds, holdMaxSeconds }: HoldOptions,
  onConfirmed: (seat: string, owner: bigint) => void,
) {
  const known = new Set(seatIds);
  // Sweeps and releases only ever read leases, so a seat that moved to
  // confirmed is out of reach of everything that could take it away.
  const confirmed = new Map<string, bigint>();
  const leases = new Map<string, Lease>();
  const waiting = new Map<string, Set<Waiter>>();
  let draining = false;

  function check(seat: string) {
    if (!known.has(seat)) throw new RangeError(`unknown seat ${seat}`);
  }

  function confirm(seat: string, owner: bigint) {
    confirmed.set(seat, owner);
    onConfirmed(seat, owner);
  }

  // Waiters go first, so a fresh claim cannot jump a queue the sweeper has not reached.
  function lapse(seat: string, now: number) {
    const lease = leases.get(seat);
    if (lease && lease.deadline <= now) {
      leases.delete(seat);
      wake(seat, now);
    }
  }

  // A seat is taken for good unless the caller asks for a lease. The owner hash
  // is its own idempotency check: finding your live seat means a retry.
  function claim(seat: string, owner: bigint, now = Date.now(), lease = false): Claim {
    check(seat);
    lapse(seat, now);
    const holder = confirmed.get(seat) ?? leases.get(seat)?.owner;
    if (holder !== undefined) return holder === owner ? "replay" : "taken";
    if (lease) leases.set(seat, { owner, deadline: now + holdTtlSeconds * 1000, wonAt: now });
    else confirm(seat, owner);
    return "won";
  }

  // A confirmed seat never frees up, so waiting on one can only time out.
  function attempt(seat: string, waiter: Waiter, now: number) {
    const result = claim(seat, waiter.owner, now, waiter.lease);
    if (result !== "taken" || confirmed.has(seat)) waiter.settle(result);
  }

  // A Set keeps insertion order, so the longest waiter is asked first.
  function wake(seat: string, now: number) {
    for (const waiter of waiting.get(seat) ?? []) attempt(seat, waiter, now);
  }

  function live(seat: string, now: number) {
    const lease = leases.get(seat);
    return lease && lease.deadline > now ? lease : undefined;
  }

  return {
    claim,

    view(seat: string, owner: bigint, now = Date.now()): SeatView {
      check(seat);
      const held = confirmed.get(seat);
      if (held !== undefined) {
        return held === owner ? { state: "mine", confirmed: true, expiresInSeconds: null } : { state: "taken" };
      }
      const lease = live(seat, now);
      if (!lease) return { state: "free" };
      if (lease.owner !== owner) return { state: "taken" };
      return { state: "mine", confirmed: false, expiresInSeconds: Math.ceil((lease.deadline - now) / 1000) };
    },

    // Rolls a live lease forward, up to the cap counted from when it was won.
    heartbeat(seat: string, owner: bigint, now = Date.now()): boolean {
      check(seat);
      const lease = live(seat, now);
      if (lease?.owner !== owner) return false;
      const deadline = Math.min(now + holdTtlSeconds * 1000, lease.wonAt + holdMaxSeconds * 1000);
      lease.deadline = Math.max(deadline, lease.deadline);
      return true;
    },

    // Turns a lease into a confirmed seat.
    pay(seat: string, owner: bigint, now = Date.now()): Payment {
      check(seat);
      if (confirmed.get(seat) === owner) return "replay";
      if (live(seat, now)?.owner !== owner) return "expired";
      leases.delete(seat);
      confirm(seat, owner);
      return "paid";
    },

    release(seat: string, owner: bigint, now = Date.now()): boolean {
      check(seat);
      if (leases.get(seat)?.owner !== owner) return false;
      leases.delete(seat);
      wake(seat, now);
      return true;
    },

    sweep(now = Date.now()) {
      for (const seat of leases.keys()) lapse(seat, now);
    },

    // Parks a loser until the seat frees up or the time runs out.
    wait(seat: string, owner: bigint, ms: number, lease = false, client?: unknown): Promise<Waited> {
      check(seat);
      return new Promise((resolve) => {
        const waiters = waiting.get(seat) ?? new Set<Waiter>();
        waiting.set(seat, waiters);
        const waiter: Waiter = {
          owner,
          lease,
          client,
          settle(result) {
            clearTimeout(timer);
            waiters.delete(waiter);
            if (waiters.size === 0 && waiting.get(seat) === waiters) waiting.delete(seat);
            resolve(result);
          },
        };
        const timer = setTimeout(() => waiter.settle("taken"), ms);
        waiters.add(waiter);
        attempt(seat, waiter, Date.now());
        if (draining) waiter.settle("draining");
      });
    },

    // Replays the journal at boot, before anything can claim.
    restore(seat: string, owner: bigint): boolean {
      // Refusing to boot beats silently selling a seat that someone already owns.
      check(seat);
      const held = confirmed.get(seat);
      if (held !== undefined && held !== owner) throw new Error(`journal gives seat ${seat} two owners`);
      confirmed.set(seat, owner);
      return held === undefined;
    },

    // A dead worker can never collect a win, so its waiters must leave the line.
    drop(client: unknown) {
      for (const waiters of waiting.values()) {
        for (const waiter of waiters) {
          if (waiter.client === client) waiter.settle("draining");
        }
      }
    },

    drain() {
      draining = true;
      for (const waiters of waiting.values()) {
        for (const waiter of waiters) waiter.settle("draining");
      }
    },

    get waiters() {
      return waiting.size;
    },
  };
}

export type Seats = ReturnType<typeof createSeats>;
