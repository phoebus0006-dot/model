// Frontend User authorization guard (Remediated: Email optional contract alignment).
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md
// Guarantees:
//   - Accepts ONLY aud=modelwiki-user. Rejects aud=modelwiki-admin with 403.
//   - Verifies JWT signature, re-queries DB on EVERY request for isActive, role, sessionVersion.
//   - Rejects when sessionVersion in JWT does not match DB (session invalidation).
//   - req.user is populated with User identity.
//   - requireVerifiedUser is aligned with main contract: allows email-less users to write.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export const USER_AUDIENCE = "modelwiki-user";
const ADMIN_AUDIENCE = "modelwiki-admin";

export const USER_ROLE = "user";
export const EDITOR_ROLE = "editor";
const ALLOWED_USER_ROLES: ReadonlySet<string> = new Set([USER_ROLE, EDITOR_ROLE]);

export interface UserIdentity {
  userId: string;
  role: string;
  emailVerified: boolean;
  isActive: boolean;
  sessionVersion: number;
}

interface DecodedUserJwt {
  userId?: string | number;
  sessionVersion?: number;
  aud?: string;
  [k: string]: unknown;
}

export function normalizeUserRole(role: string | null | undefined): string {
  if (typeof role !== "string") return USER_ROLE;
  const lower = role.toLowerCase();
  return ALLOWED_USER_ROLES.has(lower) ? lower : USER_ROLE;
}

function safeDecodeCookieValue(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function extractUserToken(req: FastifyRequest): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader === "string") {
    const match = cookieHeader.match(/(?:^|;\s*)mw_user_token=([^;]+)/);
    if (match) return safeDecodeCookieValue(match[1]);
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ") && auth.length > 7) {
    return auth.slice(7);
  }
  return undefined;
}

export async function verifyUserIdentity(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const token = extractUserToken(req);
  if (!token) {
    reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    return false;
  }

  let payload: DecodedUserJwt;
  try {
    payload = app.jwt.verify(token) as DecodedUserJwt;
  } catch {
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    return false;
  }

  if (payload.aud !== USER_AUDIENCE) {
    if (payload.aud === ADMIN_AUDIENCE) {
      reply.status(403).send({ success: false, error: { code: "FORBIDDEN", message: "Admin token not accepted" } });
    } else {
      reply.status(403).send({ success: false, error: { code: "FORBIDDEN", message: "Token audience not allowed" } });
    }
    return false;
  }

  const userIdRaw = payload.userId;
  if (userIdRaw === undefined || userIdRaw === null) {
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    return false;
  }
  const userIdStr = String(userIdRaw);
  if (!/^\d+$/.test(userIdStr)) {
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    return false;
  }
  const sessionVersion = payload.sessionVersion;
  if (typeof sessionVersion !== "number" || !Number.isFinite(sessionVersion)) {
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

  const user = await app.prisma.user.findUnique({
    where: { id: userIdBigInt },
    select: { id: true, isActive: true, role: true, emailVerifiedAt: true, sessionVersion: true },
  });

  if (!user || !user.isActive) {
    reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    return false;
  }

  if (user.sessionVersion !== sessionVersion) {
    reply.status(401).send({ success: false, error: { code: "SESSION_EXPIRED", message: "Session invalidated" } });
    return false;
  }

  const role = normalizeUserRole(user.role);

  (req as any).user = {
    userId: user.id.toString(),
    role,
    emailVerified: user.emailVerifiedAt !== null,
    isActive: user.isActive,
    sessionVersion: user.sessionVersion,
  };
  return true;
}

export async function userGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ok = await verifyUserIdentity(req.server, req, reply);
  if (!ok) return;
}

/**
 * Remediated preHandler for write operations (favorite/comment/edit).
 * Verifies active user identity. Does NOT block users without email.
 */
export async function requireVerifiedUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ok = await verifyUserIdentity(req.server, req, reply);
  if (!ok) return;
}
