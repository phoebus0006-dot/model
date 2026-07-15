// Integration tests for requireVerifiedUser on User write routes.
//
// Contract (Wave 2 Integration Fix):
//   - Unverified users CAN log in and read (GET /me/space).
//   - Unverified users CANNOT write (POST /figures/:slug/favorite → 403 EMAIL_NOT_VERIFIED).
//   - Verified users CAN write (POST /figures/:slug/favorite → 200).
//   - Admin JWTs are rejected from User write routes (403 FORBIDDEN).
//
// Run: npx tsx --test tests/wave2/user-auth/verified-write-routes.test.ts

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { authRoutes } from "../../../src/routes/auth.js";
import { communityRoutes } from "../../../src/routes/community.js";
import { USER_AUDIENCE } from "../../../src/plugins/user-auth/guard.js";
import { resetSentMail } from "../../../src/services/user-auth/mailer.js";
import { registerBigIntSerializer } from "../../../src/plugins/bigintSerializer.js";

const TEST_JWT_SECRET = "test-verified-write-routes-secret-32!";

// ─── Mock data structures ──────────────────────────────────────────────────

interface MockUser {
  id: bigint;
  email: string | null;
  normalizedEmail: string | null;
  emailVerifiedAt: Date | null;
  emailVerifyTokenHash: string | null;
  emailVerifyExpiresAt: Date | null;
  passwordResetTokenHash: string | null;
  passwordResetExpiresAt: Date | null;
  passwordHash: string | null;
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
}

// ─── Mock Prisma ───────────────────────────────────────────────────────────

