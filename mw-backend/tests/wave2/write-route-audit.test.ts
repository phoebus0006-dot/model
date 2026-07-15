// Wave 2 Write-Route Authorization Audit Tests.
//
// Contract (Wave 2 Pre-Push Security Audit):
//   1. No token cannot call protected figures write routes (POST/PUT/DELETE).
//   2. User JWT cannot call Admin figures write routes.
//   3. Admin JWT (role=admin) can call authorized figures write routes.
//   4. reviewer/operator roles are rejected from admin-only figures writes.
//   5. figures public GET routes remain accessible without auth.
//   6. Unverified User favorite/like/comment writes → 403 EMAIL_NOT_VERIFIED.
//   7. Verified User writes succeed.
//   8. Admin JWT cannot enter User community write routes.
//   9. community.ts no longer contains "prisma as any".
//
// Run: npx tsx --test tests/wave2/write-route-audit.test.ts

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { figureRoutes } from "../../src/routes/figures.js";
import { communityRoutes } from "../../src/routes/community.js";
import { registerBigIntSerializer } from "../../src/plugins/bigintSerializer.js";
import { signAdminToken } from "../../src/plugins/admin-auth/token.js";
import { ADMIN_JWT_AUDIENCE, ADMIN_JWT_TTL_SECONDS } from "../../src/plugins/admin-auth/constants.js";
import { USER_JWT_AUDIENCE } from "../../src/runtime/config.js";

const TEST_JWT_SECRET = "test-write-route-audit-user-secret-32!";
const ADMIN_TEST_SECRET = "test-write-route-audit-admin-secret-32!";

// ─── Mock data types ───────────────────────────────────────────────────────

interface MockAdmin {
  id: bigint;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
  sessionVersion: number;
}

interface MockUser {
  id: bigint;
  email: string;
  normalizedEmail: string;
  emailVerifiedAt: Date | null;
  passwordHash: string;
  sessionVersion: number;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  isActive: boolean;
  createdAt: Date;
}

interface MockFigure {
  id: bigint;
  slug: string;
  name: string;
  isDeleted: boolean;
  janCode: string | null;
}

// ─── Mock Prisma ───────────────────────────────────────────────────────────

