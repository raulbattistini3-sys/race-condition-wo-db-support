import { createHmac, randomUUID } from "node:crypto";
import { sign, verify } from "hono/jwt";
import { BUCKET_SLOTS } from "./shared";

const OWNER_MASK = (1n << 39n) - 1n;

const ALG = "HS256";

export interface Session {
  sub: string;
  sid: string;
  start: number;
}

export interface SessionTimes {
  idleSeconds: number;
  maxSeconds: number;
}

export interface Intent {
  sub: string;
  seat: string;
  nonce: string;
  exp: number;
}

export function newSession(userId: string): Session {
  return { sub: userId, sid: randomUUID(), start: Math.floor(Date.now() / 1000) };
}

// Rolling: every issue moves exp forward, but never past start + maxSeconds.
export function sessionExpiry(session: Session, { idleSeconds, maxSeconds }: SessionTimes): number {
  return Math.min(Math.floor(Date.now() / 1000) + idleSeconds, session.start + maxSeconds);
}

export function issueSession(session: Session, secret: string, times: SessionTimes): Promise<string> {
  return sign({ typ: "session", ...session, exp: sessionExpiry(session, times) }, secret, ALG);
}

export async function readSession(token: string, secret: string): Promise<(Session & { exp: number }) | null> {
  try {
    const payload = await verify(token, secret, ALG);
    if (payload.typ !== "session") return null;
    return payload as unknown as Session & { exp: number };
  } catch {
    return null;
  }
}

export function issueIntent(userId: string, seat: string, secret: string, ttlSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return sign({ typ: "intent", sub: userId, seat, nonce: randomUUID(), exp }, secret, ALG);
}

export async function readIntent(token: string, secret: string): Promise<Intent | null> {
  try {
    const payload = await verify(token, secret, ALG);
    if (payload.typ !== "intent") return null;
    return payload as unknown as Intent;
  } catch {
    return null;
  }
}

function digest(input: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

// Keyed so nobody can craft a user name that collides with the current holder.
export function ownerHash(userId: string, seat: string, secret: string): bigint {
  return digest(`holder|${userId}|${seat}`, secret).readBigUInt64LE(0) & OWNER_MASK || 1n;
}

export function bucketSlot(userId: string, secret: string): number {
  return digest(`bucket|${userId}`, secret).readUInt32LE(0) % BUCKET_SLOTS;
}