function makePrismaMock() {
  const users: MockUser[] = [];
  const figures: MockFigure[] = [];
  const favorites: any[] = [];
  const figureLikes: any[] = [];
  const figureComments: any[] = [];
  let nextUserId = 1n;
  let nextFavId = 1n;
  let nextLikeId = 1n;
  let nextCommentId = 1n;

  function findById(id: bigint): MockUser | null {
    return users.find((u) => u.id === id) || null;
  }
  function findByNormalizedEmail(ne: string): MockUser | null {
    return users.find((u) => u.normalizedEmail === ne) || null;
  }
  function project(user: MockUser): any {
    return { ...user };
  }

  return {
    _users: users,
    _figures: figures,
    _favorites: favorites,
    _figureLikes: figureLikes,
    _figureComments: figureComments,

    user: {
      async create({ data }: { data: any }): Promise<any> {
        if (users.some((u) => u.normalizedEmail === data.normalizedEmail)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "6.0.0",
          });
        }
        const user: MockUser = {
          id: nextUserId++,
          email: data.email ?? null,
          normalizedEmail: data.normalizedEmail ?? null,
          emailVerifiedAt: data.emailVerifiedAt ?? null,
          emailVerifyTokenHash: data.emailVerifyTokenHash ?? null,
          emailVerifyExpiresAt: data.emailVerifyExpiresAt ?? null,
          passwordResetTokenHash: data.passwordResetTokenHash ?? null,
          passwordResetExpiresAt: data.passwordResetExpiresAt ?? null,
          passwordHash: data.passwordHash ?? null,
          sessionVersion: data.sessionVersion ?? 0,
          displayName: data.displayName,
          avatarUrl: data.avatarUrl ?? null,
          role: data.role ?? "user",
          isActive: data.isActive ?? true,
          createdAt: new Date(),
        };
        users.push(user);
        return project(user);
      },

      async findUnique({ where, select }: { where: any; select?: any }): Promise<any> {
        let user: MockUser | null = null;
        if ("normalizedEmail" in where) user = findByNormalizedEmail(where.normalizedEmail);
        else if ("id" in where) user = findById(where.id);
        if (!user) return null;
        const proj = project(user);
        // Only return selected fields if select is specified
        if (select) {
          const filtered: any = {};
          for (const key of Object.keys(select)) {
            if (key in proj) filtered[key] = proj[key];
          }
          return filtered;
        }
        return proj;
      },

      async findFirst({ where }: { where: any }): Promise<any> {
        if (where.emailVerifyTokenHash !== undefined) {
          const expGt = where.emailVerifyExpiresAt?.gt;
          const expDate = expGt ? new Date(expGt) : new Date();
          const user = users.find(
            (u) =>
              u.emailVerifyTokenHash === where.emailVerifyTokenHash &&
              u.emailVerifyExpiresAt !== null &&
              u.emailVerifyExpiresAt > expDate,
          );
          return user ? project(user) : null;
        }
        if (where.passwordResetTokenHash !== undefined) {
          const expGt = where.passwordResetExpiresAt?.gt;
          const expDate = expGt ? new Date(expGt) : new Date();
          const user = users.find(
            (u) =>
              u.passwordResetTokenHash === where.passwordResetTokenHash &&
              u.passwordResetExpiresAt !== null &&
              u.passwordResetExpiresAt > expDate,
          );
          return user ? project(user) : null;
        }
        return null;
      },

      async update({ where, data }: { where: any; data: any }): Promise<any> {
        let user: MockUser | null = null;
        if ("id" in where) user = findById(where.id);
        if (!user) throw new Error("mock: user not found for update");
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as any)) {
            (user as any)[k] = (user as any)[k] + (v as any).increment;
          } else {
            (user as any)[k] = v;
          }
        }
        return project(user);
      },
    },

    figure: {
      async findFirst({ where, select }: { where: any; select?: any }): Promise<any> {
        const fig = figures.find((f) => f.slug === where.slug && f.isDeleted === (where.isDeleted ?? false));
        if (!fig) return null;
        if (select) {
          const filtered: any = {};
          for (const key of Object.keys(select)) {
            if (key in fig) filtered[key] = fig[key];
          }
          return filtered;
        }
        return { ...fig };
      },
      async findMany(): Promise<any[]> {
        return figures.map((f) => ({ ...f }));
      },
    },

    favorite: {
      async findMany({ where }: { where: any }): Promise<any[]> {
        return favorites.filter((f) => f.userId === where.userId).map((f) => ({ ...f, figure: { id: FIGURE_ID, slug: FIGURE_SLUG, name: "Test Figure", images: [] } }));
      },
      async upsert({ where, create }: { where: any; create: any }): Promise<any> {
        const existing = favorites.find(
          (f) => f.userId === where.userId_figureId.userId && f.figureId === where.userId_figureId.figureId,
        );
        if (existing) return existing;
        const fav = { id: nextFavId++, userId: create.userId, figureId: create.figureId, createdAt: new Date() };
        favorites.push(fav);
        return fav;
      },
      async deleteMany({ where }: { where: any }): Promise<{ count: number }> {
        const before = favorites.length;
        for (let i = favorites.length - 1; i >= 0; i--) {
          if (favorites[i].userId === where.userId && favorites[i].figureId === where.figureId) {
            favorites.splice(i, 1);
          }
        }
        return { count: before - favorites.length };
      },
      async findUnique({ where }: { where: any }): Promise<any> {
        return favorites.find(
          (f) => f.userId === where.userId_figureId.userId && f.figureId === where.userId_figureId.figureId,
        ) || null;
      },
      async count({ where }: { where: any }): Promise<number> {
        return favorites.filter((f) => f.figureId === where.figureId).length;
      },
    },

    figureLike: {
      async findMany({ where }: { where: any }): Promise<any[]> {
        return figureLikes.filter((l) => l.userId === where.userId).map((l) => ({ ...l, figure: { id: FIGURE_ID, slug: FIGURE_SLUG, name: "Test Figure", images: [] } }));
      },
      async upsert({ where, create }: { where: any; create: any }): Promise<any> {
        const existing = figureLikes.find(
          (l) => l.userId === where.userId_figureId.userId && l.figureId === where.userId_figureId.figureId,
        );
        if (existing) return existing;
        const like = { id: nextLikeId++, userId: create.userId, figureId: create.figureId, createdAt: new Date() };
        figureLikes.push(like);
        return like;
      },
      async deleteMany({ where }: { where: any }): Promise<{ count: number }> {
        const before = figureLikes.length;
        for (let i = figureLikes.length - 1; i >= 0; i--) {
          if (figureLikes[i].userId === where.userId && figureLikes[i].figureId === where.figureId) {
            figureLikes.splice(i, 1);
          }
        }
        return { count: before - figureLikes.length };
      },
      async findUnique({ where }: { where: any }): Promise<any> {
        return figureLikes.find(
          (l) => l.userId === where.userId_figureId.userId && l.figureId === where.userId_figureId.figureId,
        ) || null;
      },
      async count({ where }: { where: any }): Promise<number> {
        return figureLikes.filter((l) => l.figureId === where.figureId).length;
      },
    },

    figureComment: {
      async create({ data, select }: { data: any; select?: any }): Promise<any> {
        const comment = {
          id: nextCommentId++,
          body: data.body,
          createdAt: new Date(),
          userId: data.userId,
          figureId: data.figureId,
          isDeleted: false,
        };
        figureComments.push(comment);
        // Return with user relation if select includes it
        const user = users.find((u) => u.id === data.userId);
        return {
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          user: { id: user?.id, displayName: user?.displayName, avatarUrl: user?.avatarUrl },
        };
      },
      async findMany({ where, select, take, orderBy }: { where: any; select?: any; take?: number; orderBy?: any }): Promise<any[]> {
        let result = figureComments.filter((c) => c.figureId === where.figureId && !c.isDeleted);
        if (take) result = result.slice(0, take);
        return result.map((c) => {
          const user = users.find((u) => u.id === c.userId);
          return {
            id: c.id,
            body: c.body,
            createdAt: c.createdAt,
            user: { id: user?.id, displayName: user?.displayName, avatarUrl: user?.avatarUrl },
          };
        });
      },
      async count({ where }: { where: any }): Promise<number> {
        return figureComments.filter((c) => c.figureId === where.figureId && !c.isDeleted).length;
      },
    },
  };
}

