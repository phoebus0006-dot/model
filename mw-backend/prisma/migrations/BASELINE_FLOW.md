# Baseline Flow for Existing Non-Empty Databases

**Audience**: Operators migrating an existing ModelWiki deployment onto the
Prisma migration track (Wave 1 Schema Hardening).

**Scope**: This document defines the formal procedure for bringing an existing,
non-empty PostgreSQL database under Prisma migration control WITHOUT bypassing
the P3005 safety check. Direct SQL is used only for backup/audit — never to
apply new migrations.

**Contract reference**: `docs/implementation/WAVE1_AGENT_CONTRACTS.md` tasks #7, #8.

## When to Use This Flow

Use this flow when ALL of the following are true:

- The target PostgreSQL database already contains tables (it is NOT empty)
- The database was created by a previous deployment path (manual SQL, db push,
  or an older migration system) and is NOT yet tracked by `_prisma_migrations`
- You want to adopt the Prisma migration track going forward

If the database is empty, skip this document and run `npx prisma migrate deploy`
directly — Prisma will apply all migrations from scratch.

## When NOT to Use This Flow

- **Empty database**: just run `npx prisma migrate deploy`.
- **Production database**: this flow is for disposable / staging databases only.
  Production baselining requires a separate maintenance window and a full
  runbook signed off by the on-call engineer.

## Prerequisites

- `psql` (PostgreSQL 14+ client) on PATH
- `npx prisma` available (run `npm ci` in `mw-backend/` first)
- A confirmed backup target with enough free space
- The target database must be reachable via `DATABASE_URL`
- No active write traffic during the baseline operation (quiesce the app)

## Step 0: Quiesce and Snapshot

1. Stop the application server (or switch it to read-only mode).
2. Record the current connection count:
   ```sh
   psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database();"
   ```
3. Confirm no long-running transactions are in flight:
   ```sh
   psql "$DATABASE_URL" -c "SELECT pid, age(now(), xact_start) AS xact_age, query FROM pg_stat_activity WHERE state = 'active' AND xact_start IS NOT NULL ORDER BY xact_start;"
   ```

## Step 1: Backup (pg_dump)

Take a physical backup of the entire database. This is non-negotiable.

```sh
pg_dump -Fc "$DATABASE_URL" -f baseline_backup_$(date +%Y%m%d_%H%M%S).dump
```

Verify the backup is restorable:

```sh
pg_restore --list baseline_backup_*.dump | head -20
```

If the backup fails or the restore list is empty, **STOP**. Do not proceed.

## Step 2: Structural Audit (prisma migrate diff)

Compare the live database schema against the migration history to identify
drift BEFORE touching `_prisma_migrations`. This step is read-only.

```sh
# Diff: migrations -> live database (shows what migrations expect vs. what exists)
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-url "$DATABASE_URL" \
  --shadow-database-url "$SHADOW_DATABASE_URL"
```

If the diff is non-empty (anything other than "No schema difference"), record
the output and analyze it. Possible outcomes:

- **Cosmetic differences** (e.g., index order, column order): acceptable,
  proceed to Step 3.
- **Missing tables/columns**: the live database is behind. Consider applying
  the missing migrations directly (only if the database is empty of those
  tables — otherwise use the baseline flow).
- **Extra tables/columns** (drift): the live database has undocumented
  additions. These must be reconciled manually before baselining. **Do NOT**
  proceed with `migrate resolve --applied` if there is drift that would cause
  a subsequent `migrate deploy` to fail.

## Step 3: Mark Pre-Existing Migrations as Applied (resolve --applied)

For each migration that was already applied to the live database (verified in
Step 2), mark it as applied in `_prisma_migrations`. This is the formal Prisma
baseline flow — it does NOT bypass P3005; it is the documented way to bring an
existing database under migration control.

```sh
npx prisma migrate resolve --applied 20260712000000_baseline_tables
npx prisma migrate resolve --applied 20260713000000_phase12_review_workflow
npx prisma migrate resolve --applied 20260713000001_review_storage_agent_a
```

Only mark migrations as applied whose schema changes are already present in the
live database. If a migration's tables are missing, do NOT mark it — let
`migrate deploy` apply it for real.

