# Wave 3 Agent Contracts (FROZEN)

> **Status: FROZEN** — Authoritative specifications for Wave 3 agents, Integrator, and Agent R.
> **Start conditions:** Wave 1 + Wave 2 all merged and real tests passed:
> - account-schema-migrations
> - frontend-email-auth
> - guanli-admin-auth
> - runtime-account-isolation
> - qa-real-baseline

## Wave 3 Parallelism Constraints

1. Review API and Apply Agent MUST NOT modify `admin.ts` simultaneously
2. Review API Agent completes route split FIRST
3. Apply Agent starts from post-split baseline
4. Guanli UI waits for Admin Auth + Review API contracts to stabilize
5. Crawler can run independently in parallel

**Execution order:**
- Phase 3a (parallel): Agent Review API + Agent Crawler
- Phase 3b: Agent Apply (after Review API split merged)
- Phase 3c: Agent Guanli UI (after Admin Auth + Review API stable)
- Integrator: sequential merge (12 steps)
- Agent R: fresh clone final review

---

## Agent Review API: 审核权限和持久化闭环

**Branch:** `agent/review-admin-identity`
**Wave:** 3a (parallel with Crawler)
**Base:** Latest main after Wave 2 merge

### File Ownership (EXCLUSIVE)
- Review route
- Review service
- Review repository integration
- Review API tests
- One-time Review route split from `admin.ts`

### Prohibited
- Modify `schema.prisma`
- Modify `auth.ts`
- Modify admin-auth route
- Modify `guanli_index.php`
- Modify Apply business logic
- Modify `nas_crawler_agent.py`

### Tasks
1. Split Review routes from oversized `admin.ts` to independent file
2. Maintain API path compatibility
3. All Review admin operations accept AdminAccount ONLY
4. `reviewerId` and `ReviewDecision.reviewerId` use AdminAccount.id
5. FORBID ordinary User token as reviewer
6. Authorization by AdminAccount.role:
   - `admin`: all
   - `reviewer`: review actions
   - `operator`: Crawler operations
7. PostgreSQL is the ONLY source of truth for ReviewItem/ReviewDecision
8. Redis only for: cache, lock, notification
9. GET list: `_count.images`, real imageCount, main image loads ONE only, evidence/currentState separated
10. GET item: readback reviewer, reviewer displayName, decisionReason, decisionAt, decision history
11. PUT MUST NOT modify: status, reviewerId, decisionAt, fingerprint, lastAction
12. recheck returns ONLY: problems, currentState, recommendedStatus, evidenceChanged
13. recheck does NOT auto-resolve
14. action must be transactional: expectedStatus/version, legal state transition, append-only ReviewDecision, update ReviewItem, create CrawlerJob if needed
15. Illegal state transition → 409
16. `duplicate_decided` must have human ReviewDecision
17. `pending`/`needs_changes` only count as active duplicate
18. Implement reopen: primaryImage changed, imageIds changed, approved image missing, candidate hash changed, relevant details changed, manual reopen
19. `request_refetch` idempotent
20. All IDs are strings
21. FORBID Redis KEYS command
22. Action → GET readback consistent
23. Request records AdminAuditLog: actorAdminId, reviewItemId, action, requestId

### Required Tests
- 8 images
- one-image resolved
- recheck no mutation
- action audit
- reviewer readback
- duplicate_decided
- duplicate_active
- reopen image set
- reopen candidate
- approved image missing
- refetch idempotent
- illegal transition
- concurrent actions
- User JWT denied
- reviewer role accepted
- operator role denied for final review
- AdminAuditLog written

---

## Agent Crawler: 后端与 NAS 状态机

**Branch:** `agent/crawler-final-state`
**Wave:** 3a (parallel with Review API)
**Base:** Latest main after Wave 2 merge

### File Ownership (EXCLUSIVE)
- crawler route/service
- crawler state machine
- `nas_crawler_agent.py`
- `mfc_batch_scraper.py`
- Crawler tests

### Prohibited
- Modify Review route
- Modify `schema.prisma`
- Modify Guanli UI
- Modify User/Admin auth implementation

### Tasks
1. States unified: created, queued, claimed, running, completed, failed, deferred
2. NO more succeeded/cancelled
3. Legacy status mapped only in migration layer
4. PostgreSQL stores: CrawlerJob, CrawlerJobEvent
5. Redis only for notification and short-term claim coordination
6. Claim MUST be atomic
7. Claim request includes: jobId, agentId, expectedStatus, protocolVersion
8. NAS Agent startup reports: code SHA, protocolVersion, hostname, agentId
9. Backend rejects incompatible protocol
10. Every state change appends CrawlerJobEvent
11. Before completed, verify: scraper success, Figure writeback success, image writeback success, API readback success
12. HTTP 200 ≠ completed
13. `request_refetch` idempotent for same unfinished task
14. Agent does NOT expand concurrency
15. Agent tests do NOT access production sites
16. Delete or explicitly handle unused `register_images` top-level dependency
17. Crawler admin operations only by: AdminAccount admin, AdminAccount operator
18. User token MUST be rejected

