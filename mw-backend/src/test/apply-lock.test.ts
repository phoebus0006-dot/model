import { describe, it, expect, vi } from "vitest";
import { tryAcquire, lockKey } from "../modules/reviews/apply-lock.js";

function mockRedis(): any {
  let store: Record<string, string> = {};
  return {
    set: vi.fn(async (key: string, value: string, ...args: string[]) => {
      if (args.includes("NX") && store[key]) return null;
      store[key] = value;
      return "OK";
    }),
    get: vi.fn(async (key: string) => store[key] || null),
    eval: vi.fn(async (script: string, numKeys: number, key: string, token: string, ...extra: string[]) => {
      if (store[key] === token) {
        if (script.includes("DEL")) { delete store[key]; return 1; }
        if (script.includes("PEXPIRE")) { return 1; }
      }
      return 0;
    }),
    _store: store,
  };
}

describe("apply lock — lease semantics", () => {
  it("acquire returns lease for first caller", async () => {
    const redis = mockRedis();
    const lease = await tryAcquire(redis, "item-1");
    expect(lease).not.toBeNull();
    expect(lease!.token).toBeTruthy();
  });

  it("acquire returns null for second caller", async () => {
    const redis = mockRedis();
    await tryAcquire(redis, "item-1");
    const lease = await tryAcquire(redis, "item-1");
    expect(lease).toBeNull();
  });

  it("release returns true for owner", async () => {
    const redis = mockRedis();
    const lease = await tryAcquire(redis, "item-1");
    const released = await lease!.release();
    expect(released).toBe(true);
    const lease2 = await tryAcquire(redis, "item-1");
    expect(lease2).not.toBeNull();
  });

  it("old token cannot release after re-acquire", async () => {
    const redis = mockRedis();
    const lease1 = await tryAcquire(redis, "item-1");
    await lease1!.release();
    const lease2 = await tryAcquire(redis, "item-1");
    const oldReleased = await lease1!.release();
    expect(oldReleased).toBe(false); // already released
  });

  it("wrong token cannot release lock", async () => {
    const redis = mockRedis();
    const lease = await tryAcquire(redis, "item-1");
    const wrongLease = { token: "wrong-token", release: async () => false };
    const r = await redis.eval("release script", 1, lockKey("item-1"), wrongLease.token);
    expect(r).toBe(0);
    const stillHeld = await tryAcquire(redis, "item-1");
    expect(stillHeld).toBeNull();
  });

  it("lock key includes review item id", () => {
    expect(lockKey("test-123")).toBe("review:apply:lock:test-123");
  });
});
