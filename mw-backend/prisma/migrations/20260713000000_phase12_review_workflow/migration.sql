-- Phase 1+2 Review Workflow migration
-- Source of truth: docs/implementation/PHASE12_CONTRACT.md (frozen at e4c9fe3)
-- PostgreSQL becomes the source of truth for ReviewItem / ReviewDecision / CrawlerJob.
-- Redis remains only as cache / queue index / lock.
--
-- This migration is IDEMPOTENT (CREATE TABLE IF NOT EXISTS) so it is safe to run
-- on databases that already have partial legacy tables. It does NOT delete any
-- existing Redis data; Redis→PG backfill is a separate dry-run script.

-- CrawlerJob (created first; ReviewItem references it)
CREATE TABLE IF NOT EXISTS "crawler_jobs" (
    "id"                   TEXT PRIMARY KEY,
    "source"               TEXT NOT NULL,
    "task"                 TEXT NOT NULL,
    "runner"               TEXT NOT NULL DEFAULT 'server_safe',
    "status"               TEXT NOT NULL DEFAULT 'created',
    "priority"             INTEGER NOT NULL DEFAULT 1,
    "payload"              JSONB,
    "result"               JSONB,
    "result_summary"       JSONB,
    "error"                TEXT,
    "attempts"             INTEGER NOT NULL DEFAULT 0,
    "max_attempts"         INTEGER NOT NULL DEFAULT 3,
    "not_before"           TIMESTAMP(3),
    "worker_id"            TEXT,
    "linked_review_item_id" TEXT,
    "notes"                TEXT,
    "automation"           JSONB,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at"           TIMESTAMP(3),
    "running_at"           TIMESTAMP(3),
    "completed_at"         TIMESTAMP(3),
    "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "crawler_jobs_status_priority_created_at_idx"
    ON "crawler_jobs" ("status", "priority", "created_at");
CREATE INDEX IF NOT EXISTS "crawler_jobs_source_task_idx"
    ON "crawler_jobs" ("source", "task");

-- ReviewItem
CREATE TABLE IF NOT EXISTS "review_items" (
    "id"                     TEXT PRIMARY KEY,
    "type"                   TEXT NOT NULL,
    "risk_type"              TEXT,
    "status"                 TEXT NOT NULL DEFAULT 'pending',
    "title"                  TEXT NOT NULL,
    "source"                 TEXT,
    "source_id"              TEXT,
    "figure_id"              BIGINT,
    "figure_slug"            TEXT,
    "priority"               INTEGER NOT NULL DEFAULT 1,
    "confidence"             DOUBLE PRECISION,
    "risk_reason"            VARCHAR(1000),
    "candidate_image"        JSONB,
    "current_public_image"   JSONB,
    "original_evidence"      JSONB,
    "current_state_snapshot" JSONB,
    "detail_snapshot"        JSONB,
    "suggested_action"       TEXT,
    "payload"                JSONB,
    "notes"                  TEXT,
    "evidence_fingerprint"   TEXT NOT NULL,
    "force_reopen"           BOOLEAN NOT NULL DEFAULT false,
    "crawler_job_id"         TEXT,
    "automation"             JSONB,
    "reviewer_id"            BIGINT,
    "decision_reason"        VARCHAR(2000),
    "decision_at"            TIMESTAMP(3),
    "last_action"            TEXT,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_items_figure_id_fkey" FOREIGN KEY ("figure_id") REFERENCES "figures"("id") ON DELETE SET NULL,
    CONSTRAINT "review_items_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "review_items_crawler_job_id_fkey" FOREIGN KEY ("crawler_job_id") REFERENCES "crawler_jobs"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "review_items_status_created_at_idx"
    ON "review_items" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "review_items_figure_id_risk_type_status_idx"
    ON "review_items" ("figure_id", "risk_type", "status");
CREATE INDEX IF NOT EXISTS "review_items_evidence_fingerprint_idx"
    ON "review_items" ("evidence_fingerprint");

-- ReviewDecision (append-only audit log)
CREATE TABLE IF NOT EXISTS "review_decisions" (
    "id"                   BIGSERIAL PRIMARY KEY,
    "review_item_id"       TEXT NOT NULL,
    "action"               TEXT NOT NULL,
    "status_before"        TEXT NOT NULL,
    "status_after"         TEXT NOT NULL,
    "reviewer_id"          BIGINT,
    "reviewer_role"        TEXT NOT NULL,
    "decision_reason"      VARCHAR(2000),
    "crawler_job_id"       TEXT,
    "candidate_image_hash" TEXT,
    "evidence_fingerprint" TEXT NOT NULL,
    "metadata"             JSONB,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_decisions_review_item_id_fkey" FOREIGN KEY ("review_item_id") REFERENCES "review_items"("id") ON DELETE CASCADE,
    CONSTRAINT "review_decisions_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "review_decisions_crawler_job_id_fkey" FOREIGN KEY ("crawler_job_id") REFERENCES "crawler_jobs"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "review_decisions_review_item_id_created_at_idx"
    ON "review_decisions" ("review_item_id", "created_at");
CREATE INDEX IF NOT EXISTS "review_decisions_evidence_fingerprint_idx"
    ON "review_decisions" ("evidence_fingerprint");
