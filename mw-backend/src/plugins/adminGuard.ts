// Phase 1+2 runtime-security: admin authorization guard.
//
// Contract: docs/implementation/PHASE12_CONTRACT.md §auth
//
// Problem: the previous code trusted the JWT's `role` claim for the entire
// token lifetime (2h). If an admin was demoted to `editor` or `user`, or
// their account was deactivated (isActive=false), their existing JWT still
// granted admin write access until expiry.
//
// Fix: every admin write request re-queries the DB to confirm the user's
// CURRENT role is `admin` AND isActive=true. The JWT is only used to identify
// the user (userId) — the role/active status always comes from the DB.
//
// Role vocabulary (unified): "user", "editor", "admin". Any other value in
// the DB is treated as "user" (least privilege).
//
// After successful auth, req.user contains:
//   - userId: string (decimal, preserves full BigInt precision)
//   - role: string (current DB role)
//   - displayName: string (for audit logging)
//
// Run tests: npx tsx --test src/plugins/auth-role.test.ts

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export const ROLE_USER = "user";
export const ROLE_EDITOR = "editor";
export const ROLE_ADMIN = "admin";

export const VALID_ROLES: readonly string[] = [ROLE_USER, ROLE_EDITOR, ROLE_ADMIN];

export interface AuthUser {
  userId: string;
  role: string;
  displayName: string;
}

/**
 * Normalize a role string from the DB. Returns the role if it's in the
 * valid vocabulary, otherwise returns "user" (least privilege).
 */
export function normalizeRole(role: string | null | undefined): string {
  if (typeof role !== "string") return ROLE_USER;
  const lower = role.toLowerCase();
  return VALID_ROLES.includes(lower) ? lower : ROLE_USER;
}

/**
 * Verify the Bearer JWT on the request and re-check the user's current DB
 * role/active status. On success, populates req.user with { userId, role,
 * displayName }. On failure, sends a 401 response.
 *
 * `requireRole` controls the minimum role required:
 *   - "admin": only admin users pass
 *   - "editor": admin or editor pass
 *   - "user": any active user passes
 *
 * This function ALWAYS queries the DB — it never trusts the JWT role claim.
 */
export async function verifyUserFromDb(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  requireRole: "admin" | "editor" | "user",
): Promise<boolean> {
  const prisma = (app as any).prisma;
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ") || auth.length <= 7) {
    reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    return false;
  }
  const token = auth.slice(7);
  let payload: { userId: string | number; role?: string };
  try {
    payload = (app as any).jwt.verify(token);
  } catch {
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    return false;
  }

  const userIdRaw = payload.userId;
  if (userIdRaw === undefined || userIdRaw === null) {
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    return false;
  }
  // Parse userId to BigInt — reject non-numeric values
  const userIdStr = String(userIdRaw);
  if (!/^\d+$/.test(userIdStr)) {
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    return false;
  }
  let userIdBigInt: bigint;
  try {
    userIdBigInt = BigInt(userIdStr);
  } catch {
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    return false;
  }

  const user = await prisma.user.findUnique({
    where: { id: userIdBigInt },
    select: { id: true, role: true, isActive: true, displayName: true },
  });

  if (!user || !user.isActive) {
    reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    return false;
  }

  const currentRole = normalizeRole(user.role);
  const allowed =
    requireRole === ROLE_ADMIN
      ? currentRole === ROLE_ADMIN
      : requireRole === ROLE_EDITOR
        ? currentRole === ROLE_ADMIN || currentRole === ROLE_EDITOR
        : true;

  if (!allowed) {
    reply.status(403).send({ success: false, error: { code: "FORBIDDEN" } });
    return false;
  }

  (req as any).user = {
    userId: user.id.toString(),
    role: currentRole,
    displayName: user.displayName,
  } as AuthUser;
  return true;
}

// ─── Wave 2: Guanli AdminAccount-based guard (re-exports) ────────────────────
//
// The code above (verifyUserFromDb / ROLE_ADMIN / normalizeRole) is the LEGACY
// User.role-based admin guard. It is retained here unchanged so that the
// existing index.ts (owned by the Runtime Agent) and the existing
// auth-role.test.ts continue to compile and pass until the Runtime Agent
// rewires index.ts to use the new AdminAccount-based guard.
//
// The NEW Guanli admin guard lives in src/plugins/admin-auth/guard.ts and is
// completely independent of the User table. It is re-exported here under the
// cross-agent interface names (WAVE2_AGENT_CONTRACTS.md):
//   - adminGuard           : Fastify plugin (scoped preHandler)
//   - verifyAdminIdentity  : core identity verifier (populates req.admin)
//   - requireAdminRole     : role-specific preHandler factory
//
// These MUST be used for all Guanli admin routes. They reject User JWTs via the
// mandatory "modelwiki-admin" audience check and re-query AdminAccount on every
// request (never trusting the JWT role for authorization).
export {
  adminGuard,
  verifyAdminIdentity,
  requireAdminRole,
} from "./admin-auth/guard.js";
export type { AdminIdentity } from "./admin-auth/types.js";