### Required Tests
- valid transitions
- invalid transitions
- atomic claim
- duplicate claim
- expired claim
- retry
- writeback failure
- readback failure
- zero image
- partial image
- deferred
- protocol mismatch
- terminal cannot claim
- User JWT denied

---

## Agent Apply: 业务拆分、事务和幂等

**Branch:** `agent/apply-transaction-service`
**Wave:** 3b (after Review API split merged)
**Base:** Must be based on post-Review-API-route-split latest main

### File Ownership (EXCLUSIVE)
- apply route
- apply service
- apply schemas
- apply lock
- apply tests

### Prohibited
- Modify Review route public contract
- Modify `schema.prisma` (unless model change request submitted first)
- Modify auth
- Modify Guanli UI

### Tasks
1. Completely split Apply out of `admin.ts`
2. Strictly distinguish: figure_import, jan_match, rewrite, image, image_review
3. Each type uses independent Zod schema
4. FORBID payload mass assignment
5. FORBID direct spread user input to Prisma data
6. slug and JAN queried separately
7. slug/JAN hitting different Figure → 409
8. Figure, Revision, relations, activeRevisionId use transaction
9. Image files: temp write, format validation, hash validation, atomic rename, transaction, failure cleanup
10. Use Figure-level lock or optimistic version
11. Add Apply idempotency key
12. Use or introduce ReviewApplyAttempt
13. Same request retry must NOT duplicate: Figure, Revision, FigureImage, relation
14. All Apply only by AdminAccount reviewer/admin
15. Write AdminAuditLog
16. `success=true` only when: DB commit, files complete, readback consistent, Review state consistent
17. Partial failure must NOT return full success
18. Cache invalidation failure must be explicitly reported
19. Lock lost → stop new side effects
20. FORBID background unawaited Promise continuing to modify data

### Required Tests
- figure import
- slug/JAN conflict
- all images fail
- partial images fail
- duplicate retry
- concurrent same Figure
- revision rollback
- lock lost
- file cleanup
- cache failure
- readback
- admin role
- User JWT denied
- top-level success semantics

---

## Agent Guanli UI: 后台登录和审核 UI

**Branch:** `agent/guanli-account-review-ui`
**Wave:** 3c (after Admin Auth + Review API stable)
**Base:** Latest main after Wave 3a + 3b merge

### File Ownership (EXCLUSIVE)
- `guanli_index.php`
- Guanli static resources
- Guanli browser tests

### Prohibited
- Modify backend

### Tasks
1. Login form shows ONLY: username, password
2. NO email input
3. Call `/admin/auth/login`
4. DO NOT call `/auth/login`
5. Use independent backend Cookie/session
6. Frontend User login state does NOT auto-login Guanli
7. Guanli logout clears Admin session ONLY
8. User token accessing backend → show unauthorized, no compatibility attempt
9. Review card shows: Original Evidence, Current State, Candidate, Decision History, reviewer, decisionReason, decisionAt
10. Status uses ONLY: pending, needs_changes, resolved, rejected, archived
11. Support actions: approve_image, reject_image, keep_placeholder, request_refetch, keep_pending, mark_detail_ok, mark_needs_manual_edit, reopen, archive
12. Action: loading, disabled, double-click guard, inflight dedup, AbortController, stale request abort
13. FORBID local state modification pretending success
14. Action → GET readback
15. Candidate preview/lightbox uses same identity
16. object URL revoked on replace, destroy, page switch
17. DO NOT rebuild entire UI
18. DO NOT cause image request storm

### Browser Tests
- User email login page
- Guanli username login page
- login isolation
- logout isolation
- User token rejected
- Admin login success
- double-click
- action readback
- stale request abort
- object URL cleanup
- Console error=0
- pageerror=0

---

## Integrator: 逐分支合并

**Start:** Must start from latest origin/main
**Condition:** All Wave 1 + 2 + 3 agents complete

### Merge Order (STRICT — 12 steps)
1. post-push verification / contract fix
2. account-schema-migrations
3. qa-real-baseline
4. repository-hygiene
5. frontend-email-auth
6. guanli-admin-auth
7. runtime-account-isolation
8. review-admin-identity
9. crawler-final-state
10. apply-transaction-service
11. guanli-account-review-ui
12. reviewer fixes