function makeRedisMock() {
  const store = new Map<string, number>();
  return {
    _store: store,
    async incr(key: string): Promise<number> {
      const v = (store.get(key) || 0) + 1;
      store.set(key, v);
      return v;
    },
    async expire(_key: string, _ttl: number): Promise<number> {
      return 1;
    },
  };
}

// ─── App builder ────────────────────────────────────────────────────────────

interface TestCtx {
  app: FastifyInstance;
  prisma: ReturnType<typeof makePrismaMock>;
  redis: ReturnType<typeof makeRedisMock>;
}

async function buildApp(): Promise<TestCtx> {
  const prisma = makePrismaMock();
  const redis = makeRedisMock();
  const app = Fastify({ logger: false });
  (app as any).prisma = prisma;
  (app as any).redis = redis;
  registerBigIntSerializer(app);
  await app.register(jwt, {
    secret: TEST_JWT_SECRET,
    sign: { algorithm: "HS256", expiresIn: "2h" },
  });
  app.register(authRoutes, { prefix: "/api/v1/auth" });
  app.register(communityRoutes, { prefix: "/api/v1" });
  await app.ready();
  return { app, prisma, redis };
}

// ─── Env management ─────────────────────────────────────────────────────────

const SAVED_ENV: Record<string, string | undefined> = {};

function enableStubSmtp() {
  process.env.SMTP_TRANSPORT = "stub";
  process.env.SMTP_HOST = "stub.example.com";
  process.env.SMTP_FROM = "noreply@example.com";
}

function disableSmtp() {
  delete process.env.SMTP_TRANSPORT;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const STRONG_PWD = "SecurePass!123";
const FIGURE_SLUG = "test-figure";
const FIGURE_ID = 1n;

function seedFigure(ctx: TestCtx) {
  ctx.prisma._figures.push({
    id: FIGURE_ID,
    slug: FIGURE_SLUG,
    name: "Test Figure",
    isDeleted: false,
  });
}

async function registerAndLogin(
  ctx: TestCtx,
  email = "alice@example.com",
  password = STRONG_PWD,
  displayName = "Alice",
): Promise<{ token: string; userId: string }> {
  const reg = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password, displayName },
  });
  assert.equal(reg.statusCode, 201, `register failed: ${reg.body}`);
  const login = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  assert.equal(login.statusCode, 200, `login failed: ${login.body}`);
  const body = login.json();
  return { token: body.data.token, userId: body.data.user.id };
}

