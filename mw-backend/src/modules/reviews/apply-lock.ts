import type { Redis } from "ioredis";
import crypto from "crypto";

const LOCK_TTL_MS = 60_000;
const RENEW_BEFORE_MS = 10_000;
const FIGURE_LOCK_TTL_MS = 30_000;
export const LOCK_LOST_ERR = "APPLY_LOCK_LOST";

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const VERIFY_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return 1
end
return 0
`;

export interface LockLease {
  token: string;
  isLost(): boolean;
  assertHeld(): void;
  verifyHeld(redis: Redis): Promise<void>;
  release(): Promise<boolean>;
}

export function lockKey(reviewItemId: string): string {
  return `review:apply:lock:${reviewItemId}`;
}

export function figureLockKey(figureId: string): string {
  return `review:figure:lock:${figureId}`;
}

function makeToken(): string {
  return crypto.randomUUID();
}

async function verifyToken(redis: Redis, key: string, token: string): Promise<boolean> {
  try {
    const r = await redis.eval(VERIFY_SCRIPT, 1, key, token);
    return r === 1;
  } catch {
    return false;
  }
}

export async function tryAcquire(redis: Redis, reviewItemId: string): Promise<LockLease | null> {
  const key = lockKey(reviewItemId);
  const token = makeToken();
  const ok = await redis.set(key, token, "PX", LOCK_TTL_MS, "NX");
  if (ok !== "OK") return null;

  let lost = false;
  let renewed = true;

  const renewTimer = setInterval(async () => {
    if (!renewed) return;
    try {
      const r = await redis.eval(RENEW_SCRIPT, 1, key, token, String(LOCK_TTL_MS));
      if (r !== 1) {
        lost = true;
        renewed = false;
        clearInterval(renewTimer);
      }
    } catch {
      lost = true;
      renewed = false;
      clearInterval(renewTimer);
    }
  }, LOCK_TTL_MS - RENEW_BEFORE_MS);

  return {
    token,
    isLost() { return lost; },
    assertHeld() {
      if (lost) throw new Error(LOCK_LOST_ERR);
    },
    async verifyHeld(redis: Redis) {
      const held = await verifyToken(redis, key, token);
      if (!held) {
        lost = true;
        renewed = false;
        clearInterval(renewTimer);
        throw new Error(LOCK_LOST_ERR);
      }
    },
    async release() {
      renewed = false;
      clearInterval(renewTimer);
      try {
        const r = await redis.eval(RELEASE_SCRIPT, 1, key, token);
        return r === 1;
      } catch { return false; }
    },
  };
}

export async function tryAcquireFigureLock(redis: Redis, figureId: string, ownerToken: string): Promise<boolean> {
  const key = figureLockKey(figureId);
  const ok = await redis.set(key, ownerToken, "PX", FIGURE_LOCK_TTL_MS, "NX");
  return ok === "OK";
}

export async function releaseFigureLock(redis: Redis, figureId: string, ownerToken: string): Promise<boolean> {
  const key = figureLockKey(figureId);
  try {
    const r = await redis.eval(RELEASE_SCRIPT, 1, key, ownerToken);
    return r === 1;
  } catch {
    return false;
  }
}
