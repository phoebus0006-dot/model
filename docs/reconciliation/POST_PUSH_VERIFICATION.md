# Post-Push Verification (Wave 0)

> Generated on 2026-07-13 by Agent 0 (post-push verification).
> Previous report: REPOSITORY_INVENTORY.md (kept as historical snapshot, not overwritten).

## 1. Execution Time

- **Date**: 2026-07-13
- **Phase**: Wave 0 — post-push source-of-truth verification

## 2. Git State

| Field | Value |
|-------|-------|
| HEAD (local) | `cb8e4dd60b72b65554ae770cb84c3219c3021050` |
| origin/main | `cb8e4dd60b72b65554ae770cb84c3219c3021050` |
| **HEAD == origin/main** | **YES ✅** |
| Branch | `main` (up to date with origin/main) |
| Working tree | CLEAN (no diff, no cached, no untracked) |
| Stash | none |
| Worktrees | 1 (`D:/model wiki`) |
| Tags | 25 (all `backup/*` annotated tags) |
| Commit count (origin/main) | 42 |

## 3. Recent Commits (last 15)

```
cb8e4dd (HEAD -> main, origin/main, origin/HEAD) docs(reconciliation): freeze source-of-truth reports and agent contracts
c4ae36e (tag: backup/main/20260713-c4ae36e) merge: agent/review-api-integration
1ea965b (agent/review-api-integration) feat(review-api-integration): PG source of truth + ...
d68f3b9 fix: cast prisma mock to any in auth-role test (typecheck fix post-merge)
50947b3 merge: agent/qa-ci (GitHub Actions + test scaffolding + lockfile + gitignore)
05c7331 merge: agent/admin-ui (review card sections + action guards + lightbox consistency)
62a7207 merge: agent/crawler-state (Python 7 states + transition map + writeback verification)
52ae58c merge: agent/runtime-security (BigInt string + graceful shutdown + /ready + auth DB role check + HMAC)
70b81b7 merge: agent/review-storage (CrawlerJobEvent + canonical fingerprint + Redis→PG migration)
cac42ff (agent/crawler-state) feat(crawler-state): unify 7 states + transition map + ...
23b952f (agent/runtime-security) feat(runtime-security): BigInt string + graceful shutdown + /ready + HMAC
5c89799 (agent/admin-ui) feat(admin-ui): review card sections + action guards + lightbox consistency
46070d3 (agent/qa-ci) feat(qa-ci): GitHub Actions + test scaffolding + lockfile + gitignore
df45dae (agent/review-storage) feat(review-storage): CrawlerJobEvent + canonical fingerprint + Redis→PG migration
f68c822 chore(reviewer-fix): untrack artifact files, add .gitignore rules
```

## 4. Key Entity Verification (in origin/main = cb8e4dd)

| Entity | Present | Location / Notes |
|--------|---------|-----------------|
| `ReviewItem` | ✅ YES | `schema.prisma:358`, migration, 20+ files |
| `ReviewDecision` | ✅ YES | `schema.prisma:403`, migration, 10+ files |
| `CrawlerJob` | ✅ YES | `schema.prisma:429`, migration, 15+ files |
| `CrawlerJobEvent` | ✅ YES | `schema.prisma:466`, migration, docs |
| `DomainReviewRepository` | ✅ YES | `src/domain/review/repository.ts:175` |
| `computeCanonicalFingerprint` | ✅ YES | `src/domain/review/fingerprint.ts:127` |
| `admin-review-integration.test.ts` | ✅ YES | `src/routes/admin-review-integration.test.ts` |
| `stateMachine.test.ts` | ✅ YES | `src/crawler/stateMachine.test.ts` |
| `gate.mjs` | ✅ YES | `scripts/gate.mjs` |
| `docs/reconciliation/` | ✅ YES | 5 files (INVENTORY, BRANCH_CLASSIFICATION, TEST_BASELINE, ACCOUNT_MODEL_DECISION, RECOVERY_PLAN) |
| `docs/implementation/` | ✅ YES | 3 files (AUTH_ACCOUNT_CONTRACT, PHASE12_CONTRACT, WAVE2_AGENT_CONTRACTS) |
| Prisma migrations | ✅ YES | 2 migrations (20260713000000, 20260713000001) |
| `AdminAccount` | ❌ NO | Not in schema — **Agent Schema must create** |
| `AdminAuditLog` | ❌ NO | Not in schema — **Agent Schema must create** |
| `User.email` | ❌ NO | Removed in origin/main history — **Agent Schema must restore** |
| `normalizedEmail` | ❌ NO | Not in schema — **Agent Schema must create** |
| `apply-service` | ❌ NO | Only in `recovery/live-ui-admin` — **future Agent Apply must port** |
| `ReviewApplyAttempt` | ❌ NO | Only in `recovery/live-ui-admin` — **future Agent Apply must port** |

## 5. Current Repository Statistics

