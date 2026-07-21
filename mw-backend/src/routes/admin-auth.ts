// Guanli admin authentication routes.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §3.
// Cross-agent interface: exports `adminAuthRoutes` (WAVE2_AGENT_CONTRACTS.md).
//
// Routes (mounted by the Runtime Agent; recommended prefix "/api/v1/admin/auth"):
//   POST /login            — username + password ONLY (no email)
//   POST /logout           — clears mw_admin_token only
//   POST /change-password  — verifies current, rotates sessionVersion
//   GET  /me               — current admin profile (DB-fresh via guard)
//
// Separation from the User auth system:
//   - Input is { username, password }. An `email` field is REJECTED (400).
//   - JWT audience is "modelwiki-admin" (never "modelwiki-user").
//   - Cookie is "mw_admin_token" (never "mw_user_token").
//   - Rate limit namespace is "rate-limit:admin:login:<ip>".
//
// The logout / change-password / me routes call verifyAdminIdentity internally
// so they are self-contained and do not depend on a globally-mounted guard.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z as zod } from "zod";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import { normalizeUsername, ADMIN_BCRYPT_COST, ADMIN_JWT_TTL_SECONDS } from "../plugins/admin-auth/constants.js";
import { signAdminToken } from "../plugins/admin-auth/token.js";
import { setAdminCookie, clearAdminCookie } from "../plugins/admin-auth/cookies.js";
import {
  writeAdminAudit,
  AUDIT_LOGIN_SUCCESS,
  AUDIT_LOGIN_FAILED,
  AUDIT_LOGOUT,
  AUDIT_PASSWORD_CHANGED,
  TARGET_ADMIN,
} from "../plugins/admin-auth/audit.js";
import { verifyAdminIdentity } from "../plugins/admin-auth/guard.js";
import { checkAdminLoginRateLimit } from "../services/admin-auth/rateLimit.js";

// ─── Password strength (matches the frontend User rules) ─────────────────────
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < PASSWORD_MIN) issues.push(`at least ${PASSWORD_MIN} characters`);
  if (password.length > PASSWORD_MAX) issues.push(`at most ${PASSWORD_MAX} characters`);
  if (!/[A-Z]/.test(password)) issues.push("at least 1 uppercase letter");
  if (!/[a-z]/.test(password)) issues.push("at least 1 lowercase letter");
  if (!/[^A-Za-z0-9]/.test(password)) issues.push("at least 1 special character");
  return issues;
}

// Use zod's superRefine for the new password so the error is a proper
// VALIDATION_ERROR rather than a hand-rolled 400.
const newPasswordSchema = zod.string().superRefine((password, ctx) => {
  const issues = passwordIssues(password);
  if (issues.length > 0) {
    ctx.addIssue({
      code: zod.ZodIssueCode.custom,
      message: `Password is too weak: ${issues.join(", ")}`,
    });
  }
});

const loginSchema = zod.object({
  username: zod.string().min(1).max(100),
  password: zod.string().min(1).max(256),
});

const changePasswordSchema = zod.object({
  currentPassword: zod.string().min(1).max(256),
  newPassword: newPasswordSchema,
});

type LoginInput = zod.infer<typeof loginSchema>;
type ChangePasswordInput = zod.infer<typeof changePasswordSchema>;

function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "";
  return first || req.ip || "unknown";
}

function requestId(req: FastifyRequest): string | null {
  const id = req.id;
  return id === undefined ? null : String(id);
}

function userAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua : null;
}

/** AdminAccount fields needed for login verification. */
interface AdminLoginRow {
  id: bigint;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
  sessionVersion: number;
  passwordHash: string;
}

/**
 * Guanli admin auth routes. Register with a prefix, e.g.:
 *   app.register(adminAuthRoutes, { prefix: "/api/v1/admin/auth" });
 */
