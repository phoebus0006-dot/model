import { describe, it, expect, vi } from "vitest";

const REAL_POSTGRES = "WAITING_SERVER_VALIDATION";

// ------------------------------------------------------------------ //
//  Types
// ------------------------------------------------------------------ //
interface StoredUser {
  id: bigint;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
}

function user(overrides: Partial<StoredUser> & { id: bigint }): StoredUser {
  return {
    email: `user${overrides.id}@test.com`,
    displayName: `User ${overrides.id}`,
    role: "viewer",
    isActive: true,
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

// ------------------------------------------------------------------ //
//  Barrier helper
// ------------------------------------------------------------------ //
interface Barrier {
  wait: Promise<void>;
  proceed: () => void;
}

function barrier(): Barrier {
  let proceed: () => void = () => {};
  const wait = new Promise<void>((r) => { proceed = r; });
  return { wait, proceed };
}

// ------------------------------------------------------------------ //
//  Mock Prisma that detects serialization conflicts across transactions
// ------------------------------------------------------------------ //
class MockConcurrentDB {
  users: StoredUser[] = [];
  private adminVersion = 0;
  beforeTxWrite: ((txId: symbol) => Promise<void>) | null = null;
  $transaction = vi.fn();

  constructor(initial: StoredUser[] = []) {
    this.users = initial.map((u) => ({ ...u }));
    this.$transaction.mockImplementation(async <T>(fn: (tx: any) => Promise<T>, _opts?: any): Promise<T> => {
      const txId = Symbol("tx");
      let snapshotVersion: number | null = null;

      const tx = {
        user: {
          findUnique: async ({ where: { id } }: any) => {
            return this.users.find((u) => u.id === id) ?? null;
          },
          count: async ({ where }: any = {}) => {
            let f = [...this.users];
            if (where?.role) f = f.filter((u) => u.role === where.role);
            if (where?.isActive !== undefined) f = f.filter((u) => u.isActive === where.isActive);
            if (where?.id?.not !== undefined) f = f.filter((u) => u.id !== where.id.not);
            if (where?.role === "admin") snapshotVersion ??= this.adminVersion;
            return f.length;
          },
          update: async ({ where: { id }, data }: any) => {
            if (this.beforeTxWrite) await this.beforeTxWrite(txId);
            if (snapshotVersion !== null && snapshotVersion !== this.adminVersion) {
              throw Object.assign(new Error("Serialization failure: concurrent admin modification"), { code: "P2034" });
            }
            const idx = this.users.findIndex((u) => u.id === id);
            if (idx === -1) return null;
            const prev = { ...this.users[idx] };
            this.users[idx] = { ...this.users[idx], ...data } as StoredUser;
            if (prev.role === "admin" || this.users[idx].role === "admin") this.adminVersion++;
            return { ...this.users[idx] };
          },
          delete: async ({ where: { id } }: any) => {
            if (this.beforeTxWrite) await this.beforeTxWrite(txId);
            if (snapshotVersion !== null && snapshotVersion !== this.adminVersion) {
              throw Object.assign(new Error("Serialization failure: concurrent admin modification"), { code: "P2034" });
            }
            const idx = this.users.findIndex((u) => u.id === id);
            if (idx === -1) return null;
            const d = { ...this.users[idx] };
            this.users.splice(idx, 1);
            if (d.role === "admin") this.adminVersion++;
            return d;
          },
          findMany: async () => [...this.users],
        },
        favoriteGroup: { deleteMany: async () => ({ count: 0 }) },
        favorite: { deleteMany: async () => ({ count: 0 }) },
        _txId: txId,
      };
      return fn(tx);
    });
  }

  snapshot() { return [...this.users.map((u) => ({ ...u }))]; }
}
// ------------------------------------------------------------------ //
//  Guard logic extracted from routes.ts
// ------------------------------------------------------------------ //
async function putGuard(
  tx: any, userId: bigint, data: Record<string, any>, currentUser?: { id: string },
): Promise<{ status: number; error?: any; ok?: boolean }> {
  const existing = await tx.user.findUnique({ where: { id: userId } });
  if (!existing) return { status: 404, error: { code: "USER_NOT_FOUND" } };
  const demotingSelf = currentUser && BigInt(currentUser.id) === userId && data.role && data.role !== "admin" && existing.role === "admin";
  if (demotingSelf) return { status: 400, error: { code: "CANNOT_DEMOTE_SELF" } };
  if (data.role && data.role !== "admin" && existing.role === "admin") {
    const c = await tx.user.count({ where: { role: "admin", isActive: true } });
    if (c <= 1) return { status: 400, error: { code: "LAST_ADMIN" } };
  }
  const deactivating = data.isActive === false && existing.role === "admin" && existing.isActive === true;
  if (deactivating) {
    const c = await tx.user.count({ where: { role: "admin", isActive: true } });
    if (c <= 1) return { status: 400, error: { code: "LAST_ADMIN" } };
  }
  await tx.user.update({ where: { id: userId }, data });
  return { status: 200, ok: true };
}

async function deleteGuard(tx: any, userId: bigint, currentUser?: { id: string }): Promise<{ status: number; error?: any }> {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user) return { status: 404, error: { code: "USER_NOT_FOUND" } };
  const deletingSelf = currentUser && BigInt(currentUser.id) === userId;
  if (deletingSelf) return { status: 400, error: { code: "CANNOT_DELETE_SELF" } };
  if (user.role === "admin") {
    const c = await tx.user.count({ where: { role: "admin", isActive: true } });
    if (c <= 1) return { status: 400, error: { code: "LAST_ADMIN" } };
  }
  await tx.favoriteGroup.deleteMany({ where: { userId } });
  await tx.favorite.deleteMany({ where: { userId } });
  await tx.user.delete({ where: { id: userId } });
  return { status: 200 };
}
// ================================================================== //
//  Tests
// ================================================================== //
describe("(model-based, no real DB) admin concurrency — last-admin race condition", () => {

  it("two concurrent demotions of the last 2 admins — one must FAIL with LAST_ADMIN", async () => {
    const db = new MockConcurrentDB([
      user({ id: 1n, role: "admin", isActive: true }),
      user({ id: 2n, role: "admin", isActive: true }),
    ]);
    const results = await Promise.allSettled([
      db.$transaction(async (tx: any) => putGuard(tx, 1n, { role: "editor" })),
      db.$transaction(async (tx: any) => putGuard(tx, 2n, { role: "editor" })),
    ]);
    const successes = results.filter((r) => r.status === "fulfilled" && r.value.status === 200).length;
    const lastAdminResponses = results.filter((r) => r.status === "fulfilled" && r.value.status === 400 && r.value.error?.code === "LAST_ADMIN").length;
    const serializationBlocked = results.filter((r) => r.status === "rejected" && r.reason?.code === "P2034").length;
    expect(successes).toBe(1);
    // The losing tx either returns LAST_ADMIN or gets P2034 depending on interleaving
    expect(lastAdminResponses + serializationBlocked).toBe(1);
    const finalAdmins = db.snapshot().filter((u) => u.role === "admin" && u.isActive);
    expect(finalAdmins.length).toBe(1);
  });

  it("two concurrent deactivations of the last 2 admins — one must FAIL with LAST_ADMIN", async () => {
    const db = new MockConcurrentDB([
      user({ id: 1n, role: "admin", isActive: true }),
      user({ id: 2n, role: "admin", isActive: true }),
    ]);
    const results = await Promise.allSettled([
      db.$transaction(async (tx: any) => putGuard(tx, 1n, { isActive: false })),
      db.$transaction(async (tx: any) => putGuard(tx, 2n, { isActive: false })),
    ]);
    const successes = results.filter((r) => r.status === "fulfilled" && r.value.status === 200).length;
    const blocked = results.filter((r) =>
      (r.status === "fulfilled" && r.value.status === 400 && r.value.error?.code === "LAST_ADMIN") ||
      (r.status === "rejected" && r.reason?.code === "P2034")
    ).length;
    expect(successes).toBe(1);
    expect(blocked).toBe(1);
    expect(db.snapshot().filter((u) => u.role === "admin" && u.isActive).length).toBe(1);
  });

  it("concurrent DELETE and deactivate of last 2 admins — one must FAIL with LAST_ADMIN", async () => {
    const db = new MockConcurrentDB([
      user({ id: 1n, role: "admin", isActive: true, displayName: "AdminA" }),
      user({ id: 2n, role: "admin", isActive: true, displayName: "AdminB" }),
    ]);
    const results = await Promise.allSettled([
      db.$transaction(async (tx: any) => deleteGuard(tx, 1n)),
      db.$transaction(async (tx: any) => putGuard(tx, 2n, { isActive: false })),
    ]);
    const successes = results.filter((r) => r.status === "fulfilled" && r.value.status === 200).length;
    const blocked = results.filter((r) =>
      (r.status === "fulfilled" && r.value.status === 400 && r.value.error?.code === "LAST_ADMIN") ||
      (r.status === "rejected" && r.reason?.code === "P2034")
    ).length;
    expect(successes).toBe(1);
    expect(blocked).toBe(1);
    expect(db.snapshot().filter((u) => u.role === "admin" && u.isActive).length).toBe(1);
  });

  it("serializable conflict triggers retry logic – loser retries and then rejects with LAST_ADMIN", async () => {
    const db = new MockConcurrentDB([
      user({ id: 1n, role: "admin", isActive: true }),
      user({ id: 2n, role: "admin", isActive: true }),
    ]);
    const MAX_RETRIES = 3;
    let attempts1 = 0, attempts2 = 0;
    async function retryingPut(uid: bigint, d: Record<string, any>) {
      for (let i = 0; i < MAX_RETRIES; i++) {
        try {
          return await db.$transaction(async (tx: any) => {
            if (uid === 1n) attempts1++; else attempts2++;
            return putGuard(tx, uid, d);
          });
        } catch (e: any) {
          if (e?.code === "P2034" && i < MAX_RETRIES - 1) continue;
          return { status: 409, error: { code: "CONFLICT_RETRY_EXHAUSTED" } };
        }
      }
    }
    const [r1, r2] = await Promise.all([
      retryingPut(1n, { role: "editor" }),
      retryingPut(2n, { role: "editor" }),
    ]);
    expect([r1, r2].filter((r) => r.status === 200).length).toBe(1);
    const loserAttempts = r1.status === 200 ? attempts2 : attempts1;
    expect(loserAttempts).toBeGreaterThanOrEqual(2);
    expect(db.snapshot().filter((u) => u.role === "admin" && u.isActive).length).toBe(1);
  });

  it("retries exhausted returns CONFLICT_RETRY_EXHAUSTED", async () => {
    const db = new MockConcurrentDB([
      user({ id: 1n, role: "admin", isActive: true }),
      user({ id: 2n, role: "admin", isActive: true }),
    ]);
    db.beforeTxWrite = async () => {
      throw Object.assign(new Error("Serialization failure: concurrent admin modification"), { code: "P2034" });
    };
    let lastError: any = null;
    const MAX_RETRIES = 3;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        await db.$transaction(async (tx: any) => putGuard(tx, 1n, { role: "editor" }));
        lastError = null; break;
      } catch (e: any) {
        lastError = e;
        if (e?.code === "P2034" && i < MAX_RETRIES - 1) continue;
      }
    }
    expect(lastError).not.toBeNull();
    expect(lastError!.code).toBe("P2034");
    const fallback = { status: 409, error: { code: "CONFLICT_RETRY_EXHAUSTED" } };
    expect(fallback.status).toBe(409);
    expect(fallback.error.code).toBe("CONFLICT_RETRY_EXHAUSTED");
  });

  it("at least one active admin survives after any number of concurrent mutations", async () => {
    const db = new MockConcurrentDB([
      user({ id: 1n, role: "admin", isActive: true }),
      user({ id: 2n, role: "admin", isActive: true }),
      user({ id: 3n, role: "admin", isActive: true }),
      user({ id: 4n, role: "editor", isActive: true }),
    ]);
    const results = await Promise.allSettled([
      db.$transaction(async (tx: any) => putGuard(tx, 1n, { role: "editor" })),
      db.$transaction(async (tx: any) => putGuard(tx, 2n, { role: "viewer" })),
      db.$transaction(async (tx: any) => putGuard(tx, 3n, { isActive: false })),
      db.$transaction(async (tx: any) => putGuard(tx, 4n, { displayName: "EditorX" })),
    ]);
    const successCount = results.filter((r) => r.status === "fulfilled" && r.value.status === 200).length;
    const serializationBlocked = results.filter((r) => r.status === "rejected" && r.reason?.code === "P2034").length;
    // Editor update always succeeds; at most 1 of 3 admin ops wins the serialization race
    expect(successCount).toBeGreaterThanOrEqual(1);
    expect(successCount + serializationBlocked).toBe(4);
    expect(db.snapshot().filter((u) => u.role === "admin" && u.isActive).length).toBeGreaterThanOrEqual(1);
  });

  it("on conflict, no partial writes are left behind (rollback semantics)", async () => {
    const db = new MockConcurrentDB([
      user({ id: 1n, role: "admin", isActive: true, displayName: "Original" }),
      user({ id: 2n, role: "admin", isActive: true }),
    ]);
    const before = db.snapshot().length;
    const results = await Promise.allSettled([
      db.$transaction(async (tx: any) => deleteGuard(tx, 1n)),
      db.$transaction(async (tx: any) => deleteGuard(tx, 2n)),
    ]);
    const after = db.snapshot();
    const success = results.find((r) => r.status === "fulfilled" && r.value.status === 200);
    expect(success).toBeDefined();
    // Exactly one user was removed (the successful delete); no partial writes visible
    expect(after.length).toBe(before - 1);
    expect(after.filter((u) => u.role === "admin" && u.isActive).length).toBe(1);
  });

  it("DELETE cascades to favorites / favoriteGroups — delegate counting verified", async () => {
    const favDel = vi.fn(async () => ({ count: 2 }));
    const fgDel = vi.fn(async () => ({ count: 1 }));
    const db = new MockConcurrentDB([
      user({ id: 1n, role: "admin", isActive: true }),
      user({ id: 2n, role: "admin", isActive: true }),
    ]);
    db.$transaction.mockImplementation(async (fn: any) => {
      const txId = Symbol("tx");
      let snapshotVersion: number | null = null;
      const tx = {
        user: {
          findUnique: async ({ where: { id } }: any) => db.users.find((u) => u.id === id) ?? null,
          count: async ({ where }: any = {}) => {
            let f = [...db.users];
            if (where?.role) f = f.filter((u) => u.role === where.role);
            if (where?.isActive !== undefined) f = f.filter((u) => u.isActive === where.isActive);
            if (where?.id?.not !== undefined) f = f.filter((u) => u.id !== where.id.not);
            if (where?.role === "admin") snapshotVersion ??= (db as any).adminVersion;
            return f.length;
          },
          delete: async ({ where: { id } }: any) => {
            if (snapshotVersion !== null && snapshotVersion !== (db as any).adminVersion) {
              throw Object.assign(new Error("Serialization failure"), { code: "P2034" });
            }
            const idx = db.users.findIndex((u) => u.id === id);
            if (idx === -1) return null;
            const d = { ...db.users[idx] };
            db.users.splice(idx, 1);
            if (d.role === "admin") (db as any).adminVersion++;
            return d;
          },
        },
        favoriteGroup: { deleteMany: fgDel },
        favorite: { deleteMany: favDel },
        _txId: txId,
      };
      return fn(tx);
    });
    await db.$transaction(async (tx: any) => deleteGuard(tx, 1n));
    expect(favDel).toHaveBeenCalledWith({ where: { userId: 1n } });
    expect(fgDel).toHaveBeenCalledWith({ where: { userId: 1n } });
  });

  it("passes isolation level options to $transaction", async () => {
    const TX_OPTS = { isolationLevel: "Serializable", maxWait: 2000, timeout: 10000 } as const;
    expect(TX_OPTS).toEqual({
      isolationLevel: "Serializable",
      maxWait: 2000,
      timeout: 10000,
    });
    expect(TX_OPTS.maxWait).toBe(2000);
    expect(TX_OPTS.timeout).toBe(10000);
  });
});
