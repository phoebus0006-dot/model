# Review Migration SQL Review

## Migration File

`prisma/migrations/20260711_add_review_models/migration.sql`

## Operations

| # | Operation | Type | Additive? |
|---|-----------|------|-----------|
| 1 | CREATE TABLE review_items | Table creation | ✅ |
| 2 | CREATE TABLE review_events | Table creation | ✅ |
| 3 | CREATE UNIQUE INDEX review_items_public_id_key | Index | ✅ |
| 4 | CREATE UNIQUE INDEX review_items_original_redis_key_key | Index | ✅ |
| 5 | CREATE INDEX review_items_status_created_at_idx | Index | ✅ |
| 6 | CREATE INDEX review_items_figure_id_idx | Index | ✅ |
| 7 | CREATE INDEX review_items_risk_type_idx | Index | ✅ |
| 8 | CREATE INDEX review_items_evidence_fingerprint_idx | Index | ✅ |
| 9 | CREATE INDEX review_events_review_item_id_created_at_idx | Index | ✅ |
| 10 | CREATE INDEX review_events_request_id_idx | Index | ✅ |
| 11 | ALTER TABLE ADD FOREIGN KEY | FK constraint | ✅ |

## Additive Check

- ✅ ONLY CREATE TABLE / CREATE INDEX / ALTER TABLE ADD FOREIGN KEY
- ❌ NO DROP TABLE
- ❌ NO DROP COLUMN
- ❌ NO TRUNCATE
- ❌ NO ALTER COLUMN ... TYPE
- ❌ NO DELETE FROM
- ❌ NO existing table modifications

**Verdict: PURE ADDITIVE. Safe to deploy on existing schema.**

## Lock Risk

- `review_items` + `review_events` are new tables — no lock contention with existing tables
- Index creation on new tables is non-blocking for existing workloads

## Execution Cost

| Table | Estimated Rows | Index Build |
|-------|---------------|-------------|
| review_items | 0 (new, empty) | Instant |
| review_events | 0 (new, empty) | Instant |

## Rollback

```sql
DROP TABLE IF EXISTS review_events CASCADE;
DROP TABLE IF EXISTS review_items CASCADE;
```

Or use `prisma migrate down` after the migration is recorded.
