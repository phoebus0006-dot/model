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


## CI Verification

Appended after CI finalization. Local results above are preserved unchanged.

- PR: #1
- PR URL: https://github.com/phoebus0006-dot/model/pull/1
- CI run ID: 29347455931
- CI run URL: https://github.com/phoebus0006-dot/model/actions/runs/29347455931
- CI commit SHA: e21c0cdd5c7e8aef879d63686e42ac4da94740c9 (candidate branch HEAD, confirmed via `gh run view --json headSha`)
- Manifest commit_sha: a8b8884d6673593269df67882c6403d58254f410 (GitHub Actions PR merge commit — `actions/checkout@v4` checks out `refs/pull/1/merge` for PR events; headSha from API matches candidate HEAD)
- PostgreSQL: VERIFIED (test-integration real-postgresql-redis PASS, test-migration PASS, service: postgres:16-alpine healthy)
- Redis: VERIFIED (test-integration requires redis, PASS, service: redis:7-alpine healthy)
- Migration empty DB: VERIFIED (empty-db-migration.test.ts PASS within test-migration suite, 6 files discovered)
- Migration existing DB: VERIFIED (upgrade-fixture.test.ts PASS within test-migration suite, baseline flow with `migrate resolve --applied` + `migrate deploy`)
- PHP: VERIFIED (php-syntax PASS, 22 PHP files OK, PHP 8.3.32)
- Python: VERIFIED (python-tests PASS, 51 passed, 0 failed, Python 3.12.13)
- typecheck: VERIFIED (tsc --noEmit, 0 errors)
- build: VERIFIED (tsup, dist 224.58 KB)
- Full gate: VERIFIED (Full QA gate step PASS, manifest summary fail=0, overall_exit=0)
- Manifest artifact: VERIFIED (test-manifest artifact uploaded successfully, downloaded and verified)
- Browser E2E: NOT TESTED (Wave 2 backlog — account login UI not yet implemented)
- Secret scan: VERIFIED (no secrets found)
- Remaining blockers: NONE (all required CI checks green)

### CI Fix History (this session)

| Commit | Description | CI Run | Result |
|--------|-------------|--------|--------|
| a0d7c14 | fix(ci): align test manifest artifact path | 29344804793 | FAILED (Unit tests: Node 20 glob) |
| 4185002 | fix(tests): use node --test --import tsx for glob support | — | (intermediate) |
| 3053e33 | fix(ci): move TEST_MANIFEST_PATH to step-level env | — | (intermediate) |
| 1f70c5a | fix(ci): upgrade Node.js to 22 for --test glob support | 29345984316 | FAILED (Migration tests: hardcoded Windows psql) |
| 389a785 | fix(tests): make migration tests portable via DATABASE_URL parsing | 29346969087 | FAILED (Python tests: missing requests module) |
| e21c0cd | fix(ci): install requests module for Python tests | 29347455931 | SUCCESS |

### Manifest Summary (downloaded artifact)

- pass: 14
- fail: 0
- not_tested: 1 (browser-e2e only — Wave 2 backlog)
- total: 15
- overall_exit: 0
- NOT_TESTED does NOT include PostgreSQL, Redis, migration, or PHP (all VERIFIED)
- skipped and passed tracked separately (no skip-then-PASS inflation)
- mock integration: 6 discovered, 0 failed, 0 skipped (no 25-skip inflation)

### CI Step Verification (all 23 required checks)

1. PostgreSQL 16 service healthy: VERIFIED
2. Redis 7 service healthy: VERIFIED
3. PHP 8.3 installed: VERIFIED
4. Python 3.12 installed: VERIFIED
5. npm ci exit 0: VERIFIED
6. prisma generate exit 0: VERIFIED
7. prisma validate exit 0: VERIFIED
8. prisma migrate deploy exit 0: VERIFIED
9. typecheck exit 0: VERIFIED
10. build exit 0: VERIFIED
11. lint exit 0: VERIFIED
12. unit exit 0: VERIFIED
13. route exit 0: VERIFIED
14. mock integration exit 0: VERIFIED
15. smoke exit 0: VERIFIED
16. real integration exit 0: VERIFIED
17. migration tests exit 0: VERIFIED
18. admin-js-check exit 0: VERIFIED
19. PHP syntax exit 0: VERIFIED
20. Python tests exit 0: VERIFIED
21. secret scan exit 0: VERIFIED
22. full gate exit 0: VERIFIED
23. test manifest artifact uploaded: VERIFIED

### Merge Approval Gating

| Condition | Status |
|-----------|--------|
| CI commit == candidate branch HEAD | VERIFIED (e21c0cd) |
| PostgreSQL VERIFIED | VERIFIED |
| Redis VERIFIED | VERIFIED |
| migration empty DB VERIFIED | VERIFIED |
| existing DB upgrade VERIFIED | VERIFIED |
| PHP VERIFIED | VERIFIED |
| Python VERIFIED | VERIFIED |
| typecheck VERIFIED | VERIFIED |
| build VERIFIED | VERIFIED |
| full gate FAIL=0 | VERIFIED |
| manifest artifact VERIFIED | VERIFIED |
| PR checks all green | VERIFIED |
| working tree clean | VERIFIED |

**Wave 1 merge approved: YES**
**Wave 2 start approved: NO** (pending explicit human approval after reviewing this report)

Note: Merge approval is informational only. This Agent does NOT execute the merge. Awaiting explicit human review and separate merge authorization.
