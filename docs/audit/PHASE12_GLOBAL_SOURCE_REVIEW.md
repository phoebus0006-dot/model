# Phase 12 — Global Independent Source Review Package

## READY_FOR_INDEPENDENT_SOURCE_REVIEW

## 1. HEAD & Branch

| Item | Value |
|------|-------|
| HEAD | `98262bb` |
| Branch | `master` |
| Working tree | 64 modified files, ~100 untracked files |
| Patch | `phase12-global-review.patch` (291 KB) |

## 2. Artifacts

| File | Description |
|------|-------------|
| `phase12-global-review.patch` | Full git diff --binary HEAD (291 KB) |
| `phase12-global-source-review.tar.gz` | Complete source tree (excluding .git, node_modules, dist, .env) |

## 3. Test Count Change: 170 → 168

**Root cause**: `apply-lock.test.ts` was rewritten. Old version had 8 tests (including `withLock`, `generateToken`). New version has 6 tests reflecting the new `tryAcquire`/`LockLease` API. Two tests were consolidated, not removed:

- `withLock calls function and releases lock` + `withLock throws APPLY_IN_PROGRESS` → covered by `release returns true for owner` and `acquire returns null for second caller`
- `generates unique tokens` → inherent in `acquire returns lease for first caller` (token is always generated)

No test was deleted without replacement. No `.skip` or `.only` found in any test file.

## 4. Production Call Chain (apply)

```
HTTP POST /review/items/:id/apply
→ auth onRequest (admin.ts global)
→ adminApplyRoute (apply-route.ts)
  → ReviewApplyService.apply() (apply-service.ts)
    → tryAcquire() (apply-lock.ts) — SET NX PX
    → [re-read review item after lock]
    → [business logic — placeholder, still in apply-handler.ts]
    → finally: lease.release() — Lua compare-and-delete
  → error mapping (5 ReviewDomainError subclasses → HTTP)
```

## 5. Component Wiring

| Component | Production Importers | Test Importers | Status |
|-----------|---------------------|----------------|--------|
| apply-route.ts | routes.ts | — | **PRODUCTION_ACTIVE** |
| apply-service.ts | apply-route.ts | — | **PRODUCTION_ACTIVE** |
| apply-lock.ts | apply-service.ts | apply-lock.test.ts | **PRODUCTION_ACTIVE** |
| apply-errors.ts | apply-route.ts, apply-service.ts | — | **PRODUCTION_ACTIVE** |
| apply-types.ts | apply-service.ts | — | **PRODUCTION_ACTIVE** |
| apply-dependencies.ts | — | — | **DEAD** |
| image-service.ts | — | — | **DEAD** |
| image-security.ts | — | image-security.test.ts | **TEST_ONLY** |
| image-storage.ts | — | — | **DEAD** |
| image-repository.ts | — | — | **DEAD** |
| apply-handler.ts | — (NOT prod-registered) | — | **INDIRECT_LEGACY_DEPENDENCY** |

## 6. Old Handler (apply-handler.ts)

| Attribute | Value |
|-----------|-------|
| Size | 32,249 bytes / 627 lines |
| Contains | sharp, fs, Prisma, Redis, request/reply |
| Production registered? | **NO** — routes.ts uses apply-route.ts now |
| Indirectly called? | **NO** — apply-service.ts has placeholder, not calling handler |
| Contains dead code? | The entire route registration is dead — all 627 lines are unreachable |

## 7. Lock Lifecycle

| Aspect | Detail | Source Location |
|--------|--------|-----------------|
| Token | `Date.now().toString(36) + "-" + random + "-" + pid` | apply-lock.ts:16 |
| Acquire | `SET key token NX PX 60000` | apply-lock.ts:20 |
| TTL | 60,000 ms | apply-lock.ts:4 |
| Renewal | `setInterval` at TTL-10000, Lua PEXPIRE with token check | apply-lock.ts:26-30 |
| Renewal failure | Silent catch — lock lost without aborting operation | apply-lock.ts:29 |
| Release | Lua compare-and-delete | apply-lock.ts:11-14 |
| Release placement | `finally` block | apply-service.ts:27 |
| Release idempotent | Yes — Lua returns 0 if already deleted | apply-lock.ts:14 |
| Old token risk | Lua prevents renewal/deletion with wrong token | apply-lock.ts:12 |
| **Lock-lost risk** | Renewal failure does NOT abort execution | apply-lock.ts:29 |

