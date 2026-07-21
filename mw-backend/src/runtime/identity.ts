// Wave 2 Runtime: identity collision guard.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §1 — "These two
// systems share NOTHING except the database instance." and §4 Prohibitions.
//
// Rule: a single request MUST NOT carry BOTH a user identity (req.user) and
// an admin identity (req.admin). This guard runs as a preHandler hook and
// rejects any request where both are populated with a 400
// DUAL_IDENTITY_FORBIDDEN response.
//
// Why: a request that is simultaneously authenticated as a frontend User AND
// a guanli Admin would let one cookie/header escalate privileges across the
// two isolated systems. The collision is rejected before any route handler
// runs, regardless of which guard populated which identity.
//
// This guard does NOT create userGuard/adminGuard (those are owned by the
// User Auth and Admin Auth agents). It only enforces the mutual-exclusion
// invariant once both guards exist. Until the Integrator mounts the guards,
// this hook is a no-op (both identities are undefined).

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

/**
 * Sentinel: a guard has explicitly set the identity to "no authenticated
 * user/admin" (as opposed to the guard not having run at all). We
 * distinguish "guard ran and found no token" from "guard did not run".
 *
 * Guards set req.user / req.admin to the decoded identity object on success,
 * or leave them undefined on failure. The collision guard treats "both are
 * truthy objects" as a collision.
 */
function hasUserIdentity(req: FastifyRequest): boolean {
  const u = (req as any).user;
  return u !== undefined && u !== null && typeof u === "object";
}

function hasAdminIdentity(req: FastifyRequest): boolean {
  const a = (req as any).admin;
  return a !== undefined && a !== null && typeof a === "object";
}

/**
 * PreHandler hook: reject any request carrying BOTH a user and an admin
 * identity. Returns true when the request is rejected (handler must abort).
 */
export async function rejectDualIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (hasUserIdentity(req) && hasAdminIdentity(req)) {
    reply
      .status(400)
      .send({ success: false, error: { code: "DUAL_IDENTITY_FORBIDDEN" } });
    return true;
  }
  return false;
}

/**
 * Register the identity collision guard as a global preHandler hook.
 */
export function registerIdentityCollisionGuard(app: FastifyInstance): void {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    await rejectDualIdentity(req, reply);
  });
}

/**
 * Per-route collision guard. Guards can call this after setting an identity
 * to double-check no other identity is present.
 */
export async function assertNoIdentityCollision(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  return rejectDualIdentity(req, reply);
}
