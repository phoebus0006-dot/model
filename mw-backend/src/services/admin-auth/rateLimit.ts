// Guanli admin login rate limiting.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §3.1 + §5.
//
// Admin login rate limiting uses a SEPARATE Redis namespace from User login:
//   rate-limit:admin:login:<ip>
// This isolation is mandatory (contract §5): a flood of admin login attempts
// must not consume the User login budget, and vice versa.
//
// Limit: 5 attempts per minute per IP.

import type Redis from "ioredis";
import { ADMIN_LOGIN_RATE_LIMIT_PREFIX } from "../../plugins/admin-auth/constants.js";

/** Maximum admin login attempts per IP within the window. */
export const ADMIN_LOGIN_RATE_LIMIT = 5;

/** Rate-limit window in seconds (1 minute). */
export const ADMIN_LOGIN_RATE_WINDOW_SECONDS = 60;

/**
 * Build the Redis key for admin login rate limiting for a given IP.
 * Exposed for tests so namespace isolation can be asserted without Redis.
 */
export function adminLoginRateKey(ip: string): string {
  return `${ADMIN_LOGIN_RATE_LIMIT_PREFIX}${ip}`;
}

/**
 * Increment the admin login attempt counter for `ip` and return whether the
 * caller is now over the limit. The first increment sets the TTL on the key.
 *
 * Returns `{ limited: true, count }` when over the limit, otherwise
 * `{ limited: false, count }`.
 */
export async function checkAdminLoginRateLimit(
  redis: Redis,
  ip: string,
): Promise<{ limited: boolean; count: number }> {
  const key = adminLoginRateKey(ip);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ADMIN_LOGIN_RATE_WINDOW_SECONDS);
  }
  return { limited: count > ADMIN_LOGIN_RATE_LIMIT, count };
}
