# Wave 1 Agent Contracts (FROZEN)

> **Status: FROZEN** — These contracts are the authoritative specifications for Wave 1 agents.
> **Start conditions:** POST_PUSH_VERIFICATION.md complete + HEAD==origin/main + AUTH_ACCOUNT_CONTRACT.md corrected + canonical SHA frozen.

## Canonical Baseline

- **CANONICAL_SHA**: `cb8e4dd60b72b65554ae770cb84c3219c3021050` (origin/main == HEAD)
- All Wave 1 worktrees MUST be created from this SHA:
  ```
  git worktree add ../model-<agent-name> -b agent/<agent-name> cb8e4dd
  ```

## Wave 1 Start Conditions (ALL must be TRUE)

- [x] POST_PUSH_VERIFICATION.md complete
- [x] HEAD == origin/main == cb8e4dd
- [x] AUTH_ACCOUNT_CONTRACT.md corrected (email policy, sessionVersion)
- [x] Canonical SHA frozen
- [ ] Human approval to start Wave 1

---

## Agent Schema: 账号模型和正式数据库迁移

**Branch:** `agent/account-schema-migrations`
**Wave:** 1 (parallel)
**Start condition:** Human approval

### File Ownership (EXCLUSIVE)
- `mw-backend/prisma/schema.prisma`
- `mw-backend/prisma/migrations/**`
- `mw-backend/scripts/migration/**`
- migration tests
- fixture/schema tests

### Prohibited
- Modify `auth.ts`
- Modify admin auth routes
- Modify `admin.ts`
- Modify `index.ts`
- Modify `guanli_index.php`
- Modify `package.json`

### Tasks
1. Check existing Review/Crawler models — DO NOT delete or rebuild existing models
2. Restore frontend User email fields:
   - `email`, `normalizedEmail`, `emailVerifiedAt`, `emailVerifyTokenHash`, `emailVerifyExpiresAt`
   - `passwordResetTokenHash`, `passwordResetExpiresAt`, `sessionVersion`
3. Both `email` and `normalizedEmail` get DB unique constraints
4. `User.role` restricted to: `user`, `editor` ONLY
5. Create `AdminAccount` model (per AUTH_ACCOUNT_CONTRACT.md §3.6)
6. Create `AdminAuditLog` model (per AUTH_ACCOUNT_CONTRACT.md §3.6)
7. `ReviewItem.reviewerId` and `ReviewDecision.reviewerId` must ultimately reference `AdminAccount` (not User)
8. Data migration must NOT assume existing Users all have emails
9. Output dry-run classification first:
   - totalUsers, validEmailUsers, missingEmailUsers, duplicateEmails, malformedEmails
   - adminLikeUsers, automaticallyMigratable, manualReviewRequired
10. DO NOT forge emails (no `user123@example.com`, no displayName-based emails)
11. Users without restorable email:
    - Preserve original data
    - Write to migration pending report
    - Migration must NOT silently delete
12. AdminAccount initialization must NOT auto-convert from User (unless explicit mapping list exists)
13. Create formal Prisma migration (NOT `prisma db push`)
14. Already-applied migrations must NOT be modified
15. Use new compensating migration for historical errors
16. Build tests:
    - empty database migration test
    - existing database upgrade test
    - duplicate email conflict test
    - rollback/recovery document
17. Verify existing Review/Crawler migrations are real and executable
18. Schema changes MUST come with migration

### Acceptance
- `prisma format`
- `prisma validate`
- `prisma generate`
- `migrate deploy` on empty disposable DB
- upgrade fixture migration test
- migration test passes
- no implicit data deletion
- Schema consistent with AUTH_ACCOUNT_CONTRACT.md

---

## Agent QA: 测试基线和 CI

**Branch:** `agent/qa-real-baseline`
**Wave:** 1 (parallel)
**Start condition:** Human approval

