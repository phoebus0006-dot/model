// Guanli admin JWT issuance and verification.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §3.1, §3.3.
//
// Admin tokens are scoped to audience "modelwiki-admin" AND signed with
// ADMIN_JWT_SECRET (independent from USER_JWT_SECRET). The verify path uses
// the Admin namespaced verifier (app.jwt.admin.verify), which is backed by
// ADMIN_JWT_SECRET and REQUIRES the "modelwiki-admin" audience. This gives
// TWO independent layers of cryptographic separation between the two account
// systems: (1) different secrets → signature mismatch, and (2) different
// audiences → allowedAud rejection.
//
// The `role` claim is included ONLY for UI display purposes — the guard never
// trusts it for authorization (it re-queries the DB on every request). See
// guard.ts.

import type { FastifyInstance } from "fastify";
import { ADMIN_JWT_AUDIENCE, ADMIN_JWT_TTL_SECONDS } from "./constants.js";

/** Payload stored inside an admin JWT. `adminId` is a decimal string (BigInt-safe). */
export interface AdminJwtPayload {
  adminId: string;
  /** UI display only — NOT trusted for authorization. */
  role: string;
  sessionVersion: number;
  aud: string;
  iat?: number;
  exp?: number;
}

/** Input used to mint an admin token. */
export interface AdminTokenClaims {
  adminId: string;
  role: string;
  sessionVersion: number;
}

/**
 * Resolve the Admin namespaced JWT decorator (app.jwt.admin). This is created
 * at runtime by @fastify/jwt when registered with `namespace: "admin"` (see
 * buildAdminJwtOptions in src/runtime/jwt.ts). It is backed by
 * ADMIN_JWT_SECRET — completely independent from the default app.jwt (User)
 * namespace which is backed by USER_JWT_SECRET.
 *
 * Fail-fast: if the Admin namespace is not registered, throw immediately
 * rather than silently falling back to the User signer/verifier (which would
 * defeat secret isolation).
 */
function getAdminJwt(app: FastifyInstance): NonNullable<FastifyInstance["jwt"]["admin"]> {
  const adminJwt = app.jwt.admin;
  if (!adminJwt) {
    throw new Error(
      "Admin JWT namespace not registered. Ensure buildAdminJwtOptions is " +
        "registered with @fastify/jwt (namespace: 'admin') before signing or " +
        "verifying admin tokens.",
    );
  }
  return adminJwt;
}

/**
 * Sign an admin JWT using ADMIN_JWT_SECRET (via the Admin namespaced signer
 * app.jwt.admin.sign). Audience is pinned to "modelwiki-admin" (carried in the
 * `aud` claim) and the TTL is short (see ADMIN_JWT_TTL_SECONDS).
 *
 * CRITICAL: this MUST NOT use app.jwt.sign (the default User namespace), which
 * is backed by USER_JWT_SECRET. Using the User signer would produce a token
 * that the Admin verifier rejects (signature mismatch) and would defeat the
 * cryptographic separation between the two account systems.
 *
 * NOTE: @fastify/jwt v10 is backed by `fast-jwt`, which uses `aud` in the
 * payload for the audience claim (not an `audience` sign option). We set `aud`
 * directly in the payload so the claim is always present.
 */
export function signAdminToken(app: FastifyInstance, claims: AdminTokenClaims): string {
  return getAdminJwt(app).sign(
    {
      adminId: claims.adminId,
      role: claims.role,
      sessionVersion: claims.sessionVersion,
      aud: ADMIN_JWT_AUDIENCE,
    },
    {
      expiresIn: ADMIN_JWT_TTL_SECONDS,
    },
  );
}

/**
 * Verify an admin JWT using ADMIN_JWT_SECRET (via the Admin namespaced verifier
 * app.jwt.admin.verify). Throws if the token is invalid, expired, or does not
 * carry the "modelwiki-admin" audience. A User JWT (signed with USER_JWT_SECRET
 * and/or carrying aud="modelwiki-user") will throw — callers should catch and
 * reject with 401/403.
 *
 * CRITICAL: this MUST NOT use app.jwt.verify (the default User namespace), which
 * is backed by USER_JWT_SECRET. Using the User verifier would accept
 * USER_JWT_SECRET-signed tokens and would defeat the cryptographic separation
 * between the two account systems.
 *
 * The audience check is mandatory: it is what prevents a User JWT from being
 * accepted by the admin guard even if the secrets happened to match.
 * `fast-jwt` exposes this as `allowedAud`.
 */
export function verifyAdminToken(app: FastifyInstance, token: string): AdminJwtPayload {
  return getAdminJwt(app).verify<AdminJwtPayload>(token, {
    allowedAud: ADMIN_JWT_AUDIENCE,
  });
}