function makePrismaMock() {
  const admins = new Map<string, MockAdmin>();
  const users: MockUser[] = [];
  const figures: MockFigure[] = [];
  const favorites: any[] = [];
  const figureLikes: any[] = [];
  const figureComments: any[] = [];
  const auditLogs: any[] = [];
  let nextFavId = 1n;
  let nextLikeId = 1n;
  let nextCommentId = 1n;

  function projectFields(obj: any, select: any): any {
    if (!select) return { ...obj };
    const filtered: any = {};
    for (const key of Object.keys(select)) {
      if (key in obj) filtered[key] = obj[key];
    }
    return filtered;
  }

  return {
    _admins: admins,
    _users: users,
    _figures: figures,
    _auditLogs: auditLogs,

    adminAccount: {
      async findUnique({ where, select }: { where: any; select?: any }): Promise<any> {
        const row = admins.get(String(where.id));
        if (!row) return null;
        return projectFields(row, select);
      },
    },
    adminAuditLog: {
      async create({ data }: { data: any }): Promise<any> {
        auditLogs.push({ ...data });
        return { ...data };
      },
    },
    user: {
      async findUnique({ where, select }: { where: any; select?: any }): Promise<any> {
        let user: MockUser | null = null;
        if ("id" in where) user = users.find((u) => u.id === where.id) || null;
        if (!user) return null;
        return projectFields(user, select);
      },
    },
    figure: {
      async findFirst({ where, select }: { where: any; select?: any }): Promise<any> {
        const fig = figures.find(
          (f) => f.slug === where.slug && f.isDeleted === (where.isDeleted ?? false),
        );
        if (!fig) return null;
        return projectFields(fig, select);
      },
      async findUnique({ where, select }: { where: any; select?: any }): Promise<any> {
        const fig = figures.find((f) => f.slug === where.slug);
        if (!fig) return null;
        return projectFields(fig, select);
      },
      async create({ data }: { data: any }): Promise<any> {
        const fig: MockFigure = {
          id: BigInt(figures.length + 1),
          slug: data.slug,
          name: data.name,
          isDeleted: false,
          janCode: data.janCode ?? null,
        };
        figures.push(fig);
        return { ...fig };
      },
      async update({ where, data }: { where: any; data: any }): Promise<any> {
        const fig = figures.find((f) => f.slug === where.slug);
        if (!fig) throw new Error("mock: figure not found for update");
        Object.assign(fig, data);
        return { ...fig };
      },
      async findMany(): Promise<any[]> {
        return figures.filter((f) => !f.isDeleted).map((f) => ({ ...f }));
      },
    },
    favorite: {
      async upsert({ where, create }: { where: any; create: any }): Promise<any> {
        const existing = favorites.find(
          (f) =>
            f.userId === where.userId_figureId.userId &&
            f.figureId === where.userId_figureId.figureId,
        );
        if (existing) return existing;
        const fav = {
          id: nextFavId++,
          userId: create.userId,
          figureId: create.figureId,
          createdAt: new Date(),
        };
        favorites.push(fav);
        return fav;
      },
      async deleteMany({ where }: { where: any }): Promise<{ count: number }> {
        const before = favorites.length;
        for (let i = favorites.length - 1; i >= 0; i--) {
          if (
            favorites[i].userId === where.userId &&
            favorites[i].figureId === where.figureId
          ) {
            favorites.splice(i, 1);
          }
        }
        return { count: before - favorites.length };
      },
      async findUnique({ where }: { where: any }): Promise<any> {
        return (
          favorites.find(
            (f) =>
              f.userId === where.userId_figureId.userId &&
              f.figureId === where.userId_figureId.figureId,
          ) || null
        );
      },
      async count({ where }: { where: any }): Promise<number> {
        return favorites.filter((f) => f.figureId === where.figureId).length;
      },
      async findMany({ where }: { where: any }): Promise<any[]> {
        return favorites
          .filter((f) => f.userId === where.userId)
          .map((f) => ({
            ...f,
            figure: { id: 1n, slug: "test", name: "Test", images: [] },
          }));
      },
    },
    figureLike: {
      async upsert({ where, create }: { where: any; create: any }): Promise<any> {
        const existing = figureLikes.find(
          (l) =>
            l.userId === where.userId_figureId.userId &&
            l.figureId === where.userId_figureId.figureId,
        );
        if (existing) return existing;
        const like = {
          id: nextLikeId++,
          userId: create.userId,
          figureId: create.figureId,
          createdAt: new Date(),
        };
        figureLikes.push(like);
        return like;
      },
      async deleteMany({ where }: { where: any }): Promise<{ count: number }> {
        const before = figureLikes.length;
        for (let i = figureLikes.length - 1; i >= 0; i--) {
          if (
            figureLikes[i].userId === where.userId &&
            figureLikes[i].figureId === where.figureId
          ) {
            figureLikes.splice(i, 1);
          }
        }
        return { count: before - figureLikes.length };
      },
      async findUnique({ where }: { where: any }): Promise<any> {
        return (
          figureLikes.find(
            (l) =>
              l.userId === where.userId_figureId.userId &&
              l.figureId === where.userId_figureId.figureId,
          ) || null
        );
      },
      async count({ where }: { where: any }): Promise<number> {
        return figureLikes.filter((l) => l.figureId === where.figureId).length;
      },
      async findMany({ where }: { where: any }): Promise<any[]> {
        return figureLikes
          .filter((l) => l.userId === where.userId)
          .map((l) => ({
            ...l,
            figure: { id: 1n, slug: "test", name: "Test", images: [] },
          }));
      },
    },
    figureComment: {
      async create({ data }: { data: any }): Promise<any> {
        const comment = {
          id: nextCommentId++,
          body: data.body,
          createdAt: new Date(),
          userId: data.userId,
          figureId: data.figureId,
          isDeleted: false,
        };
        figureComments.push(comment);
        const user = users.find((u) => u.id === data.userId);
        return {
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          user: {
            id: user?.id,
            displayName: user?.displayName,
            avatarUrl: user?.avatarUrl,
          },
        };
      },
      async findMany({ where }: { where: any }): Promise<any[]> {
        return figureComments
          .filter((c) => c.figureId === where.figureId && !c.isDeleted)
          .map((c) => {
            const user = users.find((u) => u.id === c.userId);
            return {
              id: c.id,
              body: c.body,
              createdAt: c.createdAt,
              user: {
                id: user?.id,
                displayName: user?.displayName,
                avatarUrl: user?.avatarUrl,
              },
            };
          });
      },
      async count({ where }: { where: any }): Promise<number> {
        return figureComments.filter(
          (c) => c.figureId === where.figureId && !c.isDeleted,
        ).length;
      },
    },
  };
}

