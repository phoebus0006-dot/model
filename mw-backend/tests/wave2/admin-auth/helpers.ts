// Shared test helpers for Wave 2 admin-auth tests.
//
// Two modes:
//   1. Mock-based (default): a stateful in-memory Prisma + Redis mock. These
//      tests run WITHOUT any database and verify route/guard/audit/CLI logic.
//   2. Real-DB: when DATABASE_URL + REDIS_URL point at a disposable localhost
//      instance, real-DB tests exercise actual Prisma queries. They skip
//      gracefully otherwise (contract: NOT_TESTED acceptable without a
//      disposable PG/Redis).
//
// JWT registration: this helper registers TWO independent @fastify/jwt plugins:
//   - User JWT (default namespace):  USER_TEST_SECRET,  aud=modelwiki-user
//   - Admin JWT (namespace "admin"): ADMIN_TEST_SECRET, aud=modelwiki-admin
// This mirrors the production runtime (src/runtime/jwt.ts) and ensures that
// signAdminToken/verifyAdminToken use app.jwt.admin (backed by ADMIN_TEST_SECRET),
// completely separate from app.jwt (backed by USER_TEST_SECRET).

import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { adminAuthRoutes } from "../../../src/routes/admin-auth.js";
import { signAdminToken } from "../../../src/plugins/admin-auth/token.js";
import { ADMIN_JWT_AUDIENCE, ADMIN_JWT_TTL_SECONDS } from "../../../src/plugins/admin-auth/constants.js";
import { USER_JWT_AUDIENCE } from "../../../src/runtime/config.js";

/**
 * Independent test secrets for User and Admin JWT namespaces. These MUST be
 * different so that cross-secret signature verification failures are exercised
 * (a token signed with USER_TEST_SECRET must NOT verify under ADMIN_TEST_SECRET
 * and vice-versa).
 */
export const USER_TEST_SECRET = "test-user-secret-for-admin-auth-tests-32!!";
export const ADMIN_TEST_SECRET = "test-admin-secret-for-admin-auth-tests-32!!";

/**
 * Deprecated: kept for backwards compatibility with tests that still reference
 * TEST_JWT_SECRET. Aliases USER_TEST_SECRET. New tests should use
 * USER_TEST_SECRET / ADMIN_TEST_SECRET explicitly.
 */
export const TEST_JWT_SECRET = USER_TEST_SECRET;

