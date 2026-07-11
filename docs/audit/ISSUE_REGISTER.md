# Issue Register

| # | Date | Area | Issue | Status | Resolution |
|---|------|------|-------|--------|------------|
| 1 | 2026-07-10 | Admin.ts | 2250-line god file — violates Single Responsibility | ✅ Phase 1 | `admin-cache` module extracted; remaining 27 routes still in admin.ts |
| 2 | 2026-07-10 | Redis | 13 KEYS call sites — O(N) blocking, no pagination, production risk | ✅ Phase 2 | 7 request-path KEYS in admin.ts replaced with SCAN+UNLINK (via `scanKeys()` helper); 5 KEEP_TEMPORARILY (high-TTL cache invalidate on data mutation, low risk); 1 KEEP_TEMPORARILY (legacy import results, read-only, low cardinality) |
| 3 | 2026-07-10 | Tests | No contract tests — full app boot required, prone to flaky | ✅ Phase 2 | 41 tests across 6 files, all use `skipLifecycle: true`, no real DB/Redis |
| 4 | 2026-07-10 | Cache | CacheService with namespace allowlist/blocklist — prevents accidental purge of auth sessions | ✅ Phase 2 | CACHE_ALLOWLIST + BLOCKED_NAMESPACE_PREFIXES validated in `invalidateByPattern()` |
| 5 | 2026-07-11 | Python | No contract tests for crawler_common.py — all tests mock-based, no real network/Redis | ✅ Phase 2 | 17 Python tests in tests/test_crawler_common.py |
| 6 | 2026-07-11 | API docs | Admin API not documented — route contract, query params, body schema, status codes missing | ✅ Phase 2 | ADMIN_API_CONTRACT.md finalized |
| 7 | 2026-07-11 | Redis | figures.ts/images.ts KEYS still use KEYS for cache invalidate | ✅ Phase 3 | Replaced with `scanKeys()` — all production `app.redis.keys()` eliminated |
| 8 | 2026-07-11 | Redis | categories.ts:15 KEYS call not yet migrated | ✅ Phase 3 | Replaced with `scanKeys()` |
| 9 | 2026-07-11 | Architecture | Review domain not extracted from admin.ts (11 routes still coupled with image/figure modules) | 🔄 PARTIAL | types/schemas/repository/service created; routes pending — needs cross-module dependency resolution |
| 10 | 2026-07-11 | Data | Review items stored only in Redis — no PostgreSQL persistence | 🔄 **P0 — IN_PROGRESS** | Schema + PostgresReviewStore + dry-run tool created (Phase 3.6). Needs PG integration test before production backfill. |
| 11 | 2026-07-11 | Concurrency | No conditional Redis/Prisma updates — blind SET overwrites | 🔄 **P1 — ACCEPTED_RISK** | Needs Lua script or WATCH/MULTI. Lower priority because single-admin usage is common. |
| 12 | 2026-07-11 | Audit | DATA_AND_CACHE_INVENTORY.md previously claimed review decisions in PostgreSQL — this was incorrect | ✅ Phase 3.5 | Corrected: review data is Redis-only. PostgreSQL has zero review entities. |