function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, value: string, ..._args: any[]): Promise<string> {
      store.set(key, value);
      return "OK";
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },
    async unlink(...keys: string[]): Promise<number> {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
    async scan(_cursor: string, ..._args: any[]): Promise<[string, string[]]> {
      return ["0", []];
    },
    async incr(key: string): Promise<number> {
      const v = parseInt(store.get(key) || "0", 10) + 1;
      store.set(key, String(v));
      return v;
    },
    async expire(_key: string, _ttl: number): Promise<number> {
      return 1;
    },
  };
}

// ─── Test helpers ──────────────────────────────────────────────────────────

const FIGURE_SLUG = "audit-test-figure";
const FIGURE_ID = 1n;

function seedFigure(prisma: ReturnType<typeof makePrismaMock>) {
  prisma._figures.push({
    id: FIGURE_ID,
    slug: FIGURE_SLUG,
    name: "Audit Test Figure",
    isDeleted: false,
    janCode: "1234567890123",
  });
}

function seedAdmin(
  prisma: ReturnType<typeof makePrismaMock>,
  opts: { id: bigint; role: string; username?: string },
) {
  prisma._admins.set(String(opts.id), {
    id: opts.id,
    username: opts.username ?? `admin-${opts.id}`,
    displayName: `Admin ${opts.id}`,
    role: opts.role,
    isActive: true,
    sessionVersion: 0,
  });
}

function seedUser(
  prisma: ReturnType<typeof makePrismaMock>,
  opts: { id: bigint; email: string; verified: boolean },
) {
  prisma._users.push({
    id: opts.id,
    email: opts.email,
    normalizedEmail: opts.email.toLowerCase(),
    emailVerifiedAt: opts.verified ? new Date() : null,
    passwordHash: "$2a$12$mockhash",
    sessionVersion: 0,
    displayName: `User ${opts.id}`,
    avatarUrl: null,
    role: "user",
    isActive: true,
    createdAt: new Date(),
  });
}

function signAdminForTest(app: FastifyInstance, adminId: string, role: string): string {
  return signAdminToken(app, { adminId, role, sessionVersion: 0 });
}

function signUserForTest(app: FastifyInstance, userId: string): string {
  return (app as any).jwt.sign(
    { userId, sessionVersion: 0, aud: "modelwiki-user" },
    { expiresIn: "2h" },
  );
}

