export const BUCKET_SLOTS = 1 << 16;

// Rate-limit words. Despite the name these stay on the owner thread: workers
// reach them, and the seats, only by message.
export interface SharedState {
  buckets: SharedArrayBuffer;
  admitted: SharedArrayBuffer;
}

export function createSharedState(): SharedState {
  return {
    buckets: new SharedArrayBuffer(BUCKET_SLOTS * BigUint64Array.BYTES_PER_ELEMENT),
    admitted: new SharedArrayBuffer(BUCKET_SLOTS * BigInt64Array.BYTES_PER_ELEMENT),
  };
}
