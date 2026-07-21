// Wave 2 Runtime: dual JWT configuration factory.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §5 — User and Admin
// JWTs use DIFFERENT audiences and independent secrets. A User token MUST NOT
// be accepted by the Admin verifier and vice-versa; an audience mismatch is a
// direct rejection.
//
// This factory produces two @fastify/jwt option objects:
//   - buildUserJwtOptions():  default namespace, aud=modelwiki-user,  USER_JWT_SECRET
//   - buildAdminJwtOptions(): namespace "admin",      aud=modelwiki-admin, ADMIN_JWT_SECRET
//
// The default (user) namespace keeps `app.jwt.sign`/`app.jwt.verify` working
// for the existing user auth route. The admin namespace exposes
// `app.adminJwtSign` / `app.adminJwtVerify` / `app.adminJwtDecode` for the
// admin auth route and adminGuard (mounted by the Integrator).
//
// Identity separation guarantees enforced here:
//   1. Different secrets → a token signed with the user secret fails admin
//      verification (signature mismatch) and vice-versa.
//   2. Different audiences → even if secrets were ever equal, the audience
//      check rejects cross-system tokens.
//   3. No role-based guessing → the audience is the authoritative identity
//      marker, not a `role` claim.

import type { FastifyJWTOptions } from "@fastify/jwt";
import {
  USER_JWT_AUDIENCE,
  ADMIN_JWT_AUDIENCE,
  type RuntimeConfig,
} from "./config.js";

/**
 * Build @fastify/jwt options for the User identity (default namespace).
 * Tokens are signed with USER_JWT_SECRET and carry aud=modelwiki-user.
 */
export function buildUserJwtOptions(config: RuntimeConfig): FastifyJWTOptions {
  return {
    secret: config.userJwtSecret,
    sign: {
      algorithm: "HS256",
      aud: USER_JWT_AUDIENCE,
      expiresIn: config.userJwtExpiresIn,
    },
    // Verify rejects any token whose aud !== modelwiki-user. This prevents
    // an admin token (aud=modelwiki-admin) from being accepted by a user
    // verifier even if the secrets happened to match.
    verify: {
      allowedAud: USER_JWT_AUDIENCE,
    },
  };
}

/**
 * Build @fastify/jwt options for the Admin identity (namespace "admin").
 * Tokens are signed with ADMIN_JWT_SECRET and carry aud=modelwiki-admin.
 *
 * The `namespace: "admin"` option exposes the admin JWT verifier as
 * `app.jwt.admin.sign` / `app.jwt.admin.verify` / `app.jwt.admin.decode`
 * (separate from the default `app.jwt` user decorators) and creates the
 * request-level `request.adminJwtVerify` / reply-level `reply.adminJwtSign`
 * decorators. `decoratorName: "admin"` makes `request.adminJwtVerify()`
 * populate `req.admin` (not `req.user`).
 */
export function buildAdminJwtOptions(config: RuntimeConfig): FastifyJWTOptions {
  return {
    secret: config.adminJwtSecret,
    namespace: "admin",
    // decoratorName: 'admin' ensures request.adminJwtVerify() populates
    // req.admin (not req.user), keeping the two identities on separate slots.
    decoratorName: "admin",
    sign: {
      algorithm: "HS256",
      aud: ADMIN_JWT_AUDIENCE,
      expiresIn: config.adminJwtExpiresIn,
    },
    // Verify rejects any token whose aud !== modelwiki-admin. A user token
    // (aud=modelwiki-user) is rejected here even if it were signed with the
    // same secret.
    verify: {
      allowedAud: ADMIN_JWT_AUDIENCE,
    },
  };
}