### File Ownership (EXCLUSIVE)
- `mw-backend/package.json`
- lockfile
- `mw-backend/tests/**`
- common test utilities
- `.github/workflows/**`
- `mw-backend/scripts/gate.*`
- test report generator

### Prohibited
- Modify business implementation code
- Modify `schema.prisma`
- Modify `auth.ts`, `admin-auth.ts`, `index.ts`, route files

### Tasks
1. Statistics from clean checkout
2. Output machine-readable manifest:
   - discovered, executed, passed, failed, skipped, duration, suite type
3. Test classification MUST distinguish:
   - unit, mock route, real PostgreSQL, real Redis, migration, PHP syntax, Python, browser E2E
4. Current "integration" tests that only use mock → re-label as mock integration
5. Add disposable PostgreSQL and Redis (Docker Compose or CI services, NOT production credentials)
6. Add commands:
   - `test:unit`, `test:route`, `test:integration`, `test:migration`, `test:python`, `test:php`, `test:e2e`, `lint`, `gate`
7. Frozen install MUST use single lockfile
8. Gate: any command non-zero → overall failure
9. Environment missing → FAILED or NOT TESTED (not skip-then-PASS)
10. `admin-js-check` SyntaxError → exit 1
11. Add startup smoke: `app.ready()`, route inventory, duplicate route detection
12. Route inventory must verify route + HTTP method
13. Add account isolation test skeletons:
    - User JWT accessing Admin route → 401/403
    - Admin JWT accessing User-only route → 401/403
14. Add real DB test environment, but business tests filled by later agents
15. GitHub Actions: npm ci, prisma generate, prisma validate, migrate deploy, typecheck, build, lint, unit, route, integration, migration, PHP, Python, secret scan
16. Test reports MUST come from real output (no handwritten counts)

### Acceptance
- Clean checkout can run
- CI uses disposable services
- Test numbers reproducible
- Mock-only NOT marked VERIFIED
- Unexecuted suites show NOT TESTED

---

## Agent Repository Hygiene: 仓库整理

**Branch:** `agent/repository-hygiene`
**Wave:** 1 (parallel)
**Start condition:** Human approval

### File Ownership (EXCLUSIVE)
- `.gitignore`
- `.gitattributes`
- `CONTRIBUTING.md`
- `docs/reconciliation/**`
- `scripts/reconciliation/**`
- Delete confirmed temporary artifacts

### Prohibited
- Modify business code
- Modify `schema.prisma`, `auth.ts`, `package.json`, etc.

### Tasks
1. Check for: `diff.txt`, `*.patch`, `*.patch.sha256`, `*.tar.gz`, `*.tar.gz.sha256`, temporary reports, build artifacts
2. Compare these artifacts — do they contain source code not in main?
3. Only delete after confirming source is in main OR recovery bundle
4. Update `.gitignore` to prevent re-submission
5. DO NOT commit recovery bundle to GitHub
6. DO NOT delete formal design docs, formal migrations, formal tests
7. Output artifact classification
8. Confirm all recovery branches/tags/bundles are restorable
9. DO NOT delete remote recovery branches unless human explicitly approves
10. Cleanup uses separate commit

### Acceptance
- Product main branch no longer contains temporary patch/tar/diff
- No unique source code lost
- Recovery bundle verifiable
- `git status` clean

---

## Wave 2 Start Conditions (after Wave 1)

ALL must be TRUE:
- [ ] Agent Schema merged (prisma generate + validate + migrate deploy on disposable DB pass)
- [ ] Agent QA merged (gate passes)
- [ ] Agent Repository Hygiene merged

Then Wave 2 agents (parallel):
- Agent User Auth (`agent/frontend-email-auth`) — `auth.ts`
- Agent Admin Auth (`agent/guanli-admin-auth`) — `admin-auth.*`
- Agent Runtime (`agent/runtime-account-isolation`) — `index.ts`

See WAVE2_AGENT_CONTRACTS.md for Wave 2+ contracts (Agent F/G/H, Integrator, Agent R).
