// Guanli admin authorization guard.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §3.3.
// Cross-agent interface: exports `adminGuard`, `verifyAdminIdentity`,
// `requireAdminRole` (see WAVE2_AGENT_CONTRACTS.md).
//
// Security properties:
//   1. Only JWTs with aud="modelwiki-admin" are accepted. A frontend User JWT
//      (no aud, or aud="modelwiki-user") is REJECTED. This is enforced by
//      verifyAdminToken's mandatory audience check.
//   2. The guard ALWAYS re-queries AdminAccount from the DB. It never trusts
//      the JWT's `role` or `isActive` claims for authorization.
//   3. It checks isActive, sessionVersion (against the JWT), and the current
//      DB role on every request.
//   4. `req.admin` is populated — it is intentionally SEPARATE from
//      `req.user`. A request never carries both identities.
//   5. User.role is never consulted. Ordinary Users are never auto-converted
//      to admins.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { verifyAdminToken } from "./token.js";
import { readAdminToken } from "./cookies.js";
import { writeAdminAudit, AUDIT_TOKEN_REJECTED, AUDIT_ACCOUNT_DISABLED, TARGET_ADMIN } from "./audit.js";
import { normalizeAdminRole } from "./constants.js";
import type { AdminIdentity, AdminAccountRow } from "./types.js";

// ─── Fastify type augmentation: `req.admin` is distinct from `req.user` ──────
declare module "fastify" {
  interface FastifyRequest {
    /** Guanli admin identity. Populated by verifyAdminIdentity. Never mixed with `user`. */
    admin?: AdminIdentity;
  }
}

/** Select projection used when re-querying AdminAccount in the guard. */
const ADMIN_GUARD_SELECT = {
  id: true,
  username: true,
  displayName: true,
  role: true,
  isActive: true,
  sessionVersion: true,
} as const;

/** Parse a decimal string into a BigInt, or null if not a valid non-negative integer. */
function parseAdminId(raw: unknown): bigint | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw);
  if (!/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function clientIp(req: FastifyRequest): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const first = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "";
  if (first) return first;
  return req.ip || null;
}