function verifyUserInMock(ctx: TestCtx, userId: string) {
  const user = ctx.prisma._users.find((u) => u.id === BigInt(userId));
  assert.ok(user, "user must exist in mock");
  user.emailVerifiedAt = new Date();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("requireVerifiedUser on User write routes — Wave 2 Integration Fix", () => {
  let ctx: TestCtx;

  before(() => {
    for (const k of ["SMTP_TRANSPORT", "SMTP_HOST", "SMTP_FROM", "NODE_ENV"]) {
      SAVED_ENV[k] = process.env[k];
    }
  });

  beforeEach(async () => {
    enableStubSmtp();
    resetSentMail();
    ctx = await buildApp();
    seedFigure(ctx);
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  after(() => {
    for (const [k, v] of Object.entries(SAVED_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── Test 1: Unverified user can log in ────────────────────────────────────

  test("unverified User logs in successfully", async () => {
    const { token, userId } = await registerAndLogin(ctx);
    assert.ok(token, "token must be returned");
    assert.ok(userId, "userId must be returned");

    // Confirm the user is unverified
    const user = ctx.prisma._users.find((u) => u.id === BigInt(userId));
    assert.equal(user?.emailVerifiedAt, null, "newly registered user must be unverified");
  });

  // ── Test 2: Unverified user can read (GET /me/space) ──────────────────────

  test("unverified User read operation (GET /me/space) is allowed", async () => {
    const { token } = await registerAndLogin(ctx);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/me/space",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200, `unverified read should be 200, got: ${res.body}`);
    const body = res.json();
    assert.equal(body.success, true);
  });

  // ── Test 3: Unverified user cannot write (POST favorite → 403) ────────────

  test("unverified User write operation (POST /figures/:slug/favorite) returns 403 EMAIL_NOT_VERIFIED", async () => {
    const { token } = await registerAndLogin(ctx);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/figures/${FIGURE_SLUG}/favorite`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 403, `unverified write should be 403, got: ${res.body}`);
    const body = res.json();
    assert.equal(body.error.code, "EMAIL_NOT_VERIFIED");
  });

  // ── Test 3b: Unverified user cannot write comments either ─────────────────

  test("unverified User write operation (POST /figures/:slug/comments) returns 403 EMAIL_NOT_VERIFIED", async () => {
    const { token } = await registerAndLogin(ctx);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/figures/${FIGURE_SLUG}/comments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: "test comment" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "EMAIL_NOT_VERIFIED");
  });

  // ── Test 3c: Unverified user cannot like ──────────────────────────────────

  test("unverified User write operation (POST /figures/:slug/like) returns 403 EMAIL_NOT_VERIFIED", async () => {
    const { token } = await registerAndLogin(ctx);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/figures/${FIGURE_SLUG}/like`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "EMAIL_NOT_VERIFIED");
  });

  // ── Test 4: Verified user can write ───────────────────────────────────────

  test("verified User write operation (POST /figures/:slug/favorite) passes", async () => {
    const { token, userId } = await registerAndLogin(ctx);
    verifyUserInMock(ctx, userId);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/figures/${FIGURE_SLUG}/favorite`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200, `verified write should be 200, got: ${res.body}`);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.favorited, true);
  });

  // ── Test 4b: Verified user can comment ────────────────────────────────────

  test("verified User write operation (POST /figures/:slug/comments) passes", async () => {
    const { token, userId } = await registerAndLogin(ctx);
    verifyUserInMock(ctx, userId);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/figures/${FIGURE_SLUG}/comments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: "great figure!" },
    });
    assert.equal(res.statusCode, 201, `verified comment should be 201, got: ${res.body}`);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.body, "great figure!");
  });

  // ── Test 4c: Verified user can like and unlike ────────────────────────────

  test("verified User can like and unlike (POST + DELETE /figures/:slug/like)", async () => {
    const { token, userId } = await registerAndLogin(ctx);
    verifyUserInMock(ctx, userId);

    const likeRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/figures/${FIGURE_SLUG}/like`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(likeRes.statusCode, 200);
    assert.equal(likeRes.json().data.liked, true);

    const unlikeRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/figures/${FIGURE_SLUG}/like`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(unlikeRes.statusCode, 200);
    assert.equal(unlikeRes.json().data.liked, false);
  });

  // ── Test 5: Admin JWT rejected from User write route ──────────────────────

  test("Admin JWT (aud=modelwiki-admin) is rejected from User write route with 403 FORBIDDEN", async () => {
    // Sign a token with admin audience using the same secret (signature passes,
    // but the guard's audience check rejects it).
    const adminToken = (ctx.app as any).jwt.sign({
      adminId: "1",
      role: "admin",
      sessionVersion: 0,
      aud: "modelwiki-admin",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/figures/${FIGURE_SLUG}/favorite`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.statusCode, 403, `admin token should be 403, got: ${res.body}`);
    const body = res.json();
    assert.equal(body.error.code, "FORBIDDEN");
  });

  // ── Test 5b: Admin JWT rejected from User read route too ──────────────────

  test("Admin JWT (aud=modelwiki-admin) is rejected from User read route (GET /me/space) with 403 FORBIDDEN", async () => {
    const adminToken = (ctx.app as any).jwt.sign({
      adminId: "1",
      role: "admin",
      sessionVersion: 0,
      aud: "modelwiki-admin",
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/me/space",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "FORBIDDEN");
  });

  // ── Test 6: No token → 401 ────────────────────────────────────────────────

  test("no token on write route → 401 UNAUTHORIZED", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/figures/${FIGURE_SLUG}/favorite`,
    });
    assert.equal(res.statusCode, 401);
  });

  // ── Test 7: Public read routes still work without auth ────────────────────

  test("public read route (GET /figures/:slug/social) works without auth", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/figures/${FIGURE_SLUG}/social`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
  });
});
