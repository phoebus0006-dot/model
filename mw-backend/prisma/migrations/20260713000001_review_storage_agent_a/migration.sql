-- Review storage agent-a migration: CrawlerJobEvent + canonical fingerprint support.
-- Source of truth: docs/implementation/PHASE12_CONTRACT.md
--
-- This migration is IDEMPOTENT (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- and is safe to run on databases that already have the Phase 1+2 tables from
-- migration 20260713000000. It does NOT delete or rename any existing columns;
-- status_before / status_after columns are retained and reused via Prisma @map.
--
-- Changes:
--   1. CrawlerJobEvent table (append-only state transition history)
--   2. review_items.candidate_asset column (canonical candidate asset JSON)
--   3. review_decisions.request_id column (idempotency key for API requests)
--   4. Indexes for fingerprint-based lookups and CrawlerJobEvent queries
--   5. Partial unique index on review_items (active items only) — best-effort:
--      skipped if duplicate active rows already exist so the migration never
--      fails on data issues; the application-layer suppression enforces the
--      same invariant.
--
-- ROLLBACK (downgrade) — run these statements manually to revert:
--   DROP INDEX IF EXISTS "review_items_active_fingerprint_idx";
--   DROP INDEX IF EXISTS "review_items_fig_risk_fp_idx";
--   DROP INDEX IF EXISTS "review_decisions_request_id_idx";
--   DROP INDEX IF EXISTS "crawler_job_events_crawler_job_id_created_at_idx";
--   DROP INDEX IF EXISTS "crawler_job_events_crawler_job_id_timestamp_idx";
--   ALTER TABLE "review_decisions" DROP COLUMN IF EXISTS "request_id";
--   ALTER TABLE "review_items" DROP COLUMN IF EXISTS "candidate_asset";
--   DROP TABLE IF EXISTS "crawler_job_events";
-- END ROLLBACK

-- ─── 1. CrawlerJobEvent (append-only state transition history) ──────────────
CREATE TABLE IF NOT EXISTS "crawler_job_events" (
    "id"              BIGSERIAL PRIMARY KEY,
    "crawler_job_id"  TEXT NOT NULL,
    "previous_status" TEXT NOT NULL,
    "next_status"     TEXT NOT NULL,
    "agent_id"        TEXT,
    "attempt"         INTEGER NOT NULL DEFAULT 0,
    "timestamp"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result_summary"  JSONB,
    "error"           TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crawler_job_events_crawler_job_id_fkey"
        FOREIGN KEY ("crawler_job_id") REFERENCES "crawler_jobs"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "crawler_job_events_crawler_job_id_created_at_idx"
    ON "crawler_job_events" ("crawler_job_id", "created_at");
CREATE INDEX IF NOT EXISTS "crawler_job_events_crawler_job_id_timestamp_idx"
    ON "crawler_job_events" ("crawler_job_id", "timestamp");

-- ─── 2. review_items.candidate_asset ─────────────────────────────────────────
-- Canonical candidate asset JSON (source, hash, url, cachedUrl, dimensions).
-- Distinct from legacy candidate_image which is kept for backward compat.
ALTER TABLE "review_items" ADD COLUMN IF NOT EXISTS "candidate_asset" JSONB;

-- ─── 3. review_decisions.request_id ──────────────────────────────────────────
-- Idempotency key: allows the same API request to be retried without creating
-- duplicate ReviewDecision rows. NULL for legacy decisions.
ALTER TABLE "review_decisions" ADD COLUMN IF NOT EXISTS "request_id" TEXT;

-- ─── 4. Indexes for fingerprint-based lookups ───────────────────────────────
-- Composite index to query the human decision for a given (figureId, riskType,
-- evidenceFingerprint) triple — used by duplicate suppression (§9) and reopen
-- checks (§10).
CREATE INDEX IF NOT EXISTS "review_items_fig_risk_fp_idx"
    ON "review_items" ("figure_id", "risk_type", "evidence_fingerprint");
CREATE INDEX IF NOT EXISTS "review_decisions_request_id_idx"
    ON "review_decisions" ("request_id");

-- ─── 5. Partial unique index on active (non-archived) review items ───────────
-- Per contract §6: "an active (non-archived) row with the same fingerprint
-- triggers suppression (§9)." This DB-level constraint makes that invariant
-- robust against concurrent inserts. We use a DO block so the migration does
-- NOT fail if duplicate active rows already exist (data cleanup is a separate
-- dry-run concern). The index is created only when safe.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "review_items"
        WHERE "status" != 'archived'
          AND "figure_id" IS NOT NULL
          AND "risk_type" IS NOT NULL
        GROUP BY "figure_id", "risk_type", "evidence_fingerprint"
        HAVING COUNT(*) > 1
    ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS "review_items_active_fingerprint_idx"
            ON "review_items" ("figure_id", "risk_type", "evidence_fingerprint")
            WHERE "status" != 'archived';
    ELSE
        RAISE NOTICE 'Skipping unique index: duplicate active review_items rows exist. Run cleanup first.';
    END IF;
END $$;