export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  const prisma: PrismaClient = app.prisma;
  const redis: Redis = app.redis;

  // ─── POST /login ──────────────────────────────────────────────────────────
  app.post("/login", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Reject email upfront. AdminAccount does NOT use email — sending one is a
    // client bug (or an attempt to reuse User credentials against the admin
    // endpoint). Contract §3.1 + §8 test "email login rejected".
    if (body.email !== undefined) {
      return reply.status(400).send({
        success: false,
        error: { code: "EMAIL_NOT_SUPPORTED", message: "AdminAccount does not use email; provide username" },
      });
    }

    let input: LoginInput;
    try {
      input = loginSchema.parse(body);
    } catch (err) {
      return reply.status(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", details: (err as zod.ZodError).issues },
      });
    }

    const ip = clientIp(req);

    // Independent rate-limit namespace (rate-limit:admin:login:<ip>).
    const { limited } = await checkAdminLoginRateLimit(redis, ip);
    if (limited) {
      return reply.status(429).send({ success: false, error: { code: "RATE_LIMITED" } });
    }

    const normalizedUsername = normalizeUsername(input.username);

    const row: AdminLoginRow | null = await prisma.adminAccount.findUnique({
      where: { normalizedUsername },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        isActive: true,
        sessionVersion: true,
        passwordHash: true,
      },
    });

    // Unified error for unknown username and wrong password (anti-enumeration).
    if (!row) {
      return reply.status(401).send({ success: false, error: { code: "INVALID_CREDENTIALS" } });
    }

    if (!row.isActive) {
      // Login attempt against a disabled account fails. We can attribute this
      // to a real admin id, so write the audit row.
      await writeAdminAudit(prisma, {
        actorAdminId: row.id,
        action: AUDIT_LOGIN_FAILED,
        targetType: TARGET_ADMIN,
        targetId: row.id.toString(),
        requestId: requestId(req),
        ip,
        userAgent: userAgent(req),
      });
      return reply.status(403).send({ success: false, error: { code: "ACCOUNT_DISABLED" } });
    }

    const passwordOk = await bcrypt.compare(input.password, row.passwordHash);
    if (!passwordOk) {
      await writeAdminAudit(prisma, {
        actorAdminId: row.id,
        action: AUDIT_LOGIN_FAILED,
        targetType: TARGET_ADMIN,
        targetId: row.id.toString(),
        requestId: requestId(req),
        ip,
        userAgent: userAgent(req),
      });
      return reply.status(401).send({ success: false, error: { code: "INVALID_CREDENTIALS" } });
    }

    // Success: update lastLoginAt, issue token, set cookie, audit.
    await prisma.adminAccount.update({
      where: { id: row.id },
      data: { lastLoginAt: new Date() },
    });

    const token = signAdminToken(app, {
      adminId: row.id.toString(),
      role: row.role,
      sessionVersion: row.sessionVersion,
    });
    setAdminCookie(reply, token, ADMIN_JWT_TTL_SECONDS);

    await writeAdminAudit(prisma, {
      actorAdminId: row.id,
      action: AUDIT_LOGIN_SUCCESS,
      targetType: TARGET_ADMIN,
      targetId: row.id.toString(),
      requestId: requestId(req),
      ip,
      userAgent: userAgent(req),
    });

    return reply.status(200).send({
      success: true,
      data: {
        token,
        admin: {
          id: row.id.toString(),
          username: row.username,
          displayName: row.displayName,
          role: row.role,
        },
      },
    });
  });

  // ─── POST /logout ─────────────────────────────────────────────────────────
  app.post("/logout", async (req, reply) => {
    const ok = await verifyAdminIdentity(app, req, reply);
    if (!ok) return; // 401/403 already sent

    const admin = req.admin!;
    // Clears ONLY mw_admin_token. mw_user_token is untouched.
    clearAdminCookie(reply);

    await writeAdminAudit(prisma, {
      actorAdminId: BigInt(admin.adminId),
      action: AUDIT_LOGOUT,
      targetType: TARGET_ADMIN,
      targetId: admin.adminId,
      requestId: requestId(req),
      ip: clientIp(req),
      userAgent: userAgent(req),
    });

    return reply.status(200).send({ success: true, data: { message: "Logged out" } });
  });

  // ─── POST /change-password ────────────────────────────────────────────────
  app.post("/change-password", async (req, reply) => {
    const ok = await verifyAdminIdentity(app, req, reply);
    if (!ok) return;

    const admin = req.admin!;

    let input: ChangePasswordInput;
    try {
      input = changePasswordSchema.parse((req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      return reply.status(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", details: (err as zod.ZodError).issues },
      });
    }

    if (input.currentPassword === input.newPassword) {
      return reply.status(400).send({
        success: false,
        error: { code: "PASSWORD_REUSED", message: "New password must differ from the current password" },
      });
    }

    const row = await prisma.adminAccount.findUnique({
      where: { id: BigInt(admin.adminId) },
      select: { id: true, passwordHash: true, sessionVersion: true, isActive: true },
    });
    if (!row || !row.isActive) {
      return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    }

    const currentOk = await bcrypt.compare(input.currentPassword, row.passwordHash);
    if (!currentOk) {
      return reply.status(400).send({ success: false, error: { code: "WRONG_PASSWORD", message: "Current password is incorrect" } });
    }

    const newHash = await bcrypt.hash(input.newPassword, ADMIN_BCRYPT_COST);
    const newSessionVersion = row.sessionVersion + 1;

    // Updating passwordHash + passwordChangedAt + sessionVersion invalidates
    // ALL previously-issued tokens (their sessionVersion no longer matches).
    await prisma.adminAccount.update({
      where: { id: row.id },
      data: {
        passwordHash: newHash,
        passwordChangedAt: new Date(),
        sessionVersion: newSessionVersion,
      },
    });

    await writeAdminAudit(prisma, {
      actorAdminId: row.id,
      action: AUDIT_PASSWORD_CHANGED,
      targetType: TARGET_ADMIN,
      targetId: row.id.toString(),
      requestId: requestId(req),
      ip: clientIp(req),
      userAgent: userAgent(req),
    });

    // Issue a fresh token so the admin stays logged in on this client; the old
    // token (and any others) are now invalid because sessionVersion changed.
    const token = signAdminToken(app, {
      adminId: row.id.toString(),
      role: admin.role,
      sessionVersion: newSessionVersion,
    });
    setAdminCookie(reply, token, ADMIN_JWT_TTL_SECONDS);

    return reply.status(200).send({ success: true, data: { message: "Password changed" } });
  });

  // ─── GET /me ──────────────────────────────────────────────────────────────
  app.get("/me", async (req, reply) => {
    const ok = await verifyAdminIdentity(app, req, reply);
    if (!ok) return;

    // req.admin was just populated from a fresh DB query by the guard.
    const admin = req.admin!;
    return reply.status(200).send({
      success: true,
      data: {
        id: admin.adminId,
        username: admin.username,
        displayName: admin.displayName,
        role: admin.role,
        sessionVersion: admin.sessionVersion,
      },
    });
  });
}
