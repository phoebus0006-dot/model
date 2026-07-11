# Review Schema Change Proposal

## 1. Current Problem

**Review data is exclusively stored in Redis. PostgreSQL has zero review entities.**

| Risk | Impact |
|------|--------|
| Redis data loss | All review items, decisions, audit history lost irrecoverably |
| No ACID transactions | Apply route makes DB writes and Redis writes separately — no atomicity |
| No concurrency control | Blind `SET` overwrites between concurrent admins |
| No audit log | Audit trail embedded in `item.notes` JSON — not queryable, lost on Redis failure |
| No referential integrity | Figure IDs in review items are strings — no FK constraints |
| No data retention | No TTL, no archiving, no cleanup — unbounded growth |
| No rebuildability | Human decisions cannot be reconstructed from other sources |

## 2. Recommended Model — Two-Table Minimal (方案 A)

### ReviewItem 表

```prisma
model ReviewItem {
  id                  BigInt    @id @default(autoincrement())
  publicId            String    @unique @map("public_id")        // Matches current Redis ID
  type                String    @default("general")              // reviewTypeSchema
  title               String
  source              String?                                   // mfc, localized-description-sync, etc.
  sourceId            String?                                   // External ID
  status              String    @default("pending")              // reviewStatusSchema
  priority            Int       @default(1)
  confidence          Decimal?  @db.Decimal(4, 3)
  figureId            BigInt?   @map("figure_id")                // FK to figures (nullable)
  figureSlug          String?   @map("figure_slug")
  riskType            String?   @map("risk_type")                // reviewRiskTypeSchema
  riskReason          String?   @map("risk_reason")
  suggestedAction     String?   @map("suggested_action")         // reviewActionSchema
  evidenceFingerprint String?   @unique @map("evidence_fingerprint")
  reviewer            String?
  decisionReason      String?   @map("decision_reason")
  decisionAt          DateTime? @map("decision_at")
  appliedAt           DateTime? @map("applied_at")
  payload             Json?                                     // Flexible: candidateImage, detailSnapshot, automation, etc.
  notes               String?                                   // Audit trail text
  version             Int       @default(0)                      // Optimistic lock
  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")

  events ReviewEvent[]

  @@index([status, type])
  @@index([figureId])
  @@index([riskType])
  @@index([evidenceFingerprint])
  @@map("review_items")
}
```

### ReviewEvent 表

```prisma
model ReviewEvent {
  id           BigInt    @id @default(autoincrement())
  reviewItemId BigInt    @map("review_item_id")
  event        String                                           // "action", "recheck", "apply", "create", "update"
  action       String?                                          // approve_image, keep_pending, etc.
  fromStatus   String?   @map("from_status")
  toStatus     String    @map("to_status")
  actor        String?
  reason       String?
  metadata     Json?
  requestId    String?   @map("request_id")                     // Idempotency key
  createdAt    DateTime  @default(now()) @map("created_at")

  reviewItem ReviewItem @relation(fields: [reviewItemId], references: [id], onDelete: Cascade)

  @@index([reviewItemId, createdAt])
  @@index([requestId])
  @@map("review_events")
}
```

### Rationale for Two-Table Design

| Concern | How Addressed |
|---------|---------------|
| Audit trail | `ReviewEvent` table captures every state transition |
| Concurrency | `ReviewItem.version` for optimistic locking |
| Idempotency | `ReviewEvent.requestId` unique index prevents duplicate events |
| Payload flexibility | `ReviewItem.payload` JSON field for candidate images, detail snapshots, etc. |
| Figure FK | `figureId` BigInt references `figures.id` (nullable) |
| Evidence dedup | `evidenceFingerprint` unique constraint (or non-unique if re-review allowed) |
| Query performance | Indexes on status+type, figureId, riskType |
| No forced outbox | Outbox can be added later via `ReviewOutbox` model if needed |

## 3. Comparison: 2-Table vs 4-Table (方案 B)

