// Phase 1+2 runtime-security: Redis safety guards.
//
// Contract reference: docs/implementation/PHASE12_CONTRACT.md §14 (Cache purge safety)
//   - FLUSHDB / FLUSHALL are forbidden everywhere
//   - Cache purge MUST use SCAN + UNLINK (never KEYS, never FLUSHDB)
//   - Blocked namespaces (review:, crawler:, session:, rate-limit:, legacy:import:)
//     MUST NOT be touched by purge operations
//
// This module provides:
//   1. scanKeys()         — non-blocking SCAN-based key enumeration with safety cap
//   2. purgeByPattern()   — SCAN + UNLINK with namespace allowlist enforcement
//   3. installRedisFlushGuard() — runtime interceptor that blocks flushdb/flushall
//      at both the method-call level and the sendCommand level
//
// Run tests: npx tsx --test src/security/redisGuard.test.ts

import type { Redis } from "ioredis";

// ─── Blocked command list ─────────────────────────────────────────────────────
// Matches command names case-insensitively. Covers both sync and async variants.
const BLOCKED_COMMANDS_RE = /^(flushdb|flushall|flushdbasync|flushallasync)$/i;

/**
 * Namespaces that MUST NEVER be purged by a targeted cache purge operation.
 * These hold review state, crawler jobs, sessions, rate-limit counters, and
 * legacy import queues — purging them silently would lose human decisions or
 * allow abuse (e.g. wiping rate limits).
 */
export const DEFAULT_BLOCKED_NAMESPACES: readonly string[] = [
  "review:",
  "crawler:",
  "session:",
  "rate-limit:",
  "legacy:import:",
];

export interface ScanKeysOptions {
  /** SCAN COUNT hint (batch size per round-trip). Default 100. */
  count?: number;
  /**
   * Safety cap on total matched keys. If exceeded, throws — prevents a
   * pathological pattern from OOM-ing the process. Default 10000.
   */
  limit?: number;
}

/**
 * Scan keys matching a glob pattern using Redis SCAN (non-blocking, O(1) per
 * iteration) instead of KEYS (which blocks the server and can stall the whole
 * Redis instance for seconds on large keyspaces).
 *
 * Returns up to `opts.limit` keys. Throws if the limit is exceeded, so callers
 * cannot silently swallow an explosion.
 */
export async function scanKeys(
  redis: Redis,
  pattern: string,
  opts: ScanKeysOptions = {},
): Promise<string[]> {
  if (!pattern || typeof pattern !== "string") {
    throw new Error("scanKeys: pattern must be a non-empty string");
  }
  if (pattern === "*" || pattern === "**") {
    throw new Error('scanKeys: wildcard-only pattern "*" is forbidden (use a namespace prefix)');
  }
  const count = opts.count ?? 100;
  const limit = opts.limit ?? 10_000;
  const out: string[] = [];
  let cursor = "0";
  do {
    // ioredis scan returns [cursor, keys[]]
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      String(count),
    );
    cursor = next;
    for (const k of batch) {
      out.push(k);
      if (out.length >= limit) {
        throw new Error(
          `scanKeys: pattern "${pattern}" matched >= ${limit} keys (safety cap exceeded; refine the pattern)`,
        );
      }
    }
  } while (cursor !== "0");
  return out;
}

export interface PurgeByPatternOptions extends ScanKeysOptions {
  /**
   * Namespaces that the pattern MUST NOT touch. If the pattern could match
   * keys in any of these namespaces, the call throws before any SCAN runs.
   * Defaults to DEFAULT_BLOCKED_NAMESPACES.
   */
  blockedNamespaces?: string[];
  /**
   * If true, only validates the pattern against blocked namespaces without
   * scanning or deleting. Used for dry-run previews.
   */
  dryRun?: boolean;
}

/**
 * Delete all keys matching `pattern` using SCAN + UNLINK.
 *
 * Safety contract:
 *   - Pattern "*" is forbidden
 *   - Patterns that overlap any blocked namespace are forbidden
 *   - Uses UNLINK (non-blocking del) so Redis does not stall
 *   - Returns the count of keys actually deleted
 *
 * Contract: docs/implementation/PHASE12_CONTRACT.md §14
 */