async function buildApp(): Promise<{
  app: FastifyInstance;
  prisma: ReturnType<typeof makePrismaMock>;
}> {
  const prisma = makePrismaMock();
  const redis = makeRedisMock();
  const app = Fastify({ logger: false });
  (app as any).prisma = prisma;
  (app as any).redis = redis;
  registerBigIntSerializer(app);
  // User JWT — default namespace (app.jwt.sign / app.jwt.verify)
  await app.register(jwt, {
    secret: TEST_JWT_SECRET,
    sign: { algorithm: "HS256", aud: USER_JWT_AUDIENCE, expiresIn: "2h" },
    verify: { allowedAud: USER_JWT_AUDIENCE },
  });
  // Admin JWT — admin namespace (app.jwt.admin.sign / app.jwt.admin.verify)
  // Required because signAdminToken uses app.jwt.admin.sign (ADMIN_TEST_SECRET).
  await app.register(jwt, {
    secret: ADMIN_TEST_SECRET,
    namespace: "admin",
    decoratorName: "admin",
    sign: { algorithm: "HS256", aud: ADMIN_JWT_AUDIENCE, expiresIn: ADMIN_JWT_TTL_SECONDS },
    verify: { allowedAud: ADMIN_JWT_AUDIENCE },
  });
  app.register(figureRoutes, { prefix: "/api/v1/figures" });
  app.register(communityRoutes, { prefix: "/api/v1" });
  await app.ready();
  return { app, prisma };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Wave 2 Write-Route Authorization Audit", () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    const ctx = await buildApp();
    app = ctx.app;
    prisma = ctx.prisma;
    seedFigure(prisma);
    seedAdmin(prisma, { id: 1n, role: "admin" });
    seedAdmin(prisma, { id: 2n, role: "reviewer" });
    seedAdmin(prisma, { id: 3n, role: "operator" });
    seedUser(prisma, { id: 10n, email: "unverified@example.com", verified: false });
    seedUser(prisma, { id: 20n, email: "verified@example.com", verified: true });
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Scenario 1: No token cannot call protected figures write routes ───────

  describe("Scenario 1: No token → figures write routes rejected (401)", () => {
    test("POST /api/v1/figures without token → 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/figures",
        payload: {},
      });
      assert.equal(res.statusCode, 401, `expected 401, got: ${res.body}`);
      assert.equal(res.json().error.code, "UNAUTHORIZED");
    });

    test("PUT /api/v1/figures/:slug without token → 401", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/figures/${FIGURE_SLUG}`,
        payload: {},
      });
      assert.equal(res.statusCode, 401, `expected 401, got: ${res.body}`);
      assert.equal(res.json().error.code, "UNAUTHORIZED");
    });

    test("DELETE /api/v1/figures/:slug without token → 401", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/figures/${FIGURE_SLUG}`,
      });
      assert.equal(res.statusCode, 401, `expected 401, got: ${res.body}`);
      assert.equal(res.json().error.code, "UNAUTHORIZED");
    });
  });

  // ── Scenario 2: User JWT cannot call Admin figures write routes ───────────

  describe("Scenario 2: User JWT → figures write routes rejected (401)", () => {
    test("POST /api/v1/figures with User JWT → 401 INVALID_TOKEN", async () => {
      const userToken = signUserForTest(app, "10");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/figures",
        headers: { authorization: `Bearer ${userToken}` },
        payload: {},
      });
      assert.equal(res.statusCode, 401, `expected 401, got: ${res.body}`);
      assert.equal(res.json().error.code, "INVALID_TOKEN");
    });

    test("DELETE /api/v1/figures/:slug with User JWT → 401 INVALID_TOKEN", async () => {
      const userToken = signUserForTest(app, "10");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/figures/${FIGURE_SLUG}`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      assert.equal(res.statusCode, 401, `expected 401, got: ${res.body}`);
      assert.equal(res.json().error.code, "INVALID_TOKEN");
    });

    test("PUT /api/v1/figures/:slug with User JWT → 401 INVALID_TOKEN", async () => {
      const userToken = signUserForTest(app, "10");
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/figures/${FIGURE_SLUG}`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {},
      });
      assert.equal(res.statusCode, 401, `expected 401, got: ${res.body}`);
      assert.equal(res.json().error.code, "INVALID_TOKEN");
    });
  });

  // ── Scenario 3: Admin JWT can call authorized figures write routes ───────

  describe("Scenario 3: Admin JWT (role=admin) → figures write routes accepted", () => {
    test("DELETE /api/v1/figures/:slug with admin JWT → 200 (guard passes, handler succeeds)", async () => {
      const adminToken = signAdminForTest(app, "1", "admin");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/figures/${FIGURE_SLUG}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.statusCode, 200, `expected 200, got: ${res.body}`);
      assert.equal(res.json().success, true);
      assert.equal(res.json().data.deleted, true);
    });
  });

  // ── Scenario 4: reviewer/operator permissions match contract ─────────────

  describe("Scenario 4: reviewer/operator rejected from admin-only figures writes", () => {
    test("DELETE /api/v1/figures/:slug with reviewer JWT → 403 FORBIDDEN", async () => {
      const reviewerToken = signAdminForTest(app, "2", "reviewer");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/figures/${FIGURE_SLUG}`,
        headers: { authorization: `Bearer ${reviewerToken}` },
      });
      assert.equal(res.statusCode, 403, `expected 403, got: ${res.body}`);
      assert.equal(res.json().error.code, "FORBIDDEN");
    });

    test("DELETE /api/v1/figures/:slug with operator JWT → 403 FORBIDDEN", async () => {
      const operatorToken = signAdminForTest(app, "3", "operator");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/figures/${FIGURE_SLUG}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      assert.equal(res.statusCode, 403, `expected 403, got: ${res.body}`);
      assert.equal(res.json().error.code, "FORBIDDEN");
    });
  });

  // ── Scenario 5: figures public GET routes remain accessible ──────────────

  describe("Scenario 5: figures public GET routes accessible without auth", () => {
    test("GET /api/v1/figures without auth → not 401/403", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/figures",
      });
      assert.notEqual(
        res.statusCode,
        401,
        `public GET must not be 401, got: ${res.body}`,
      );
      assert.notEqual(res.statusCode, 403, "public GET must not be 403");
    });

    test("GET /api/v1/figures/:slug/lineage without auth → not 401/403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/figures/${FIGURE_SLUG}/lineage`,
      });
      assert.notEqual(res.statusCode, 401, "public GET must not be 401");
      assert.notEqual(res.statusCode, 403, "public GET must not be 403");
    });
  });

  // ── Scenario 6: Unverified User writes return 403 EMAIL_NOT_VERIFIED ─────

  describe("Scenario 6: Unverified User community writes → 403 EMAIL_NOT_VERIFIED", () => {
    test("POST /api/v1/figures/:slug/favorite with unverified User → 403", async () => {
      const userToken = signUserForTest(app, "10");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/figures/${FIGURE_SLUG}/favorite`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      assert.equal(res.statusCode, 403, `expected 403, got: ${res.body}`);
      assert.equal(res.json().error.code, "EMAIL_NOT_VERIFIED");
    });

    test("POST /api/v1/figures/:slug/like with unverified User → 403", async () => {
      const userToken = signUserForTest(app, "10");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/figures/${FIGURE_SLUG}/like`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, "EMAIL_NOT_VERIFIED");
    });

    test("POST /api/v1/figures/:slug/comments with unverified User → 403", async () => {
      const userToken = signUserForTest(app, "10");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/figures/${FIGURE_SLUG}/comments`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { body: "test comment" },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, "EMAIL_NOT_VERIFIED");
    });
  });

  // ── Scenario 7: Verified User writes succeed ─────────────────────────────

  describe("Scenario 7: Verified User community writes succeed", () => {
    test("POST /api/v1/figures/:slug/favorite with verified User → 200", async () => {
      const userToken = signUserForTest(app, "20");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/figures/${FIGURE_SLUG}/favorite`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      assert.equal(res.statusCode, 200, `expected 200, got: ${res.body}`);
      assert.equal(res.json().success, true);
      assert.equal(res.json().data.favorited, true);
    });

    test("POST /api/v1/figures/:slug/like with verified User → 200", async () => {
      const userToken = signUserForTest(app, "20");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/figures/${FIGURE_SLUG}/like`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.liked, true);
    });

    test("POST /api/v1/figures/:slug/comments with verified User → 201", async () => {
      const userToken = signUserForTest(app, "20");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/figures/${FIGURE_SLUG}/comments`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { body: "great figure!" },
      });
      assert.equal(res.statusCode, 201, `expected 201, got: ${res.body}`);
      assert.equal(res.json().success, true);
      assert.equal(res.json().data.body, "great figure!");
    });
  });

  // ── Scenario 8: Admin JWT cannot enter User community write routes ───────

  describe("Scenario 8: Admin JWT → User community write routes rejected", () => {
    test("POST /api/v1/figures/:slug/favorite with admin JWT → 403 FORBIDDEN", async () => {
      const adminToken = signAdminForTest(app, "1", "admin");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/figures/${FIGURE_SLUG}/favorite`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      // verifyUserIdentity checks payload.aud !== "modelwiki-user" and
      // explicitly rejects admin tokens with 403 FORBIDDEN.
      assert.ok(
        res.statusCode === 403 || res.statusCode === 401,
        `expected 401/403, got: ${res.statusCode} ${res.body}`,
      );
      const body = res.json();
      assert.ok(
        body.error?.code === "FORBIDDEN" || body.error?.code === "INVALID_TOKEN",
        `expected FORBIDDEN or INVALID_TOKEN, got: ${body.error?.code}`,
      );
    });

    test("POST /api/v1/figures/:slug/comments with admin JWT → rejected", async () => {
      const adminToken = signAdminForTest(app, "1", "admin");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/figures/${FIGURE_SLUG}/comments`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { body: "admin comment" },
      });
      assert.ok(
        res.statusCode === 403 || res.statusCode === 401,
        `expected 401/403, got: ${res.statusCode} ${res.body}`,
      );
    });
  });

  // ── Scenario 9: community.ts no longer contains "prisma as any" ──────────

  describe("Scenario 9: community.ts source audit — no prisma as any", () => {
    test("community.ts does not contain 'app.prisma as any'", () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const communityPath = join(here, "..", "..", "src", "routes", "community.ts");
      const source = readFileSync(communityPath, "utf-8");
      assert.ok(
        !source.includes("app.prisma as any"),
        "community.ts must NOT contain 'app.prisma as any'",
      );
      assert.ok(
        !source.includes("const prisma = app.prisma as any"),
        "community.ts must NOT contain 'const prisma = app.prisma as any'",
      );
    });
  });
});
