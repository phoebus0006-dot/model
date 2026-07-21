// Real Fastify app.inject() integration test suite for Wave 2 Auth & Email Contract.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { authRoutes } from "../../../src/routes/auth.js";
import { adminAuthRoutes } from "../../../src/routes/admin-auth.js";
import { communityRoutes } from "../../../src/routes/community.js";
import { USER_AUDIENCE } from "../../../src/plugins/user-auth/guard.js";
import { verifyAdminIdentity } from "../../../src/plugins/admin-auth/guard.js";
import { loadRuntimeConfig, buildUserJwtOptions, buildAdminJwtOptions } from "../../../src/runtime/index.js";
import { registerBigIntSerializer } from "../../../src/plugins/bigintSerializer.js";

const USER_SECRET = "test-user-secret-must-be-32-chars-long!";
const ADMIN_SECRET = "test-admin-secret-must-be-32-chars-long!";

describe("Real Fastify app.inject() Auth & Email Integration Tests", () => {
  let app: FastifyInstance;
  let prismaMock: any;
  let redisMock: any;
  let mockUsers: any[];
  let mockAdmins: any[];
  let mockFigures: any[];
  let mockFavorites: any[];
  let mockLikes: any[];
  let mockComments: any[];

  before(async () => {
    const userHash = await bcrypt.hash("Password123!", 10);
    const adminHash = await bcrypt.hash("AdminPass123!", 10);

    mockUsers = [
      {
        id: 1n,
        username: "noemail_user",
        passwordHash: userHash,
        email: null,
        normalizedEmail: null,
        emailVerifiedAt: null,
        displayName: "noemail_user",
        avatarUrl: null,
        role: "user",
        isActive: true,
        sessionVersion: 0,
        createdAt: new Date()
      }
    ];

    mockAdmins = [
      {
        id: 1n,
        username: "admin_user",
        normalizedUsername: "admin_user",
        passwordHash: adminHash,
        displayName: "admin_user",
        role: "admin",
        isActive: true,
        sessionVersion: 0,
        createdAt: new Date()
      }
    ];

    mockFigures = [{ id: 10n, slug: "test-figure", name: "Test Figure", isDeleted: false }];
    mockFavorites = [];
    mockLikes = [];
    mockComments = [];

    let nextUserId = 2n;
    let nextAdminId = 2n;
    let nextFavId = 1n;
    let nextLikeId = 1n;
    let nextCommentId = 1n;

    prismaMock = {
      user: {
        async findUnique({ where }: any) {
          if (!where) return null;
          if (where.id !== undefined) return mockUsers.find(u => u.id === BigInt(where.id)) || null;
          if (where.username !== undefined) return mockUsers.find(u => u.username === where.username) || null;
          if (where.displayName !== undefined) return mockUsers.find(u => u.displayName === where.displayName) || null;
          return null;
        },
        async findFirst({ where }: any) {
          if (!where) return null;
          const target = where.username || where.displayName;
          if (target) return mockUsers.find(u => u.username === target || u.displayName === target) || null;
          return null;
        },
        async create({ data }: any) {
          const u = {
            id: nextUserId++,
            username: data.displayName || data.username,
            passwordHash: data.passwordHash,
            email: data.email ?? null,
            normalizedEmail: data.normalizedEmail ?? null,
            emailVerifiedAt: data.emailVerifiedAt ?? null,
            displayName: data.displayName ?? data.username,
            avatarUrl: null,
            role: data.role ?? "user",
            isActive: data.isActive ?? true,
            sessionVersion: data.sessionVersion ?? 0,
            createdAt: new Date(),
          };
          mockUsers.push(u);
          return u;
        },
        async update({ where, data }: any) {
          const u = mockUsers.find(x => x.id === BigInt(where.id));
          if (u) Object.assign(u, data);
          return u;
        }
      },
      adminAccount: {
        async findUnique({ where }: any) {
          if (!where) return null;
          if (where.id !== undefined) return mockAdmins.find(a => a.id === BigInt(where.id)) || null;
          if (where.username !== undefined) return mockAdmins.find(a => a.username === where.username) || null;
          if (where.normalizedUsername !== undefined) return mockAdmins.find(a => a.username.toLowerCase() === where.normalizedUsername.toLowerCase()) || null;
          return null;
        },
        async findFirst({ where }: any) {
          if (!where) return null;
          const target = where.username || where.displayName || where.normalizedUsername;
          if (target) return mockAdmins.find(a => a.username.toLowerCase() === target.toLowerCase()) || null;
          return null;
        },
        async create({ data }: any) {
          const a = {
            id: nextAdminId++,
            username: data.username,
            normalizedUsername: data.username.toLowerCase(),
            passwordHash: data.passwordHash,
            displayName: data.displayName ?? data.username,
            role: data.role ?? "admin",
            isActive: data.isActive ?? true,
            sessionVersion: data.sessionVersion ?? 0,
            createdAt: new Date(),
          };
          mockAdmins.push(a);
          return a;
        },
        async update({ where, data }: any) {
          const a = mockAdmins.find(x => x.id === BigInt(where.id));
          if (a) Object.assign(a, data);
          return a;
        }
      },
      figure: {
        async findFirst({ where }: any) {
          return mockFigures.find(f => f.slug === where.slug && !f.isDeleted) || null;
        }
      },
      favorite: {
        async count() { return mockFavorites.length; },
        async findUnique({ where }: any) {
          return mockFavorites.find(f => f.userId === where.userId_figureId.userId && f.figureId === where.userId_figureId.figureId) || null;
        },
        async upsert({ where, create }: any) {
          let f = mockFavorites.find(x => x.userId === where.userId_figureId.userId && x.figureId === where.userId_figureId.figureId);
          if (!f) {
            f = { id: nextFavId++, userId: create.userId, figureId: create.figureId };
            mockFavorites.push(f);
          }
          return f;
        },
        async deleteMany({ where }: any) {
          mockFavorites = mockFavorites.filter(x => !(x.userId === where.userId && x.figureId === where.figureId));
          return { count: 1 };
        }
      },
      figureLike: {
        async count() { return mockLikes.length; },
        async findUnique({ where }: any) {
          return mockLikes.find(l => l.userId === where.userId_figureId.userId && l.figureId === where.userId_figureId.figureId) || null;
        },
        async upsert({ where, create }: any) {
          let l = mockLikes.find(x => x.userId === where.userId_figureId.userId && x.figureId === where.userId_figureId.figureId);
          if (!l) {
            l = { id: nextLikeId++, userId: create.userId, figureId: create.figureId };
            mockLikes.push(l);
          }
          return l;
        },
        async deleteMany({ where }: any) {
          mockLikes = mockLikes.filter(x => !(x.userId === where.userId && x.figureId === where.figureId));
          return { count: 1 };
        }
      },
      figureComment: {
        async count() { return mockComments.length; },
        async create({ data }: any) {
          const c = { id: nextCommentId++, ...data, createdAt: new Date(), isDeleted: false };
          mockComments.push(c);
          return c;
        }
      }
    };

    redisMock = {
      async incr() { return 1; },
      async expire() { return true; },
      async eval() { return 1; }
    };

    app = Fastify({ logger: false });
    app.decorate("prisma", prismaMock);
    app.decorate("redis", redisMock);
    registerBigIntSerializer(app);

    const cfg = {
      isProduction: false,
      userJwtSecret: USER_SECRET,
      adminJwtSecret: ADMIN_SECRET,
      jwtExpiresIn: "2h",
      rateLimitMax: 100,
      rateLimitTimeWindow: "1 minute",
    };

    await app.register(jwt, buildUserJwtOptions(cfg as any));
    await app.register(jwt, buildAdminJwtOptions(cfg as any));

    app.register(authRoutes, { prefix: "/api/v1/auth" });
    app.register(adminAuthRoutes, { prefix: "/api/v1/admin/auth" });
    app.register(communityRoutes, { prefix: "/api/v1" });

    app.get("/api/v1/admin/test-guarded", async (req, reply) => {
      const ok = await verifyAdminIdentity(app, req, reply);
      if (!ok) return;
      return { success: true, data: "admin-ok" };
    });

    await app.ready();
  });

  test("1. POST /api/v1/auth/register without email succeeds", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "brand_new_user", password: "Password123!" }
    });
    assert.equal(res.statusCode, 201, `register failed: ${res.body}`);
    const body = res.json();
    assert.equal(body.success, true);
  });

  test("2. POST /api/v1/auth/login without email succeeds", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "noemail_user", password: "Password123!" }
    });
    assert.equal(res.statusCode, 200, `login failed: ${res.body}`);
    const body = res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.token);
  });

  test("3. POST /api/v1/admin/auth/login succeeds", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/auth/login",
      payload: { username: "admin_user", password: "AdminPass123!" }
    });
    assert.equal(res.statusCode, 200, `admin login failed: ${res.body}`);
    const body = res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.token);
  });

  test("4. User JWT calling protected User route GET /api/v1/auth/me succeeds", async () => {
    const user = mockUsers.find(u => u.username === "noemail_user");
    assert.ok(user);
    const token = app.jwt.sign({ userId: user.id.toString(), sessionVersion: user.sessionVersion, aud: USER_AUDIENCE });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.user.username, "noemail_user");
  });

  test("5. Admin JWT calling User write route is rejected (403/401)", async () => {
    const admin = mockAdmins.find(a => a.username === "admin_user");
    assert.ok(admin);
    const adminToken = (app.jwt as any).admin.sign({ adminId: admin.id.toString(), sessionVersion: admin.sessionVersion, aud: "modelwiki-admin" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/figures/test-figure/favorite",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.ok(res.statusCode === 403 || res.statusCode === 401);
  });

  test("6. User JWT calling Admin route is rejected (403/401)", async () => {
    const user = mockUsers.find(u => u.username === "noemail_user");
    assert.ok(user);
    const userToken = app.jwt.sign({ userId: user.id.toString(), sessionVersion: user.sessionVersion, aud: USER_AUDIENCE });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/test-guarded",
      headers: { authorization: `Bearer ${userToken}` }
    });
    assert.ok(res.statusCode === 403 || res.statusCode === 401);
  });

  test("7. Email-less user can execute POST /figures/:slug/favorite (200 OK)", async () => {
    const user = mockUsers.find(u => u.username === "noemail_user");
    assert.ok(user);
    const token = app.jwt.sign({ userId: user.id.toString(), sessionVersion: user.sessionVersion, aud: USER_AUDIENCE });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/figures/test-figure/favorite",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.favorited, true);
  });

  test("8. Email-less user can execute POST /figures/:slug/like (200 OK)", async () => {
    const user = mockUsers.find(u => u.username === "noemail_user");
    assert.ok(user);
    const token = app.jwt.sign({ userId: user.id.toString(), sessionVersion: user.sessionVersion, aud: USER_AUDIENCE });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/figures/test-figure/like",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.liked, true);
  });

  test("9. Email-less user can execute POST /figures/:slug/comments (201 Created)", async () => {
    const user = mockUsers.find(u => u.username === "noemail_user");
    assert.ok(user);
    const token = app.jwt.sign({ userId: user.id.toString(), sessionVersion: user.sessionVersion, aud: USER_AUDIENCE });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/figures/test-figure/comments",
      headers: { authorization: `Bearer ${token}` },
      payload: { body: "Great figure!" }
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.success, true);
  });

  test("10. Deactivated user is rejected (401 UNAUTHORIZED)", async () => {
    const user = mockUsers.find(u => u.username === "noemail_user");
    assert.ok(user);
    user.isActive = false;
    const token = app.jwt.sign({ userId: user.id.toString(), sessionVersion: user.sessionVersion, aud: USER_AUDIENCE });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.statusCode, 401);
    user.isActive = true; // Restore
  });

  test("11. SessionVersion mismatch is rejected (401 SESSION_EXPIRED)", async () => {
    const user = mockUsers.find(u => u.username === "noemail_user");
    assert.ok(user);
    const oldToken = app.jwt.sign({ userId: user.id.toString(), sessionVersion: 0, aud: USER_AUDIENCE });
    user.sessionVersion = 1; // Updated in DB

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${oldToken}` }
    });
    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "SESSION_EXPIRED");
    user.sessionVersion = 0; // Restore
  });

  test("12. Production runtime config fails if USER_JWT_SECRET === ADMIN_JWT_SECRET", () => {
    const envBackup = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.USER_JWT_SECRET = "identical-secret-32-chars-long!!!!!";
    process.env.ADMIN_JWT_SECRET = "identical-secret-32-chars-long!!!!!";
    process.env.REVIEW_CACHE_SIGNING_SECRET = "review-cache-signing-secret-32-chars!!";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.REDIS_URL = "redis://localhost:6379";

    assert.throws(() => {
      loadRuntimeConfig();
    }, /USER_JWT_SECRET and ADMIN_JWT_SECRET must NOT be identical in production/);

    process.env.NODE_ENV = envBackup;
  });
});
