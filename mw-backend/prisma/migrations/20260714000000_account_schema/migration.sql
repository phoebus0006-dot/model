-- Account schema migration: restore User email fields, create AdminAccount/AdminAuditLog,
-- and migrate reviewerId FK from users to admin_accounts.
--
-- Source of truth: docs/implementation/AUTH_ACCOUNT_CONTRACT.md (FROZEN)
-- Wave 1 contract: docs/implementation/WAVE1_AGENT_CONTRACTS.md
--
-- DRIFT POLICY: This migration is NOT idempotent. Every DDL statement assumes the
-- database is in the exact state produced by migrations 20260712000000 +
-- 20260713000000 + 20260713000001. If the schema has drifted, the migration
-- fails loudly rather than silently masking the drift. This is required by the
-- Wave 1 Schema Hardening contract.
--
-- REVIEWER ID PRESERVATION (task #15): Before NULLing reviewer_id values, the
-- original (record_id, reviewer_id) pairs are copied into an audit table
-- `_reviewer_fk_migration_audit` so the source information is never lost. The
-- dry-run report (scripts/migration/dry-run-classify.ts) also captures the
-- distinct reviewer IDs and classification counts.
--
-- ROLLBACK (downgrade) — run these statements manually to revert:
--   ALTER TABLE "review_decisions" DROP CONSTRAINT "review_decisions_reviewer_id_fkey";
--   ALTER TABLE "review_items" DROP CONSTRAINT "review_items_reviewer_id_fkey";
--   ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_actor_admin_id_fkey";
--   DROP TABLE "admin_audit_logs";
--   DROP TABLE "admin_accounts";
--   DROP TABLE "_reviewer_fk_migration_audit";
--   DROP INDEX "users_normalized_email_key";
--   DROP INDEX "users_email_key";
--   ALTER TABLE "users" DROP COLUMN "session_version";
--   ALTER TABLE "users" DROP COLUMN "password_reset_expires_at";
--   ALTER TABLE "users" DROP COLUMN "password_reset_token_hash";
--   ALTER TABLE "users" DROP COLUMN "normalized_email";
--   ALTER TABLE "users" DROP COLUMN "email_verify_token_hash";
--   ALTER TABLE "users" DROP COLUMN "email_verify_expires_at";
--   ALTER TABLE "users" DROP COLUMN "email_verified_at";
--   ALTER TABLE "users" DROP COLUMN "email";
--   ALTER TABLE "review_items" ADD CONSTRAINT "review_items_reviewer_id_fkey"
--     FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL;
--   ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_id_fkey"
--     FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL;
-- END ROLLBACK

-- 1. Drop old reviewer FKs (reviewer_id -> users).
--    These constraints were created by migration 20260713000000. A plain DROP
--    CONSTRAINT fails loudly if they are missing (indicates drift).
ALTER TABLE "review_items" DROP CONSTRAINT "review_items_reviewer_id_fkey";
ALTER TABLE "review_decisions" DROP CONSTRAINT "review_decisions_reviewer_id_fkey";

-- 2. Add User email fields (per AUTH_ACCOUNT_CONTRACT.md §2.7)
ALTER TABLE "users" ADD COLUMN "email" TEXT;
ALTER TABLE "users" ADD COLUMN "normalized_email" TEXT;
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "email_verify_token_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "email_verify_expires_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "password_reset_token_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "password_reset_expires_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;

-- 3. Unique constraints on email and normalizedEmail
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_normalized_email_key" ON "users"("normalized_email");

-- 4. Create AdminAccount table (per AUTH_ACCOUNT_CONTRACT.md §3.6)
CREATE TABLE "admin_accounts" (
    "id" BIGSERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "normalized_username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "session_version" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMP(3),
    "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admin_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "admin_accounts_username_key" ON "admin_accounts"("username");
CREATE UNIQUE INDEX "admin_accounts_normalized_username_key" ON "admin_accounts"("normalized_username");

-- 5. Create AdminAuditLog table (per AUTH_ACCOUNT_CONTRACT.md §3.6)
CREATE TABLE "admin_audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_admin_id" BIGINT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "request_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_audit_logs_actor_admin_id_created_at_idx"
    ON "admin_audit_logs" ("actor_admin_id", "created_at");

-- AdminAuditLog FK to AdminAccount
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_admin_id_fkey"
    FOREIGN KEY ("actor_admin_id") REFERENCES "admin_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Preserve original reviewer_id values before NULLing (task #15).
--    admin_accounts is a new empty table, so no User id can be auto-mapped to an
--    AdminAccount. The original reviewer_id (a User id) is copied into this audit
--    table so the source of every review decision is recoverable. This is NOT
--    silent data deletion: ReviewItem and ReviewDecision rows are preserved, and
--    the original reviewer reference is retained here.
CREATE TABLE "_reviewer_fk_migration_audit" (
    "id" BIGSERIAL NOT NULL,
    "source_table" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "original_reviewer_id" BIGINT NOT NULL,
    "migration_name" TEXT NOT NULL DEFAULT '20260714000000_account_schema',
    "nullified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "_reviewer_fk_migration_audit_pkey" PRIMARY KEY ("id")
);

INSERT INTO "_reviewer_fk_migration_audit" ("source_table", "record_id", "original_reviewer_id")
SELECT 'review_items', "id"::text, "reviewer_id"
FROM "review_items"
WHERE "reviewer_id" IS NOT NULL;

INSERT INTO "_reviewer_fk_migration_audit" ("source_table", "record_id", "original_reviewer_id")
SELECT 'review_decisions', "id"::text, "reviewer_id"
FROM "review_decisions"
WHERE "reviewer_id" IS NOT NULL;

-- 7. Nullify existing reviewer_id values before adding new FK.
--    Existing reviewer_id values reference User IDs. admin_accounts is new and
--    empty. We NULL them out to allow the new FK constraint. The original values
--    were preserved in step 6 above. Per contract task #12: AdminAccount init
--    must NOT auto-convert from User. A migration pending report is generated by
--    scripts/migration/dry-run-classify.ts.
UPDATE "review_items" SET "reviewer_id" = NULL WHERE "reviewer_id" IS NOT NULL;
UPDATE "review_decisions" SET "reviewer_id" = NULL WHERE "reviewer_id" IS NOT NULL;

-- 8. Add new reviewer FKs (reviewer_id -> admin_accounts)
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "admin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "admin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