function requestId(req: FastifyRequest): string | null {
  const id = (req as FastifyRequest & { id?: string }).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

/**
 * Verify the admin identity on the request and populate `req.admin`.
 *
 * Steps:
 *   1. Extract token from cookie or `Authorization: Bearer`.
 *   2. Verify signature + audience (modelwiki-admin). User JWTs fail here.
 *   3. Parse adminId (decimal string → BigInt).
 *   4. Re-query AdminAccount by id.
 *   5. Reject if not found (401), inactive (403 ACCOUNT_DISABLED), or
 *      sessionVersion mismatch (401 — stale token after password change).
 *   6. Reject if the DB role is not a valid admin role (403 FORBIDDEN).
 *   7. Populate `req.admin` with the CURRENT DB values.
 *
 * Returns true on success (response NOT sent). Returns false on failure
 * (response already sent). The `roleForAudit` from the DB is used for the
 * disabled-account audit log; the JWT role is never used.
 */
export async function verifyAdminIdentity(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const prisma: PrismaClient = app.prisma;
  const token = readAdminToken(req);

  if (!token) {
    reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    return false;
  }

  let payload;
  try {
    payload = verifyAdminToken(app, token);
  } catch {
    // Invalid signature, expired, or wrong/missing audience (User JWT lands here).
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    return false;
  }

  const adminId = parseAdminId(payload.adminId);
  if (adminId === null) {
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    return false;
  }

  const row: AdminAccountRow | null = await prisma.adminAccount.findUnique({
    where: { id: adminId },
    select: ADMIN_GUARD_SELECT,
  });

  if (!row) {
    // Best-effort security log: cannot attribute to a real admin (FK), so skip.
    reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    return false;
  }

  if (!row.isActive) {
    // Disabled admin — old tokens are immediately invalid. We CAN attribute
    // this to a real admin id, so write the audit row.
    await writeAdminAudit(prisma, {
      actorAdminId: row.id,
      action: AUDIT_ACCOUNT_DISABLED,
      targetType: TARGET_ADMIN,
      targetId: row.id.toString(),
      requestId: requestId(req),
      ip: clientIp(req),
      userAgent: req.headers["user-agent"] ?? null,
    });
    reply.status(403).send({ success: false, error: { code: "ACCOUNT_DISABLED" } });
    return false;
  }

  if (row.sessionVersion !== payload.sessionVersion) {
    // Stale token — password was changed (or session rotated). Reject.
    await writeAdminAudit(prisma, {
      actorAdminId: row.id,
      action: AUDIT_TOKEN_REJECTED,
      targetType: TARGET_ADMIN,
      targetId: row.id.toString(),
      requestId: requestId(req),
      ip: clientIp(req),
      userAgent: req.headers["user-agent"] ?? null,
    });
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    return false;
  }

  const currentRole = normalizeAdminRole(row.role);
  if (!currentRole) {
    // Unknown role in DB — least privilege: reject.
    await writeAdminAudit(prisma, {
      actorAdminId: row.id,
      action: AUDIT_TOKEN_REJECTED,
      targetType: TARGET_ADMIN,
      targetId: row.id.toString(),
      requestId: requestId(req),
      ip: clientIp(req),
      userAgent: req.headers["user-agent"] ?? null,
    });
    reply.status(403).send({ success: false, error: { code: "FORBIDDEN" } });
    return false;
  }

  // Populate req.admin with CURRENT DB values. req.user is intentionally left
  // untouched — the two identities never coexist on a single request.
  req.admin = {
    adminId: row.id.toString(),
    username: row.username,
    displayName: row.displayName,
    role: currentRole,
    sessionVersion: row.sessionVersion,
  };
  return true;
}

/**
 * Returns a Fastify preHandler that verifies admin identity AND requires one
 * of the given roles (checked against the CURRENT DB role, never the JWT).
 *
 * Usage:
 *   app.post("/admin/figures", { preHandler: requireAdminRole("admin") }, handler);
 *   app.post("/review/decide", { preHandler: requireAdminRole("admin","reviewer") }, handler);
 *   app.post("/crawler/run",   { preHandler: requireAdminRole("admin","operator") }, handler);
 *
 * Roles (contract §3.7):
 *   - admin    : full access
 *   - reviewer : review actions only
 *   - operator : crawler operations only
 */
export function requireAdminRole(...roles: string[]): preHandlerAsyncHookHandler {
  const allowed = new Set(roles.map((r) => r.trim().toLowerCase()));
  return async function adminRolePreHandler(req, reply): Promise<void> {
    const app = req.server;
    const ok = await verifyAdminIdentity(app, req, reply);
    if (!ok) return; // response already sent
    const admin = req.admin;
    if (!admin) {
      reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
      return;
    }
    if (!allowed.has(admin.role)) {
      reply.status(403).send({ success: false, error: { code: "FORBIDDEN" } });
      return;
    }
  };
}

/**
 * Fastify plugin form of the guard. Register it in a scoped child instance to
 * protect all admin BUSINESS routes (not the auth routes — login is public):
 *
 *   app.register(async (child) => {
 *     child.register(adminGuard);            // protects everything below
 *     child.register(adminBusinessRoutes, { prefix: "/api/v1/admin" });
 *   });
 *
 * It is intentionally NOT wrapped in fastify-plugin, so the preHandler stays
 * scoped to the child instance and never leaks onto public routes.
 */
export const adminGuard: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req, reply) => {
    const ok = await verifyAdminIdentity(app, req, reply);
    if (!ok) return;
  });
};

export { AUDIT_TOKEN_REJECTED, AUDIT_ACCOUNT_DISABLED };