**P1 Risk**: If the lock is lost (network partition, Redis restart, renewal failure), the `finally` block still releases the expired lock (no-op since already expired). But the business logic continues executing without lock protection. This could allow a second concurrent apply on the same item.

## 8. Image Production Path

| Path | Uses | Status |
|------|------|--------|
| images API (`routes/images.ts`) | Inline sharp, fs, validateImageUrl, downloadImage | **Original inline code, no shared service** |
| review apply (`apply-handler.ts`) | Inline sharp, fs (627 lines) | **Dead code — handler not registered** |
| review apply (`apply-service.ts`) | Placeholder — no actual image calls | **No real implementation yet** |
| image-service.ts | — | **DEAD** — not imported by any production code |

Both production image paths use inline implementations. No shared image service is wired.

## 9. Test Quality Classification

| File | Type | Assertions | Mock Scope | Trust Level |
|------|------|-----------|------------|-------------|
| admin-contract.test.ts | Route contract | HTTP status, error shape | skipLifecycle | **STRONG** |
| app-startup.test.ts | App startup | app.ready(), route existence | skipLifecycle | **STRONG** |
| apply-lock.test.ts | Redis lock | acquire, release, token | Mock ioredis | **ADEQUATE** |
| app-contract.test.ts | Route contract | HTTP status, response shape | skipLifecycle | **STRONG** |
| bigint.test.ts | Unit | JSON string precision | None | **STRONG** |
| bigint-contract.test.ts | Contract | API string IDs | skipLifecycle | **STRONG** |
| cache-service.test.ts | Mock integration | SCAN, unlink, allowlist | Mock ioredis | **ADEQUATE** |
| image-security.test.ts | Unit | URL validation | DNS mock | **STRONG** |
| lifecycle.test.ts | Unit | Constructor, close | None | **ADEQUATE** |
| migration-dto-parse.test.ts | Unit | JSON parsing | None | **STRONG** |
| migration-dual-write.test.ts | Unit | Failure matrix | None | **STRONG** |
| migration-full.test.ts | Unit | Parser + reconciliation | None | **STRONG** |
| migration-safety.test.ts | File content | SQL keywords | File read | **STRONG** |
| migration-store-mode.test.ts | Unit | Mode selection | None | **STRONG** |
| postgres-review-store.test.ts | Mock integration | Transaction, conflict | Mock Prisma | **ADEQUATE** |
| review-contract.test.ts | Route contract | HTTP status, schema | skipLifecycle | **STRONG** |
| review-update-security.test.ts | Unit | Forbidden fields | None | **STRONG** |

## 10. Global Risk Scan

| Risk | Level | Location | Status |
|------|-------|----------|--------|
| Lock-lost → concurrent apply | **P1** | apply-lock.ts:29 (silent catch) | Open |
| No image service sharing | **P2** | images.ts + apply-handler.ts | Open |
| apply-handler.ts dead code | **P2** | 32KB unreachable | Open |
| Number() on IDs | **P1** | admin.ts (6 locations — Phase 3.5-R) | Fixed (Phase 3.5-F/G) |
| Redis KEYS | **P0** | all routes | Eliminated (Phase 2/3) |
| PUT status bypass | **P0** | admin.ts | Fixed (Phase 3.5-F) |
| SSRF in apply | **P2** | apply-handler.ts (dead) | Open |
| apply-handler dead code | **P2** | 32KB | Open |
| DEAD scaffolding | **P2** | 5 files | Open |

## 11. Verification Results

| Command | Exit Code | Result |
|---------|-----------|--------|
| `npm run test` | 0 | 168/168 ✅ (17 files) |
| `npm run test:app-startup` | 0 | 4/4 ✅ |
| `npm run build` | 0 | ✅ |
| `npx tsc --noEmit` | 0 | ✅ |
| `npm run admin-js-check` | 0 | ALL PASS ✅ |

## 12. Not Executed on Production

- ❌ `prisma migrate deploy`
- ❌ Production backfill
- ❌ Dual-write enabled
- ❌ PostgreSQL primary read switch
- ❌ Redis review data deletion
- ❌ git commit / push
