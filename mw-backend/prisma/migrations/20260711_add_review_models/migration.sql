-- CreateTable: review_items
CREATE TABLE "review_items" (
    "id" BIGSERIAL NOT NULL,
    "public_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'general',
    "source" TEXT,
    "source_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 1,
    "confidence" DECIMAL(4,3),
    "figure_id" BIGINT,
    "figure_slug" TEXT,
    "risk_type" TEXT,
    "risk_reason" TEXT,
    "suggested_action" TEXT,
    "evidence_fingerprint" TEXT,
    "reviewer" TEXT,
    "decision_reason" TEXT,
    "decision_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "original_redis_key" TEXT,
    "redis_format_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable: review_events
CREATE TABLE "review_events" (
    "id" BIGSERIAL NOT NULL,
    "review_item_id" BIGINT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor" TEXT,
    "reason" TEXT,
    "request_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_events_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "review_items_public_id_key" ON "review_items"("public_id");
CREATE UNIQUE INDEX "review_items_original_redis_key_key" ON "review_items"("original_redis_key");

-- Indexes for review_items
CREATE INDEX "review_items_status_created_at_idx" ON "review_items"("status", "created_at");
CREATE INDEX "review_items_figure_id_idx" ON "review_items"("figure_id");
CREATE INDEX "review_items_risk_type_idx" ON "review_items"("risk_type");
CREATE INDEX "review_items_evidence_fingerprint_idx" ON "review_items"("evidence_fingerprint");

-- Indexes for review_events
CREATE INDEX "review_events_review_item_id_created_at_idx" ON "review_events"("review_item_id", "created_at");
CREATE INDEX "review_events_request_id_idx" ON "review_events"("request_id");

-- Foreign keys
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_review_item_id_fkey"
    FOREIGN KEY ("review_item_id") REFERENCES "review_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: review_apply_attempts
CREATE TABLE "review_apply_attempts" (
    "id" BIGSERIAL NOT NULL,
    "public_id" TEXT NOT NULL,
    "review_item_id" BIGINT NOT NULL,
    "idempotency_key" TEXT,
    "actor_user_id" BIGINT,
    "actor_display_name_snapshot" TEXT,
    "actor_role_snapshot" TEXT,
    "request_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "current_step" TEXT,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "target_figure_id" BIGINT,
    "target_revision_id" BIGINT,
    "error_code" TEXT,
    "error_message_safe" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_apply_attempts_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "review_apply_attempts_public_id_key" ON "review_apply_attempts"("public_id");
CREATE UNIQUE INDEX "review_apply_attempts_idempotency_key_key" ON "review_apply_attempts"("idempotency_key");
CREATE UNIQUE INDEX "review_apply_attempts_review_item_id_attempt_number_key" ON "review_apply_attempts"("review_item_id", "attempt_number");

-- Indexes
CREATE INDEX "review_apply_attempts_status_created_at_idx" ON "review_apply_attempts"("status", "created_at");
CREATE INDEX "review_apply_attempts_target_figure_id_idx" ON "review_apply_attempts"("target_figure_id");

-- Foreign key
ALTER TABLE "review_apply_attempts" ADD CONSTRAINT "review_apply_attempts_review_item_id_fkey"
    FOREIGN KEY ("review_item_id") REFERENCES "review_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
