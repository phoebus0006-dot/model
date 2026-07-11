# Review Apply Attempt Design

## Motivation

The `apply` endpoint (`POST /review/items/:id/apply`) performs a multi-step saga with side effects across:
- PostgreSQL (Figure CRUD, relations, images, revisions)
- HTTP (image download via `processAndStoreImage`)
- Filesystem (processed image storage via `storeProcessedReviewImage`)
- Redis (review item state update, decision save, cache purge)

These steps are not atomic. A failure midway leaves partial state. There is no reliable way to resume or rollback.

## ReviewApplyAttempt Table

```prisma
model ReviewApplyAttempt {
  id                       BigInt    @id @default(autoincrement())
  publicId                 String    @unique @map("public_id")
  reviewItemId             BigInt    @map("review_item_id")
  idempotencyKey           String?   @unique @map("idempotency_key")
  actorUserId              BigInt?   @map("actor_user_id")
  actorDisplayNameSnapshot String?   @map("actor_display_name_snapshot")
  actorRoleSnapshot        String?   @map("actor_role_snapshot")
  requestId                String?   @map("request_id")
  status                   String    @default("PENDING")
  currentStep              String?   @map("current_step")
  attemptNumber            Int       @default(1) @map("attempt_number")
  targetFigureId           BigInt?   @map("target_figure_id")
  targetRevisionId         BigInt?   @map("target_revision_id")
  errorCode                String?   @map("error_code")
  errorMessageSafe         String?   @map("error_message_safe")
  retryable                Boolean   @default(true)
  metadata                 Json?
  startedAt                DateTime? @map("started_at")
  completedAt              DateTime? @map("completed_at")
  failedAt                 DateTime? @map("failed_at")
  createdAt                DateTime  @default(now()) @map("created_at")
  updatedAt                DateTime  @updatedAt @map("updated_at")

  reviewItem ReviewItem @relation(fields: [reviewItemId], references: [id], onDelete: Cascade)

  @@unique([reviewItemId, attemptNumber])
  @@index([status, createdAt])
  @@index([targetFigureId])
  @@map("review_apply_attempts")
}
```

## Status Design

| Status | Meaning | Enter | Next Allowed |
|--------|---------|-------|-------------|
| PENDING | Created, not yet started | New attempt record | RUNNING |
| RUNNING | Apply in progress | Worker picks up attempt | SUCCEEDED, FAILED |
| SUCCEEDED | All steps completed successfully | All side effects done | (terminal) |
| FAILED | Non-retryable failure | Fatal error | (terminal) |

## Idempotency Strategy

- `idempotencyKey` UNIQUE constraint prevents duplicate apply requests
- Same key → return existing `ReviewApplyAttempt` (either SUCCEEDED or FAILED)
- Different key → new attempt with same `reviewItemId` but incremented `attemptNumber`
- Historical failures are preserved (not overwritten)

## Relationship with ReviewEvent

- **ReviewEvent**: immutable domain event log (e.g., "apply started", "apply succeeded", "apply failed")
- **ReviewApplyAttempt**: mutable execution record of one apply instance
- On apply start: create ReviewEvent("apply_started") + ReviewApplyAttempt(PENDING)
- On apply success: ReviewEvent("apply_succeeded") + ReviewApplyAttempt(SUCCEEDED) + review item status update
- On apply failure: ReviewEvent("apply_failed") + ReviewApplyAttempt(FAILED) + review item status unchanged

## Outbox Decision

```
OUTBOX_DEFERRED_WITH_EVIDENCE
```

**Rationale**: The apply saga's main database writes (figure, image, revision) are already within Prisma transaction scope. External side effects (HTTP downloads, filesystem writes) are:
- Idempotent by nature (download same URL → same result; sha256 prevents duplicate files)
- Can be retried on failure
- Do not cause data inconsistency if they fail (cached image is cosmetic, not structural)
- Cache purge is always safe to retry

ReviewApplyAttempt provides enough tracking to resume or diagnose failed applies. A full outbox table will be added if external workflows (NAS triggers, webhooks) become part of the review apply pipeline.
