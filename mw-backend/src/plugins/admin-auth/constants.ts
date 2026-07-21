// Guanli AdminAccount authentication constants.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §3 + §5.
//
// The Guanli admin account system is COMPLETELY SEPARATE from the frontend
// User system. It uses a different JWT audience, a different cookie name, a
// different rate-limit namespace, and a different role vocabulary. These
// constants are the single source of truth for those identifiers so they can
// never accidentally drift into the User namespace.
//
// Role vocabulary (contract §3.7):
//   - "admin"     : full access (review + admin management + crawler ops)
//   - "reviewer"  : review actions only
//   - "operator"  : crawler operations only

/** JWT audience for Guanli admin tokens. User JWTs use "modelwiki-user". */
export const ADMIN_JWT_AUDIENCE = "modelwiki-admin";

/** Cookie name for the admin token. User token cookie is "mw_user_token". */
export const ADMIN_COOKIE_NAME = "mw_admin_token";

/** Redis key prefix for admin rate-limiting. User prefix is "rate-limit:user:". */
export const ADMIN_RATE_LIMIT_PREFIX = "rate-limit:admin:";

/** Redis key prefix specifically for admin login attempts. */
export const ADMIN_LOGIN_RATE_LIMIT_PREFIX = "rate-limit:admin:login:";

/**
 * Admin JWT TTL. Kept short on purpose (contract §3.1 "short TTL") so that a
 * leaked admin token has a small window of usefulness. The guard re-queries
 * the DB on every sensitive request anyway, so a short TTL is defense in
 * depth rather than the primary control.
 */
export const ADMIN_JWT_TTL_SECONDS = 30 * 60; // 30 minutes

/** Roles recognized by the Guanli admin system. */
export const ADMIN_ROLE_ADMIN = "admin";
export const ADMIN_ROLE_REVIEWER = "reviewer";
export const ADMIN_ROLE_OPERATOR = "operator";

export const VALID_ADMIN_ROLES: readonly string[] = [
  ADMIN_ROLE_ADMIN,
  ADMIN_ROLE_REVIEWER,
  ADMIN_ROLE_OPERATOR,
];

export type AdminRole = "admin" | "reviewer" | "operator";

/**
 * Normalize an admin username for lookup and uniqueness: trim whitespace and
 * lowercase. AdminAccount stores both the original `username` and the
 * `normalizedUsername` (unique). Login always queries by normalizedUsername.
 */
export function normalizeUsername(raw: string): string {
  return String(raw).trim().toLowerCase();
}

/**
 * Validate / normalize an admin role string. Returns the role if it is in the
 * valid vocabulary, otherwise null. The guard treats unknown roles as
 * unauthorized (least privilege) — it never falls back to a default role.
 */
export function normalizeAdminRole(role: string | null | undefined): string | null {
  if (typeof role !== "string") return null;
  const lower = role.trim().toLowerCase();
  return VALID_ADMIN_ROLES.includes(lower) ? lower : null;
}

/** bcrypt cost factor for admin password hashing (contract §3.4). */
export const ADMIN_BCRYPT_COST = 12;
