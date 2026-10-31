import type { SharedState } from "./shared";

export type Take = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface LimiterOptions {
  capacity: number;
  perSecond: number;
}

// One 64-bit word per bucket, so a whole bucket swaps atomically:
// high 44 bits are the last grant in ms, low 20 bits are thousandths of a token.
const TOKEN_BITS = 20n;
const TOKEN_MASK = (1n << TOKEN_BITS) - 1n;
const ONE_TOKEN = 1000;
export const MAX_CAPACITY = Number(TOKEN_MASK) / ONE_TOKEN;

export function createLimiter(state: Pick<SharedState, "buckets" | "admitted">, { capacity, perSecond }: LimiterOptions) {
  if (capacity > MAX_CAPACITY) throw new Error(`capacity cannot exceed ${MAX_CAPACITY}`);
  const buckets = new BigUint64Array(state.buckets);
  const admitted = new BigInt64Array(state.admitted);
  const full = capacity * ONE_TOKEN;

  function take(slot: number, now: number): Take {
    for (;;) {
      const current = Atomics.load(buckets, slot);
      const last = current === 0n ? now : Number(current >> TOKEN_BITS);
      const stored = current === 0n ? full : Number(current & TOKEN_MASK);
      const tokens = Math.min(full, stored + Math.floor(Math.max(0, now - last) * perSecond));

      if (tokens < ONE_TOKEN) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((ONE_TOKEN - tokens) / ONE_TOKEN / perSecond)) };
      }

      const next = (BigInt(Math.max(last, now)) << TOKEN_BITS) | BigInt(tokens - ONE_TOKEN);
      if (Atomics.compareExchange(buckets, slot, current, next) === current) return { allowed: true };
    }
  }

  return {
    take,
    // The admitted word records which attempt last paid. Duplicates of that
    // attempt pass free, so a double click cannot turn a win into a 429.
    admit(slot: number, attempt: bigint, now = Date.now()): Take {
      for (;;) {
        const seen = Atomics.load(admitted, slot);
        if (seen === attempt) return { allowed: true };
        if (Atomics.compareExchange(admitted, slot, seen, attempt) !== seen) continue;

        const taken = take(slot, now);
        if (!taken.allowed) Atomics.compareExchange(admitted, slot, attempt, seen);
        return taken;
      }
    },
  };
}

export type Limiter = ReturnType<typeof createLimiter>;