### Per-Merge Pre-check
- `git fetch`
- Check base SHA
- Check file ownership (no cross-agent conflicts)
- Check migration
- Review diff
- View test evidence

### Per-Merge Post-check (ALL must pass)
- `prisma generate`
- `prisma validate`
- `migrate deploy`
- `typecheck`
- `build`
- `lint`
- unit tests
- route tests
- PostgreSQL integration
- Redis integration
- migration tests
- PHP syntax
- Python tests
- secret scan

### Failure Handling
- STOP merging
- DO NOT continue to next branch
- Mark FAILED
- Create minimal fix branch

### Prohibited
- Force push
- Merge all branches without review
- Commit patch/tar/bundle
- Modify applied migration
- Hide skipped tests
- Mark mock results as real integration

---

## Agent R: 最终独立 Reviewer

**Condition:** Integrator complete
**MUST start from fresh clone** — DO NOT reuse development Agent conclusions

### Section 1: Source-of-Truth
Check: origin/main SHA, local SHA, deployment backend SHA, deployed Guanli version, NAS Agent SHA, Prisma migration version, dirty/untracked, active worktrees, unmerged recovery branches

Any inconsistency → `INCONSISTENT`

### Section 2: 账号闭环

**Frontend User:**
1. Email registration
2. Duplicate email
3. Email verification
4. Email login
5. Forgot password
6. Reset password
7. Password change → old token invalid
8. Disabled → old token invalid

**Guanli:**
1. Username login
2. No email required
3. Password change → old token invalid
4. Disabled → old token invalid
5. AdminAuditLog exists

**Isolation tests:**
1. User JWT → Admin route → 401/403
2. Admin JWT → User-only route → 401/403
3. Email credentials login Guanli → fail
4. Guanli username login User portal → fail
5. Two logout systems don't affect each other

### Section 3: Database and Migration
Use: empty disposable DB, old version fixture DB
Execute: migrate deploy, data upgrade, data count check, unique constraint, rollback recovery drill
FORBID using db push as migration

### Section 4: Review/Crawler/Apply
Verify: real image count, ReviewDecision, Admin reviewer identity, recheck no mutation, duplicate suppression, reopen, atomic Crawler claim, Crawler readback, illegal transition, Apply transaction, Apply idempotency, concurrent action, concurrent Apply, failure cleanup

### Section 5: Test Commands
Record per command: command, start, end, exitCode, discovered, executed, passed, failed, skipped, environment
Must include: frozen install, Prisma generate/validate, migration, typecheck, build, lint, unit, route, real PostgreSQL, real Redis, migration tests, PHP, Python, browser E2E, secret scan

### Section 6: Final Status
Each item can only be: `VERIFIED` | `PARTIAL` | `FAILED` | `NOT TESTED` | `INCONSISTENT`

Only deploy if ALL are VERIFIED:
- local/remote/deployment consistent
- Frontend email account complete
- Guanli independent account complete
- Two token systems isolated
- Formal migration passes
- Test numbers reproducible
- Review/Crawler/Apply loop
- Browser loop
- No P0/P1 blocking issues

**Otherwise final conclusion:** `DO_NOT_DEPLOY` / `DO_NOT_ADVANCE_TO_PHASE_3`

---

## Complete Wave Timeline

```
Wave 1 (parallel):
  Agent Schema (account-schema-migrations)     ─┐
  Agent QA (qa-real-baseline)                  ─┤  Different file ownership
  Agent Repository Hygiene (repository-hygiene)─┘

  [GATE: Wave 1 complete + merge + verify]

Wave 2 (parallel):
  Agent User Auth (frontend-email-auth)        ─┐
  Agent Admin Auth (guanli-admin-auth)         ─┤  Different file ownership
  Agent Runtime (runtime-account-isolation)    ─┘

  [GATE: Wave 2 complete + merge + verify]

Wave 3a (parallel):
  Agent Review API (review-admin-identity)     ─┐
  Agent Crawler (crawler-final-state)          ─┘  Different file ownership

  [GATE: 3a complete + Review API split merged]

Wave 3b:
  Agent Apply (apply-transaction-service)      ── Based on post-split main

  [GATE: 3b complete + merge]

Wave 3c:
  Agent Guanli UI (guanli-account-review-ui)   ── After Admin Auth + Review API stable

  [GATE: 3c complete + merge]

Integrator: 12-step sequential merge

  [GATE: Integration complete]

Agent R: Fresh clone final review

  [GATE: VERIFIED or DO_NOT_DEPLOY]
```