export async function purgeByPattern(
  redis: Redis,
  pattern: string,
  opts: PurgeByPatternOptions = {},
): Promise<{ matched: number; deleted: number; dryRun: boolean }> {
  if (!pattern || pattern === "*" || pattern === "**") {
    throw new Error('purgeByPattern: wildcard-only pattern is forbidden');
  }
  const blocked = opts.blockedNamespaces ?? DEFAULT_BLOCKED_NAMESPACES;
  for (const ns of blocked) {
    // Reject if the pattern literally starts with a blocked namespace, or if
    // a wildcard pattern could expand into one. We use a conservative check:
    // if the pattern's literal prefix (everything before the first glob char)
    // is empty or overlaps a blocked namespace, reject.
    const prefixEnd = pattern.search(/[*?]/);
    const literalPrefix = prefixEnd === -1 ? pattern : pattern.slice(0, prefixEnd);
    if (literalPrefix === "" ) {
      // pattern starts with a glob — could match anything. Reject.
      throw new Error(
        `purgeByPattern: pattern "${pattern}" starts with a glob char and could match blocked namespaces; use a literal prefix`,
      );
    }
    if (ns.startsWith(literalPrefix) || literalPrefix.startsWith(ns)) {
      throw new Error(
        `purgeByPattern: pattern "${pattern}" overlaps blocked namespace "${ns}"`,
      );
    }
  }

  if (opts.dryRun) {
    const keys = await scanKeys(redis, pattern, opts);
    return { matched: keys.length, deleted: 0, dryRun: true };
  }

  const keys = await scanKeys(redis, pattern, opts);
  if (keys.length === 0) return { matched: 0, deleted: 0, dryRun: false };
  // UNLINK is non-blocking DEL (Redis 4.0+). Falls back to DEL semantics on
  // older Redis but ioredis translates unlink -> UNLINK command.
  const deleted = await redis.unlink(...keys);
  return { matched: keys.length, deleted, dryRun: false };
}

/**
 * Install a runtime guard on a Redis client that blocks FLUSHDB / FLUSHALL
 * commands. Blocks at two layers:
 *
 *   1. Method-level: `redis.flushdb()` / `redis.flushall()` are shadowed by
 *      own properties that always throw.
 *   2. sendCommand-level: any Command object whose `.name` matches a blocked
 *      command is rejected before being sent to the server.
 *
 * This is defense-in-depth: even if a future contributor calls
 * `redis.sendCommand(new Command("FLUSHDB", []))`, the guard fires.
 *
 * Once installed, the guard CANNOT be removed (Object.defineProperty with
 * configurable: false) — a malicious actor cannot just `delete redis.flushdb`
 * to fall back to the prototype method.
 *
 * Contract: docs/implementation/PHASE12_CONTRACT.md §14
 *   "FLUSHDB / FLUSHALL are forbidden everywhere; the codebase MUST NOT
 *    call them, and a runtime guard MUST reject any attempt."
 */
export function installRedisFlushGuard(redis: Redis): void {
  // Layer 1: shadow the prototype methods with throwing own properties.
  // ioredis generates command methods (flushdb, flushall, etc.) on the
  // prototype via a Commander mixin. We override at the instance level.
  const thrower = (cmdName: string) => () => {
    throw new Error(
      `Blocked Redis command: ${cmdName.toUpperCase()} is forbidden by ` +
      `security policy (Phase 1+2 contract §14). Use targeted purgeByPattern() ` +
      `from src/security/redisGuard.ts instead.`,
    );
  };
  for (const cmd of ["flushdb", "flushall", "flushdbAsync", "flushallAsync"]) {
    Object.defineProperty(redis, cmd, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: thrower(cmd),
    });
  }

  // Layer 2: wrap sendCommand to inspect Command objects.
  // ioredis routes every command through sendCommand(command). Patching it
  // catches both high-level method calls (which construct a Command and pass
  // it to sendCommand) and raw sendCommand calls.
  const origSendCommand = redis.sendCommand.bind(redis);
  const guarded = function (this: any, command: any, ...rest: any[]) {
    const name = typeof command === "string"
      ? command
      : (command?.name ?? "");
    if (typeof name === "string" && BLOCKED_COMMANDS_RE.test(name)) {
      throw new Error(
        `Blocked Redis command: ${String(name).toUpperCase()} is forbidden by ` +
        `security policy (Phase 1+2 contract §14).`,
      );
    }
    return origSendCommand(command, ...rest);
  };
  // Bind the guarded wrapper to the redis instance so `this` inside refers to
  // the original Redis prototype context expected by sendCommand.
  (redis as any).sendCommand = guarded.bind(redis);
}
