// Wave 2 Runtime: type declarations for dual-identity Fastify decorations.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §1 + §5.
//
// These augment the Fastify request type with two SEPARATE identity slots:
//   - req.user  → frontend User identity (email-based, aud=modelwiki-user)
//   - req.admin → guanli AdminAccount identity (username-based, aud=modelwiki-admin)
//
// A request MUST NOT carry both (enforced by the identity collision guard in
// src/runtime/identity.ts). These types are intentionally distinct — an
// AdminAccount is NEVER assignable to the User slot and vice-versa.
//
// NOTE on declaration merging: @fastify/jwt already declares `req.user` as
// `fastifyJwt.UserType`. We narrow it here to `AuthUser` via the FastifyJWT
// interface so that user auth code gets a typed identity instead of a raw
// decoded token. `req.admin` is a new decoration added by this module.
//
// JWT namespace augmentation: @fastify/jwt v10 creates `app.jwt[namespace]` at
// RUNTIME when registered with `namespace: "admin"` (see src/runtime/jwt.ts
// buildAdminJwtOptions). The generated TypeScript types do NOT declare this
// sub-object. We augment the JWT interface (same pattern as FastifyJWT) to
// expose `app.jwt.admin.sign/verify/decode` in a type-safe way without `as any`.

import type { FastifyRequest } from "fastify";

/**
 * Frontend User identity. Populated by userGuard after verifying a user JWT
 * (aud=modelwiki-user) and re-querying the User table for isActive /
 * sessionVersion. `userId` is a decimal string to preserve full BigInt
 * precision.
 */
export interface AuthUser {
  userId: string;
  role: string;
  displayName: string;
}

/**
 * Guanli AdminAccount identity. Populated by adminGuard after verifying an
 * admin JWT (aud=modelwiki-admin) and re-querying AdminAccount for isActive
 * / role / sessionVersion. `adminId` is a decimal string.
 *
 * This type is structurally distinct from AuthUser — there is intentionally
 * no overlap that would allow assigning an AdminAccount to req.user.
 */
export interface AuthAdmin {
  adminId: string;
  role: string;
  sessionVersion: number;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Guanli AdminAccount identity. Set by adminGuard. Undefined when the
     * request is not admin-authenticated (or before adminGuard runs).
     */
    admin?: AuthAdmin | undefined;
  }
}

declare module "@fastify/jwt" {
  // Narrow the default `user` decorator to the typed User identity. This
  // does not create the userGuard — it only types what guards produce.
  interface FastifyJWT {
    user: AuthUser;
  }

  // Augment the JWT decorator interface to expose the Admin namespaced
  // sub-object.
  //
  // @fastify/jwt v10 creates `app.jwt[namespace]` at RUNTIME when registered
  // with `namespace: "admin"` (see src/runtime/jwt.ts buildAdminJwtOptions).
  // The generated TypeScript types do NOT declare this sub-object — they only
  // declare the request/reply decorators (adminJwtSign etc.). This augmentation
  // makes `app.jwt.admin.sign/verify/decode` type-safe without requiring
  // `as any`.
  //
  // The admin sub-object is backed by ADMIN_JWT_SECRET, completely independent
  // from the default app.jwt (User namespace, USER_JWT_SECRET).
  interface JWT {
    /** Admin namespaced JWT decorator (sign/verify/decode), backed by ADMIN_JWT_SECRET. */
    admin?: JWT;
  }
}

export {};
