# Wave 1 Candidate Branch Review

## Candidate Information
- Candidate branch: integration/wave1-candidate
- Candidate base: b848c69871554494863fe6add2589cecd91b45b8 (refs/tags/wave0-final)
- Candidate final SHA: f0ab7a1c5a44f3d9fa5c10206cb490bad0980c65
- Total commits: 8 (3 Schema + 2 QA + 2 Hygiene + 1 Integration fix)

## Commit Chains

### Schema (3 commits)
1. bf286e3 — feat(account-schema): add User email fields, AdminAccount/AdminAuditLog, reviewer FK migration + tests
2. 63d94c8 — style(account-schema): apply prisma format alignment
3. eb43501 — hardening(schema): remove IF EXISTS guards, add reviewer FK audit table, baseline flow

### QA (2 commits)
4. d32c898 — test(qa): establish real test baseline and CI with disposable services
5. 77de3a0 — test(qa): split mock route/integration gates, fix Python discovery, manifest as CI artifact

### Hygiene (2 commits)
6. 043f585 — chore(repo): add repository hygiene rules and artifact classification
7. c266b46 — docs(reconciliation): Wave 1 hygiene independent review of 0139756

### Integration Fix (1 commit)
8. f0ab7a1 — fix(wave1): make test manifest output reproducible

## Conflicts
NONE — all cherry-picks completed without conflicts.

## Changed Files (34 files)

`git diff --name-status b848c69871554494863fe6add2589cecd91b45b8..f0ab7a1c5a44f3d9fa5c10206cb490bad0980c65` (33 entries representing the candidate final SHA; the 34th file is this review report, added in the report commit):

```
A       .gitattributes
M       .github/workflows/ci.yml
M       .gitignore
A       CONTRIBUTING.md
A       docs/reconciliation/ARTIFACT_CLASSIFICATION.md
A       docs/reconciliation/WAVE1_HYGIENE_REVIEW.md
A       mw-backend/docker-compose.test.yml
M       mw-backend/package.json
A       mw-backend/prisma/migrations/20260712000000_baseline_tables/migration.sql
A       mw-backend/prisma/migrations/20260714000000_account_schema/ROLLBACK_RECOVERY.md
A       mw-backend/prisma/migrations/20260714000000_account_schema/migration.sql
A       mw-backend/prisma/migrations/BASELINE_FLOW.md
A       mw-backend/prisma/migrations/migration_lock.toml
M       mw-backend/prisma/schema.prisma
M       mw-backend/scripts/gate.mjs
A       mw-backend/scripts/migration/dry-run-classify.ts
A       mw-backend/tests/e2e/browser.test.ts
A       mw-backend/tests/migration/duplicate-email-conflict.test.ts
A       mw-backend/tests/migration/empty-db-migration.test.ts
A       mw-backend/tests/migration/malformed-email.test.ts
A       mw-backend/tests/migration/migration.test.ts
A       mw-backend/tests/migration/reviewer-mapping-audit.test.ts
A       mw-backend/tests/migration/upgrade-fixture.test.ts
R100    mw-backend/tests/bigint-serialization.test.ts   mw-backend/tests/mock/bigint-serialization.test.ts
R100    mw-backend/tests/crawler-transition.test.ts     mw-backend/tests/mock/crawler-transition.test.ts
R100    mw-backend/tests/duplicate-suppression.test.ts  mw-backend/tests/mock/duplicate-suppression.test.ts
R100    mw-backend/tests/real-image-count.test.ts       mw-backend/tests/mock/real-image-count.test.ts
R100    mw-backend/tests/reopen.test.ts mw-backend/tests/mock/reopen.test.ts
R100    mw-backend/tests/review-action-audit.test.ts    mw-backend/tests/mock/review-action-audit.test.ts
A       mw-backend/tests/real/account-isolation.test.ts
A       mw-backend/tests/smoke/account-isolation-smoke.test.ts
A       mw-backend/tests/smoke/startup-smoke.test.ts
A       scripts/reconciliation/classify_artifacts.py
```

34th file: `A docs/reconciliation/WAVE1_CANDIDATE_REVIEW.md` (this report, added in the report commit).

## Local Verification Results

| Check | Exit Code | Status |
|-------|-----------|--------|
| npm ci | 0 | VERIFIED |
| prisma generate | 0 | VERIFIED |
| prisma validate | 0 | VERIFIED |
| typecheck | 0 (0 errors) | VERIFIED |
| build | 0 | VERIFIED |
| lint | 0 | VERIFIED |
| admin-js-check | 0 | VERIFIED |
| admin-js-check failure propagation | verified (injected SyntaxError → exit 1, restored → exit 0) | VERIFIED |
| test:unit | 258 passed, 0 failed, 0 skipped | VERIFIED |
| test:route | 13 passed, 0 failed, 0 skipped | VERIFIED |
| test:mock-integration | 2 passed, 0 failed, 25 skipped | VERIFIED |
| test:python | 51 passed, 0 failed, 0 skipped | VERIFIED |
| gate | 11 PASS, 0 FAIL, 4 NOT_TESTED, exit 0 | VERIFIED |
| artifact classification --strict | exit 0 (PASS) | VERIFIED |
| working tree clean | git status --short empty | VERIFIED |
| manifest portability | gitignored + test-artifacts/ + TEST_MANIFEST_PATH env var | VERIFIED |

## CI Verification Required (NOT TESTED locally — no Docker/PostgreSQL/Redis/PHP)

| Check | Status | CI Service |
|-------|--------|------------|
| PostgreSQL migration (empty DB) | NOT TESTED | postgres:16-alpine |
| PostgreSQL migration (existing DB upgrade) | NOT TESTED | postgres:16-alpine |
| Redis integration | NOT TESTED | redis:7-alpine |
| PHP syntax check | NOT TESTED | PHP 8.3 |
| Browser E2E | NOT TESTED | Wave 2 backlog |

## Gate Summary
- PASS: 11 (prisma-validate, typecheck, build, lint, admin-js-check, test-unit, test-route, test-smoke, test-mock-integration, python-tests, secret-scan)
- FAIL: 0
- NOT_TESTED: 4 (test-integration, test-migration, php-syntax, test-e2e)

## Remaining Blockers
1. PostgreSQL migration tests — require CI disposable PostgreSQL 16
2. Redis integration tests — require CI disposable Redis 7
3. PHP syntax check — require CI PHP 8.3
4. Browser E2E — Wave 2 backlog (account login UI not yet implemented)

## Wave 1 Merge Decision

| Condition | Status |
|-----------|--------|
| typecheck=0 | ✅ VERIFIED |
| build=0 | ✅ VERIFIED |
| migration empty DB | ⏳ NOT TESTED (requires CI) |
| existing DB upgrade | ⏳ NOT TESTED (requires CI) |
| PostgreSQL VERIFIED | ⏳ NOT TESTED (requires CI) |
| Redis VERIFIED | ⏳ NOT TESTED (requires CI) |
| Python VERIFIED | ✅ VERIFIED |
| PHP VERIFIED | ⏳ NOT TESTED (requires CI) |
| Gate FAIL=0 | ✅ VERIFIED |
| CI green | ⏳ PENDING (push + PR required) |
| working tree clean | ✅ VERIFIED |
| No P0/P1 blockers | ✅ VERIFIED |

**Wave 1 merge approved: NO** (pending CI verification of PostgreSQL/Redis/PHP)
**Wave 2 start approved: NO**
