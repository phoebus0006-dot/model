-- Account schema migration: restore User email fields, create AdminAccount/AdminAuditLog,
-- and migrate reviewerId FK from users to admin_accounts.
--
-- Source of truth: docs/implementation/AUTH_ACCOUNT_CONTRACT.md (FROZEN)
-- Wave 1 contract: docs/implementation/WAVE1_AGENT_CONTRACTS.md
--
-- ROLLBACK (downgrade) — run these statements manually to revert:
--   ALTER TABLE "review_decisions" DROP CONSTRAINT IF EXISTS "review_decisions_reviewer_id_fkey";
--   ALTER TABLE "review_items" DROP CONSTRAINT IF EXISTS "review_items_reviewer_id_fkey";
--   ALTER TABLE "admin_audit_logs" DROP CONSTRAINT IF EXISTS "admin_audit_logs_actor_admin_id_fkey";
--   DROP TABLE IF EXISTS "admin_audit_logs";
--   DROP TABLE IF EXISTS "admin_accounts";
--   DROP INDEX IF EXISTS "users_normalized_email_key";
--   DROP INDEX IF EXISTS "users_email_key";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "session_version";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "password_reset_expires_at";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "password_reset_token_hash";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "normalized_email";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verify_token_hash";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verify_expires_at";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verified_at";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "email";
--   ALTER TABLE "review_items" ADD CONSTRAINT "review_items_reviewer_id_fkey"
--     FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL;
--   ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_id_fkey"
--     FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL;
-- END ROLLBACK

-- 1. Drop old reviewer FKs (reviewer_id -> users)
ALTER TABLE "review_items" DROP CONSTRAINT IF EXISTS "review_items_reviewer_id_fkey";
ALTER TABLE "review_decisions" DROP CONSTRAINT IF EXISTS "review_decisions_reviewer_id_fkey";

-- 2. Add User email fields (per AUTH_ACCOUNT_CONTRACT.md §2.7)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "normalized_email" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verify_token_hash" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verify_expires_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_token_hash" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_expires_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" INTEGER NOT NULL DEFAULT 0;

-- 3. Unique constraints on email and normalizedEmail
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "users_normalized_email_key" ON "users"("normalized_email");

-- 4. Create AdminAccount table (per AUTH_ACCOUNT_CONTRACT.md §3.6)
CREATE TABLE IF NOT EXISTS "admin_accounts" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "admin_accounts_username_key" ON "admin_accounts"("username");
CREATE UNIQUE INDEX IF NOT EXISTS "admin_accounts_normalized_username_key" ON "admin_accounts"("normalized_username");

-- 5. Create AdminAuditLog table (per AUTH_ACCOUNT_CONTRACT.md §3.6)
CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
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
CREATE INDEX IF NOT EXISTS "admin_audit_logs_actor_admin_id_created_at_idx"
    ON "admin_audit_logs" ("actor_admin_id", "created_at");

-- AdminAuditLog FK to AdminAccount
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_audit_logs_actor_admin_id_fkey') THEN
        ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_admin_id_fkey"
            FOREIGN KEY ("actor_admin_id") REFERENCES "admin_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- 6. Nullify existing reviewer_id values before adding new FK
-- Existing reviewer_id values reference User IDs. admin_accounts is new and empty.
-- We NULL them out to allow the new FK constraint. This is NOT silent data deletion:
--   - ReviewItem and ReviewDecision records are preserved
--   - ReviewDecision retains reviewerRole, evidenceFingerprint for audit
--   - Per contract task #12: AdminAccount init must NOT auto-convert from User
-- A migration pending report is generated by scripts/migration/dry-run-classify.ts
UPDATE "review_items" SET "reviewer_id" = NULL WHERE "reviewer_id" IS NOT NULL;
UPDATE "review_decisions" SET "reviewer_id" = NULL WHERE "reviewer_id" IS NOT NULL;

-- 7. Add new reviewer FKs (reviewer_id -> admin_accounts)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_items_reviewer_id_fkey') THEN
        ALTER TABLE "review_items" ADD CONSTRAINT "review_items_reviewer_id_fkey"
            FOREIGN KEY ("reviewer_id") REFERENCES "admin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_decisions_reviewer_id_fkey') THEN
        ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_id_fkey"
            FOREIGN KEY ("reviewer_id") REFERENCES "admin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