| Metric | Value |
|--------|-------|
| Total commits (origin/main) | 42 |
| Prisma models | 22 |
| Prisma migrations | 2 |
| Test files (TypeScript) | 18 |
| Test files (JavaScript .mjs) | 1 (`modelwiki-theme/tests/admin-ui-check.mjs`) |
| Test files (Python) | 2 (`modelwiki-theme/tests/test_material_parser.py`, `test_crawler_state.py`) |
| **Total test files** | **21** |
| Tests executed this round | 0 |

## 6. Current Prisma Models (22)

```
Figure, FigureLocalized, FigureRelease, Series, Character, Manufacturer,
Sculptor, Category, Revision, FigureImage, FigureCategory, FigureSculptor,
FigureCharacter, User, FavoriteGroup, Favorite, FigureLike, FigureComment,
EntityMapping, RedirectMap, ReviewItem, ReviewDecision, CrawlerJob, CrawlerJobEvent
```

**Missing models** (required by product decision):
- `AdminAccount` — must be created by Agent Schema
- `AdminAuditLog` — must be created by Agent Schema

## 7. Current Migrations

| Migration | Description |
|-----------|-------------|
| `20260713000000_phase12_review_workflow` | ReviewItem + ReviewDecision + CrawlerJob (idempotent CREATE TABLE IF NOT EXISTS) |
| `20260713000001_review_storage_agent_a` | CrawlerJobEvent + candidate_asset + request_id + indexes (idempotent) |

**Missing migrations** (required):
- User email restoration migration (add email, normalizedEmail, etc. columns)
- AdminAccount + AdminAuditLog creation migration

## 8. Current User Model (BROKEN)

```prisma
model User {
  id           BigInt   @id @default(autoincrement())
  passwordHash String?  @map("password_hash")     // nullable — should be required
  displayName  String   @map("display_name")
  avatarUrl    String?  @map("avatar_url")
  googleSub    String?  @unique @map("google_sub")
  wechatOpenid String?  @unique @map("wechat_openid")
  role         String   @default("user")          // allows any string — must restrict
  isActive     Boolean  @default(true) @map("is_active")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")
  @@map("users")
}
```

**Defects:**
1. No `email` field
2. No `normalizedEmail` field
3. No `emailVerifiedAt` field
4. No `emailVerifyTokenHash` / `emailVerifyExpiresAt`
5. No `passwordResetTokenHash` / `passwordResetExpiresAt`
6. No `sessionVersion`
7. `passwordHash` is nullable (should be required)
8. `role` has no constraint (allows admin/viewer — should only allow user/editor)
9. No `AdminAccount` model exists

**auth.ts references non-existent fields** — runtime bomb (hidden by `app.prisma as any`).

## 9. Recovery Branches Status

### Branch-backed recovery branches (10)
| Branch | SHA | Classification |
|--------|-----|---------------|
| recovery/main/20260713-c4ae36e | c4ae36e | MERGED_EQUIVALENT (ancestor of current main) |
| recovery/live-ui-admin/20260713-476f867 | 476f867 | PARTIALLY_SALVAGEABLE (email auth + apply-service) |
| recovery/phase12-r4/20260713-0320454 | 0320454 | OBSOLETE (subset of live-ui-admin) |
| recovery/master/20260713-a4c9d82 | a4c9d82 | OBSOLETE (Phase 12 baseline, superseded) |
| recovery/agent-admin-ui/20260713-5c89799 | 5c89799 | MERGED_EQUIVALENT (merged into main) |
| recovery/agent-crawler-state/20260713-cac42ff | cac42ff | MERGED_EQUIVALENT (merged into main) |
| recovery/agent-qa-ci/20260713-46070d3 | 46070d3 | MERGED_EQUIVALENT (merged into main) |
| recovery/agent-review-api/20260713-1ea965b | 1ea965b | MERGED_EQUIVALENT (merged into main) |
| recovery/agent-review-storage/20260713-df45dae | df45dae | MERGED_EQUIVALENT (merged into main) |
| recovery/agent-runtime-security/20260713-23b952f | 23b952f | MERGED_EQUIVALENT (merged into main) |

### Dangling commit recovery branches (15)
| Branch | SHA | Classification |
|--------|-----|---------------|
| recovery/dangling/keep-pending-a758383 | a758383 | NEEDS_MANUAL_REVIEW (production fix, not in any branch) |
| recovery/dangling/fix-429-cc705a9 | cc705a9 | NEEDS_MANUAL_REVIEW (production fix, 4 duplicate iterations exist) |
| recovery/dangling/candidate-cache-2361475 | 2361475 | NEEDS_MANUAL_REVIEW (production feature) |
| recovery/dangling/candidate-proxy-0d9ab33 | 0d9ab33 | NEEDS_MANUAL_REVIEW (production fix) |
| recovery/dangling/image-proxy-ssrf-254219c | 254219c | NEEDS_MANUAL_REVIEW (production feature) |
| recovery/dangling/proxy-ratelimit-397a15e | 397a15e | NEEDS_MANUAL_REVIEW (production fix) |
| recovery/dangling/prod-regressions-7c9b28a | 7c9b28a | NEEDS_MANUAL_REVIEW (production fix) |
| recovery/dangling/proxy-xss-88dbffe | 88dbffe | NEEDS_MANUAL_REVIEW (security fix) |
| recovery/dangling/phase12-r4-gates-99d3ada | 99d3ada | NEEDS_MANUAL_REVIEW (production gates) |
| recovery/dangling/candidate-cache-sys-7ca4cff | 7ca4cff | NEEDS_MANUAL_REVIEW (production feature) |
| recovery/dangling/material-mapping-69857e4 | 69857e4 | NEEDS_MANUAL_REVIEW (production fix + tests) |
| recovery/dangling/keep-pending-reason-7835686 | 7835686 | NEEDS_MANUAL_REVIEW (production fix) |
| recovery/dangling/sync-prod-source-4d9f77a | 4d9f77a | NEEDS_MANUAL_REVIEW (production sync) |
| recovery/dangling/material-mapping-taskc-edbf659 | edbf659 | NEEDS_MANUAL_REVIEW (production fix) |
| recovery/dangling/gitignore-env-ea6c9cf | ea6c9cf | MERGED_EQUIVALENT (already in main via f68c822) |