## Step 4: Verify _prisma_migrations Table

Confirm that every marked migration is recorded with a non-null `finished_at`
and a non-empty `checksum`.

```sh
psql "$DATABASE_URL" -c "
  SELECT migration_name, finished_at, rolled_back_at, checksum
  FROM \"_prisma_migrations\"
  ORDER BY migration_name;
"
```

Expected (as of Wave 1 baseline):

| migration_name | finished_at | rolled_back_at | checksum |
| --- | --- | --- | --- |
| 20260712000000_baseline_tables | non-null | NULL | non-empty |
| 20260713000000_phase12_review_workflow | non-null | NULL | non-empty |
| 20260713000001_review_storage_agent_a | non-null | NULL | non-empty |

If `finished_at` is NULL for any row, the migration is marked as failed. Remove
that row and re-run `migrate resolve --applied <name>`.

## Step 5: Apply Subsequent Migrations (migrate deploy)

Now run `migrate deploy` to apply any migrations that come after the baseline.
Prisma will skip the already-applied migrations (recorded in Step 3) and apply
only the new ones.

```sh
npx prisma migrate deploy
```

For the Wave 1 account schema migration, this will:

1. Apply `20260714000000_account_schema` (the new migration)
2. Preserve all existing User / ReviewItem / ReviewDecision rows
3. NULL out `review_items.reviewer_id` and `review_decisions.reviewer_id`
   (the original values are captured in `_reviewer_fk_migration_audit`)
4. Add the new email columns to `users` (nullable, transitional)
5. Create `admin_accounts`, `admin_audit_logs`, `_reviewer_fk_migration_audit`

## Step 6: Post-Deployment Verification

Run these checks after `migrate deploy` completes:

```sh
# All 4 migrations recorded
psql "$DATABASE_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL;"
# Expected: 4

# Reviewer FK target switched to admin_accounts
psql "$DATABASE_URL" -c "
  SELECT ccu.table_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_name IN
    ('review_items_reviewer_id_fkey', 'review_decisions_reviewer_id_fkey');
"
# Expected: admin_accounts (twice)

# Audit table populated (if any pre-migration reviewer_ids existed)
psql "$DATABASE_URL" -c "SELECT count(*), source_table FROM \"_reviewer_fk_migration_audit\" GROUP BY source_table;"
```

## Step 7: Run Dry-Run Classification (Optional, Recommended)

Before re-enabling write traffic, run the dry-run classifier to capture the
post-migration state for audit purposes:

```sh
npx tsx scripts/migration/dry-run-classify.ts > post_migration_report.json
```

This script performs ONLY read-only SELECT queries (zero DB writes). The
report includes:

- User email classification (total, valid, missing, duplicate, malformed)
- Reviewer FK migration metrics (before/after counts, distinct IDs, mapped,
  unmapped, nullified)
- Audit table contents reference

## Step 8: Re-Enable Write Traffic

If all verifications pass, restart the application server. Monitor logs for
the first 30 minutes for any FK constraint violations or unexpected Prisma
errors.

## Rollback

If the migration fails or causes application errors, use the rollback
procedure in `20260714000000_account_schema/ROLLBACK_RECOVERY.md` after
restoring from the backup taken in Step 1.

## Forbidden Actions

The following are STRICTLY FORBIDDEN during the baseline flow:

- `npx prisma db push` — bypasses migrations entirely (task #17)
- Direct `psql` execution of new migration SQL — bypasses P3005 (task #8)
- `DELETE FROM "_prisma_migrations"` to "reset" history — destroys audit trail
- `FLUSHDB` on Redis or any cache-flushing that hides data inconsistency
- Connecting to production PostgreSQL or Redis from a development machine
- Forging emails to satisfy NOT NULL constraints (task #10)

## Contact

For questions about this flow, refer to:

- `docs/implementation/WAVE1_AGENT_CONTRACTS.md` — Agent Schema task contract
- `docs/implementation/AUTH_ACCOUNT_CONTRACT.md` — User/AdminAccount spec
- `20260714000000_account_schema/ROLLBACK_RECOVERY.md` — rollback guide
