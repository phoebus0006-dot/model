# Rollback & Recovery Guide: Account Schema Migration

**Migration**: `20260714000000_account_schema`
**Date**: 2026-07-14
**Agent**: Agent Schema (account-schema-migrations)

## Overview

This document describes how to rollback the account schema migration and
recover from various failure scenarios. The migration is designed to be
**non-destructive** (no data deletion), but rollback procedures are provided
for emergency situations.

## When to Rollback

Rollback should ONLY be considered if:
1. The migration causes application failures that cannot be hotfixed
2. FK constraint conflicts block critical operations
3. Data corruption is detected post-migration

**Do NOT rollback** for:
- Missing email data on existing users (expected — transitional migration)
- NULL reviewer_id values (expected — no auto-conversion per contract)

## Pre-Rollback Checklist

- [ ] Backup the current database: `pg_dump -Fc > pre_rollback_backup.dump`
- [ ] Confirm no active admin sessions (check `admin_accounts.last_login_at`)
- [ ] Notify all agents and stakeholders
- [ ] Verify the backup is restorable: `pg_restore --list pre_rollback_backup.dump`

## Rollback Steps

### Step 1: Drop new FK constraints

```sql
ALTER TABLE "review_items" DROP CONSTRAINT IF EXISTS "review_items_reviewer_id_fkey";
ALTER TABLE "review_decisions" DROP CONSTRAINT IF EXISTS "review_decisions_reviewer_id_fkey";
ALTER TABLE "admin_audit_logs" DROP CONSTRAINT IF EXISTS "admin_audit_logs_actor_admin_id_fkey";
```

### Step 2: Drop new tables

```sql
DROP TABLE IF EXISTS "admin_audit_logs" CASCADE;
DROP TABLE IF EXISTS "admin_accounts" CASCADE;
```

### Step 3: Drop email columns and indexes from users

```sql
DROP INDEX IF EXISTS "users_email_key";
DROP INDEX IF EXISTS "users_normalized_email_key";
ALTER TABLE "users" DROP COLUMN IF EXISTS "email";
ALTER TABLE "users" DROP COLUMN IF EXISTS "normalized_email";
ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verified_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verify_token_hash";
ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verify_expires_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_reset_token_hash";
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_reset_expires_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "session_version";
```

### Step 4: Restore old reviewer FK (pointing to users)

```sql
-- NOTE: reviewer_id values were NULLed by the migration.
-- The original user IDs are lost. This FK restoration is structural only.
ALTER TABLE "review_items"
  ADD CONSTRAINT "review_items_reviewer_id_fkey"
  FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "review_decisions"
  ADD CONSTRAINT "review_decisions_reviewer_id_fkey"
  FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL;
```

### Step 5: Mark migration as rolled back

```sql
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260714000000_account_schema';
```

### Step 6: Verify rollback

```sql
-- Confirm admin tables are gone
SELECT count(*) FROM information_schema.tables WHERE table_name IN ('admin_accounts', 'admin_audit_logs');
-- Expected: 0

-- Confirm email columns are gone
SELECT count(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email';
-- Expected: 0

-- Confirm reviewer FK points to users
SELECT ccu.table_name
FROM information_schema.table_constraints tc
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
WHERE tc.table_name = 'review_items' AND tc.constraint_type = 'FOREIGN KEY';
-- Expected: users
```

## Recovery Scenarios

### Scenario 1: Migration fails midway

If `prisma migrate deploy` fails during execution:

1. Check `_prisma_migrations` table for the migration status:
   ```sql
   SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
   WHERE migration_name = '20260714000000_account_schema';
   ```

2. If `finished_at IS NULL` (failed), the migration is marked as failed. Prisma
   will not re-run it. You must either:
   a. Fix the issue and mark it for re-run:
      ```sql
      DELETE FROM "_prisma_migrations" WHERE migration_name = '20260714000000_account_schema';
      ```
      Then re-run `npx prisma migrate deploy`.
   b. Or manually complete the remaining statements, then:
      ```sql
      UPDATE "_prisma_migrations" SET finished_at = NOW() WHERE migration_name = '20260714000000_account_schema';
      ```

3. Inspect which statements succeeded:
   ```sql
   SELECT table_name FROM information_schema.tables WHERE table_name IN ('admin_accounts', 'admin_audit_logs');
   SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email';
   ```

### Scenario 2: Duplicate email blocks unique index creation

The migration adds `email` as a nullable column. Existing users get NULL email.
The unique index on a nullable column allows multiple NULLs, so this should NOT
block migration.

However, if a previous manual migration added email data with duplicates:

1. Detect duplicates:
   ```sql
   SELECT email, count(*) FROM "users" WHERE email IS NOT NULL GROUP BY email HAVING count(*) > 1;
   ```
2. Null out duplicates (keep the most recent):
   ```sql
   UPDATE "users" SET email = NULL WHERE id NOT IN (
     SELECT MAX(id) FROM "users" WHERE email IS NOT NULL GROUP BY email
   );
   ```
3. Re-run `npx prisma migrate deploy`

### Scenario 3: reviewer_id FK constraint fails

If the new FK constraint (reviewer_id -> admin_accounts) fails because existing
reviewer_id values reference non-existent admin accounts:

1. The migration NULLs all existing reviewer_id values before creating the FK,
   so this should not happen. If it does:
   ```sql
   UPDATE "review_items" SET reviewer_id = NULL WHERE reviewer_id IS NOT NULL;
   UPDATE "review_decisions" SET reviewer_id = NULL WHERE reviewer_id IS NOT NULL;
   ```
2. Re-run `npx prisma migrate deploy`

### Scenario 4: Lost admin account

If an admin account was accidentally deleted:

1. Check audit logs for the deletion event:
   ```sql
   SELECT * FROM "admin_audit_logs" WHERE target_type = 'admin_account' AND action = 'delete' ORDER BY created_at DESC;
   ```
2. Recreate the admin account:
   ```sql
   INSERT INTO "admin_accounts" ("username", "normalized_username", "password_hash", "display_name", "role", "is_active", "session_version", "updated_at")
   VALUES ('recovered_admin', 'recovered_admin', '$2a$...', 'Recovered Admin', 'admin', true, 0, CURRENT_TIMESTAMP);
   ```
3. Force password reset on next login:
   ```sql
   UPDATE "admin_accounts" SET password_changed_at = '1970-01-01' WHERE username = 'recovered_admin';
   ```

## Post-Rollback Verification

After rollback, verify:

1. Application starts without errors
2. Existing review items are accessible
3. User authentication (password-based) still works
4. No references to `admin_accounts` or `admin_audit_logs` remain in code
   (if the application code has been updated, you may need to revert code too)

## Data Preservation Guarantees

The migration is designed to preserve:
- All existing user records (display_name, role, is_active, etc.)
- All review_items and review_decisions records
- Audit metadata (reviewer_role, evidence_fingerprint) in review_decisions
- All figures, series, manufacturers, and other domain tables

The migration does NOT preserve:
- reviewer_id references (NULLed, no auto-conversion to AdminAccount)
- This is by design per AUTH_ACCOUNT_CONTRACT.md section 5

## Contact

For rollback assistance, refer to:
- `AUTH_ACCOUNT_CONTRACT.md` — contract specification
- `WAVE1_AGENT_CONTRACTS.md` — Agent Schema task contract
- Migration SQL: `prisma/migrations/20260714000000_account_schema/migration.sql`
