# Review Migration Runbook

## Stage 0 — Schema Only (Additive, Safe to Deploy)

**Prerequisite**: Approval of REVIEW_SCHEMA_CHANGE_PROPOSAL.md

**Steps**:
```bash
cd mw-backend
npx prisma migrate dev --name add_review_models --create-only
# Review generated migration SQL — must be additive only
npx prisma migrate deploy
```

**Verify**:
```bash
npx prisma db execute --stdin <<< "SELECT COUNT(*) FROM review_items"
# → Returns 0, no error
```

**Success Criteria**:
- Tables exist, nullable columns
- Existing APIs unchanged
- Redis still the read/write source

**Rollback**:
```bash
npx prisma migrate down 1
```

## Stage 1 — History Backfill

**Prerequisite**: Stage 0 deployed, REVIEW_STORE_MODE=redis (default)

**Steps**:
```bash
# DRY-RUN first
npx tsx scripts/backfill-reviews-to-postgres.ts --redis=redis://... --dry-run --max=1000

# Validate output
# On approval:
npx tsx scripts/backfill-reviews-to-postgres.ts --redis=redis://... --execute --batch=200
```

**Verify**:
```bash
npx tsx scripts/audit-review-redis.ts --redis=redis://... --max=10000
# Compare total count with: SELECT COUNT(*) FROM review_items
```

**Success Criteria**:
- PG review_items count = Redis review:item:* count (within active-window delta)
- Zero invalid JSON, zero unmapped fields
- Sampled entries match (same publicId, same status, same timestamp)

**Stop Conditions**:
- Any data loss in backfill (fix backfill script before retry)
- More than 0.1% invalid JSON entries (investigate data format)
- EvidenceFingerprint unique constraint violation > 0 (design: fingerprint may not be unique)

**Rollback**: Delete backfilled rows, keep Redis data:
```sql
TRUNCATE review_items CASCADE;
```

## Stage 2 — Dual Write

**Prerequisite**: Stage 1 complete, REVIEW_STORE_MODE=dual

**Steps**:
```bash
export REVIEW_STORE_MODE=dual
# Deploy updated service
```

**Verify**:
- Create a review item → check both Redis and PG
- Apply a review action → check both
- Run audit script against both stores → diff report < 0.1%

**Success Criteria**:
- Every write appears in both stores within SLA
- Dual write failures logged but don't fail request
- Redis remains the authoritative read source

**Dual Write Failure Matrix**:
| PG | Redis | Request Result | Mitigation |
|----|-------|---------------|------------|
| ✅ | ✅ | ✅ Success | Normal |
| ✅ | ❌ | ✅ Success (degraded) | Redis logged, async retry scheduled |
| ❌ | ✅ | ❌ Failed (PG rollback or retry) | Retry PG; if permanent, mark for repair |
| ❌ | ❌ | ❌ Failed | Full failure — investigate infrastructure |

**Rollback**: `export REVIEW_STORE_MODE=redis` — instant revert

## Stage 3 — Shadow Read

**Prerequisite**: Stage 2 stable for N days, diff rate < 0.1%

**Steps**:
- Enable background comparison task
- Route reads to Redis, compare with PG asynchronously
- Log discrepancies without affecting response

**Success Criteria**: < 0.01% discrepancy over 7 days

## Stage 4 — PostgreSQL Primary Read

**Prerequisite**: Stage 3 passed, `REVIEW_STORE_MODE=postgres`

**Steps**:
```bash
export REVIEW_STORE_MODE=postgres
# Deploy
```

**Verify**:
- All 11 review routes return same response shape
- Stats counts match between Redis and PG
- Management interface unaffected

**Rollback**: `export REVIEW_STORE_MODE=dual` or `redis`

## Stage 5 — Stop Redis Review Writes

**Prerequisite**: Stage 4 stable N days

**Steps**:
- Disable Redis write path in code
- Keep Redis read-only for fallback (optional)
- Monitor for any Redis-only read attempts

**Verify**: Zero Redis write commands for review namespace in 24h

## Stage 6 — Final Cleanup (Separate Approval Required)

**Prerequisite**: Separate written approval

**Steps**:
- Export Redis review data as JSONL backup
- Delete `review:item:*`, `review:decision:*`, `review:items`, `review:decisions` keys
- Remove Redis-compatible code paths
- Simplify ReviewStore to direct PostgresReviewStore