export interface MockAdminRow {
  id: bigint;
  username: string;
  normalizedUsername: string;
  passwordHash: string;
  displayName: string;
  role: string;
  isActive: boolean;
  sessionVersion: number;
  lastLoginAt: Date | null;
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PrismaMock {
  _admins: Map<string, MockAdminRow>;
  _auditLogs: Array<Record<string, unknown>>;
  adminAccount: {
    findUnique(args: { where: Record<string, unknown>; select?: unknown }): Promise<MockAdminRow | null>;
    update(args: { where: Record<string, unknown>; data: Record<string, unknown>; select?: unknown }): Promise<MockAdminRow>;
    create(args: { data: Record<string, unknown>; select?: unknown }): Promise<MockAdminRow>;
  };
  adminAuditLog: {
    create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  };
}

export function makePrismaMock(): PrismaMock {
  const admins = new Map<string, MockAdminRow>();
  const auditLogs: Array<Record<string, unknown>> = [];
  let nextId = 1n;

  function findRow(where: Record<string, unknown>): MockAdminRow | undefined {
    if (where && "id" in where) return admins.get(String(where.id));
    if (where && "normalizedUsername" in where) {
      for (const row of admins.values()) {
        if (row.normalizedUsername === where.normalizedUsername) return row;
      }
    }
    if (where && "username" in where) {
      for (const row of admins.values()) {
        if (row.username === where.username) return row;
      }
    }
    return undefined;
  }

  return {
    _admins: admins,
    _auditLogs: auditLogs,
    adminAccount: {
      async findUnique({ where }) {
        return findRow(where) ?? null;
      },
      async update({ where, data }) {
        const row = findRow(where);
        if (!row) throw new Error("admin not found in mock");
        Object.assign(row, data);
        return row;
      },
      async create({ data }) {
        const id = nextId++;
        const row: MockAdminRow = {
          id,
          username: String(data.username),
          normalizedUsername: String(data.normalizedUsername ?? String(data.username).toLowerCase()),
          passwordHash: String(data.passwordHash),
          displayName: String(data.displayName),
          role: String(data.role),
          isActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
          sessionVersion: data.sessionVersion !== undefined ? Number(data.sessionVersion) : 0,
          lastLoginAt: null,
          passwordChangedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(data as object),
        } as MockAdminRow;
        // The spread above may have set fields; ensure id/normalized are correct.
        row.id = id;
        if (data.normalizedUsername) row.normalizedUsername = String(data.normalizedUsername);
        admins.set(id.toString(), row);
        return row;
      },
    },
    adminAuditLog: {
      async create({ data }) {
        auditLogs.push({ ...data });
        return { ...data };
      },
    },
  };
}

export interface RedisMock {
  _counts: Map<string, number>;
  _ttls: Map<string, number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string>;
}

export function makeRedisMock(): RedisMock {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  const store = new Map<string, string>();
  return {
    _counts: counts,
    _ttls: ttls,
    async incr(key) {
      const c = (counts.get(key) ?? 0) + 1;
      counts.set(key, c);
      return c;
    },
    async expire(key, seconds) {
      ttls.set(key, seconds);
      return 1;
    },
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/** Seed a mock prisma with an admin account and return its id string. */
export async function seedAdmin(
  prisma: PrismaMock,
  opts: {
    username: string;
    password: string;
    role?: string;
    isActive?: boolean;
    sessionVersion?: number;
    displayName?: string;
  },
): Promise<string> {
  const role = opts.role ?? "admin";
  const normalizedUsername = opts.username.trim().toLowerCase();
  const id = BigInt(prisma._admins.size + 1);
  const row: MockAdminRow = {
    id,
    username: opts.username,
    normalizedUsername,
    passwordHash: await hashPassword(opts.password),
    displayName: opts.displayName ?? opts.username,
    role,
    isActive: opts.isActive ?? true,
    sessionVersion: opts.sessionVersion ?? 0,
    lastLoginAt: null,
    passwordChangedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  prisma._admins.set(id.toString(), row);
  return id.toString();
}

/**
 * Build a Fastify app with DUAL jwt (User + Admin namespaces, independent
 * secrets) + adminAuthRoutes, using the given prisma/redis mocks.
 *
 * The User JWT uses the default namespace (app.jwt.sign/verify) with
 * USER_TEST_SECRET and aud=modelwiki-user. The Admin JWT uses namespace
 * "admin" (app.jwt.admin.sign/verify) with ADMIN_TEST_SECRET and
 * aud=modelwiki-admin. This mirrors the production runtime registration in
 * src/index.ts.
 */
export async function buildApp(prisma: PrismaMock, redis: RedisMock): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as unknown as { prisma: unknown }).prisma = prisma;
  (app as unknown as { redis: unknown }).redis = redis;
  // User JWT — default namespace (app.jwt.sign / app.jwt.verify)
  await app.register(jwt, {
    secret: USER_TEST_SECRET,
    sign: { algorithm: "HS256", aud: USER_JWT_AUDIENCE, expiresIn: "2h" },
    verify: { allowedAud: USER_JWT_AUDIENCE },
  });
  // Admin JWT — admin namespace (app.jwt.admin.sign / app.jwt.admin.verify)
  await app.register(jwt, {
    secret: ADMIN_TEST_SECRET,
    namespace: "admin",
    decoratorName: "admin",
    sign: { algorithm: "HS256", aud: ADMIN_JWT_AUDIENCE, expiresIn: ADMIN_JWT_TTL_SECONDS },
    verify: { allowedAud: ADMIN_JWT_AUDIENCE },
  });
  app.register(adminAuthRoutes);
  await app.ready();
  return app;
}

/** Sign an admin token directly (bypassing the login route) for guard tests. */
export function signAdmin(app: FastifyInstance, opts: { adminId: string; role: string; sessionVersion: number }): string {
  return signAdminToken(app, opts);
}

/**
 * Sign a User-style token (aud=modelwiki-user) using the USER_TEST_SECRET via
 * the default app.jwt.sign. Used to assert that User tokens are rejected by
 * the admin guard.
 */
export function signUserToken(app: FastifyInstance, payload: Record<string, unknown>): string {
  // Mimic the frontend User JWT: aud is set by the sign options (modelwiki-user).
  return app.jwt.sign(payload, { expiresIn: "2h" });
}

/**
 * Sign a token with an explicit (wrong) audience using USER_TEST_SECRET via
 * app.jwt.sign. Used to assert that wrong-audience tokens are rejected by the
 * admin guard (signature mismatch AND audience mismatch).
 *
 * NOTE: This signs with USER_TEST_SECRET (the User secret), NOT ADMIN_TEST_SECRET.
 * For a real admin token signed with the Admin secret, use signAdmin() instead.
 */
export function signTokenWithAud(app: FastifyInstance, payload: Record<string, unknown>, aud: string): string {
  return app.jwt.sign({ ...payload, aud }, { expiresIn: "2h" });
}

/**
 * Normalize the `set-cookie` response header into an array of cookie strings.
 * Fastify's inject returns a single string when there is one Set-Cookie header
 * and an array when there are multiple — this smooths over the difference.
 */
export function getSetCookies(res: { headers: Record<string, unknown> }): string[] {
  const v = res.headers["set-cookie"];
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") return [v];
  return [];
}

export { ADMIN_JWT_AUDIENCE, ADMIN_JWT_TTL_SECONDS, USER_JWT_AUDIENCE };

/** True when a disposable localhost PG + Redis are configured. */
export const HAS_REAL_DB =
  !!process.env.DATABASE_URL &&
  !!process.env.REDIS_URL &&
  (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1"));