| Dimension | 方案 A (ReviewItem + ReviewEvent) | 方案 B (+ ReviewDecision + ReviewOutbox) |
|-----------|-----------------------------------|----------------------------------------|
| Tables | 2 | 4 |
| Audit | ✅ Full via ReviewEvent | ✅ Full + dedicated decision table |
| Concurrency | ✅ Optimistic lock on version | ✅ Same |
| Outbox | ❌ Not included (can add later) | ✅ Built-in |
| Implementation cost | ~3 days | ~5 days |
| Query complexity | Low | Medium |
| Backfill complexity | Low | Medium |
| Rollback difficulty | Low | Medium |
| **Recommendation** | **✅ Recommended** | Consider in Phase 4 if outbox needed |

## 4. Redis → PostgreSQL Field Mapping

| Redis JSON field | Prisma Model Field | Notes |
|-----------------|-------------------|-------|
| `item.id` | `ReviewItem.publicId` | Unique, used in API paths |
| `item.type` | `ReviewItem.type` | Enum stored as string |
| `item.title` | `ReviewItem.title` | Required |
| `item.source` | `ReviewItem.source` | Optional |
| `item.sourceId` | `ReviewItem.sourceId` | Optional |
| `item.status` | `ReviewItem.status` | P0: maintain existing values |
| `item.priority` | `ReviewItem.priority` | Default 1 |
| `item.confidence` | `ReviewItem.confidence` | Decimal |
| `item.figureId` | `ReviewItem.figureId` | BigInt, FK to figures |
| `item.figureSlug` | `ReviewItem.figureSlug` | String lookup |
| `item.riskType` | `ReviewItem.riskType` | String |
| `item.riskReason` | `ReviewItem.riskReason` | Free text |
| `item.candidateImage` | `ReviewItem.payload` JSON | Part of payload |
| `item.currentPublicImage` | `ReviewItem.payload` JSON | Part of payload |
| `item.detailSnapshot` | `ReviewItem.payload` JSON | Part of payload |
| `item.suggestedAction` | `ReviewItem.suggestedAction` | String |
| `item.payload` | `ReviewItem.payload` JSON | Contains figureData, etc. |
| `item.notes` | `ReviewItem.notes` | Audit trail text |
| `item.automation` | `ReviewItem.payload` JSON | Part of payload |
| `item.evidenceFingerprint` | `ReviewItem.evidenceFingerprint` | Unique (or not) |
| `item.decisionReason` | `ReviewItem.decisionReason` | Nullable |
| `item.reviewer` | `ReviewItem.reviewer` | Display name string |
| `item.decisionAt` | `ReviewItem.decisionAt` | Datetime |
| `item.createdAt` | `ReviewItem.createdAt` | Datetime |
| `item.updatedAt` | `ReviewItem.updatedAt` | Datetime |
| `item.currentStateEvidence` | (Not migrated) | Volatile DB snapshot, recomputed on read |
| `review:decision:*` action | `ReviewEvent.event` = "suppression" | Stored as event |

## 5. Compatibility

| Area | Impact |
|------|--------|
| Existing API (11 review routes) | None — current routes unchanged |
| `guanli_index.php` | None — API responses unchanged |
| Redis key format | Maintained during Stage 0-3 |
| Crawler/NAS Agent | None — uses POST /review/items via API |
| Prisma Client | New models added, existing models untouched |
| Deployment | Add tables first (Stage 0), then roll out incrementally |

## 6. Data Retention

- ReviewItems: retain indefinitely (subject to manual archive)
- ReviewEvents: retain indefinitely
- Redis review keys: deleted only in Stage 6 (final cleanup, separate approval)
- Payload JSON may contain image URLs, rewrite drafts — consider future redaction policy

## 7. Risks

| Risk | Mitigation |
|------|------------|
| Backfill duplicates | Use `publicId` unique constraint; upsert with ON CONFLICT |
| Field format drift | Validate all Redis JSON against schema before insert |
| Redis continues to change during migration | Stage 1 snapshot or multi-pass with cursor |
| Dual-write partial failure | Priority: PG first, then Redis. Redis failure logs but doesn't fail request (degraded) |
| Rollback leaves PG orphan data | Stage 0 is additive only; rollback = remove tables (data preserved for re-migration) |
| Old service still writes Redis | Dual-write stage keeps Redis as compatible mirror |