### Original (non-recovery) branches
| Branch | SHA | Classification |
|--------|-----|---------------|
| agent/admin-ui | 5c89799 | MERGED_EQUIVALENT |
| agent/crawler-state | cac42ff | MERGED_EQUIVALENT |
| agent/qa-ci | 46070d3 | MERGED_EQUIVALENT |
| agent/review-api-integration | 1ea965b | MERGED_EQUIVALENT |
| agent/review-storage | df45dae | MERGED_EQUIVALENT |
| agent/runtime-security | 23b952f | MERGED_EQUIVALENT |
| master | a4c9d82 | OBSOLETE |
| recovery/live-ui-admin | 476f867 | PARTIALLY_SALVAGEABLE |
| review/phase12-r4 | 0320454 | OBSOLETE (subset of recovery/live-ui-admin) |

## 10. Deployment and NAS Agent Status

| Item | Status |
|------|--------|
| Current deployment version | **UNKNOWN** — no access to production deployment from this session |
| Current NAS Agent SHA | **UNKNOWN** — `nas_crawler_agent.py` is in repo but production deployment SHA not verifiable from here |
| Migration version on production DB | **UNKNOWN** — no production DB access |

**These must be verified by Agent R (final reviewer) from production environment.**

## 11. Bundle Verification

| Item | Value |
|------|-------|
| Bundle path | `d:\model-wiki-backups\2026-07-13\model-wiki-all-20260713.bundle` |
| Bundle SHA-256 | `35D5185C1F068DBC62A5AEA0A4619BED0976556A34D7B71991B4FA0C3A6C74EC` |
| `git bundle verify` | PASSED (verified in previous session) |
| Refs in bundle | 65 |

## 12. Can Development Begin?

**YES, with conditions.**

The canonical baseline is frozen at `cb8e4dd` (origin/main == HEAD). Wave 1 agents can start from this SHA.

**Pre-conditions for Wave 1:**
- [x] HEAD == origin/main
- [x] Working tree clean
- [x] POST_PUSH_VERIFICATION.md created
- [x] Key entities verified (present/absent documented)
- [ ] AUTH_ACCOUNT_CONTRACT.md email policy corrected (in progress)
- [ ] Human approval to start Wave 1

**Wave 1 agents (parallel, from cb8e4dd):**
1. Agent Schema (`agent/account-schema-migrations`) — schema.prisma + migrations
2. Agent QA (`agent/qa-real-baseline`) — package.json + tests + CI
3. Agent Repository Hygiene (`agent/repository-hygiene`) — .gitignore + cleanup

**Wave 2 agents (after Agent Schema merged):**
1. Agent User Auth (`agent/frontend-email-auth`) — auth.ts
2. Agent Admin Auth (`agent/guanli-admin-auth`) — admin-auth routes
3. Agent Runtime (`agent/runtime-account-isolation`) — index.ts + middleware

## 13. File Ownership Matrix

| File/Directory | Owner Agent | Wave |
|---------------|-------------|------|
| `mw-backend/prisma/schema.prisma` | Agent Schema | 1 |
| `mw-backend/prisma/migrations/**` | Agent Schema | 1 |
| `mw-backend/package.json` + lockfile | Agent QA | 1 |
| `.github/workflows/**` | Agent QA | 1 |
| `mw-backend/scripts/gate.*` | Agent QA | 1 |
| `.gitignore` / `.gitattributes` | Agent Repository Hygiene | 1 |
| `docs/reconciliation/**` | Agent Repository Hygiene | 1 |
| `mw-backend/src/routes/auth.ts` | Agent User Auth | 2 |
| `mw-backend/src/routes/admin-auth.*` | Agent Admin Auth | 2 |
| `mw-backend/src/plugins/adminGuard.ts` | Agent Admin Auth | 2 |
| `mw-backend/src/index.ts` | Agent Runtime | 2 |
| `mw-backend/src/routes/admin.ts` | (future Agent Review API) | 3 |
| `guanli_index.php` | (future Agent Guanli UI) | 3 |
| `nas_crawler_agent.py` | (future Agent Crawler) | 3 |
