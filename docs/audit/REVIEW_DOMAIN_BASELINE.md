# Review Domain Baseline

Generated: 2026-07-11

## Storage Architecture

All review data lives in Redis. There is **zero** PostgreSQL persistence for review items, decisions, or audit logs.

| Redis Key | Type | Purpose |
|-----------|------|---------|
| `review:item:{id}` | String (JSON) | Review item with full payload |
| `review:items` | Sorted Set (score=timestamp) | Index of all review item IDs |
| `review:decision:{figure}:{riskType}:{fingerprint}` | String (JSON) | Suppression decision record |
| `review:decisions` | Sorted Set (score=timestamp) | Index of all decision keys |
| `review:archive` | Sorted Set | Archived item IDs |

## Review Routes (11 routes, extract target)

| # | Method | Path | Purpose |
|---|--------|------|---------|
| R1 | GET | `/review/items` | List review items, filterable by status/type/riskType/suggestedAction |
| R2 | GET | `/review/decisions` | List suppression decisions |
| R3 | GET | `/review/stats` | Review queue statistics |
| R4 | POST | `/review/items` | Create new review item (with dedup vs decisions + pending) |
| R5 | PUT | `/review/items/:id` | Update review item fields |
| R6 | POST | `/review/items/:id/recheck` | Recheck item against current DB state |
| R7 | POST | `/review/items/:id/action` | Take decision action (approve/reject/keep_pending/etc) |
| R8 | POST | `/review/items/bulk/cleanup` | Bulk mark old resolved rewrites as stale |
| R9 | POST | `/review/items/:id/apply` | Apply review decision to production data |
| R10 | GET | `/review/image-proxy` | SSRF-protected image proxy for review |
| R11 | POST | `/review/cache-candidate` | Upload candidate image to review cache |

## Non-review Routes (stay in admin.ts, 14 routes)

| # | Method | Path | Purpose |
|---|--------|------|---------|
| A1 | POST | `/aigc/generate` | Queue AIGC generation |
| A2 | GET | `/aigc/status/:figureId` | Check AIGC generation status |
| A3 | POST | `/cache/purge` | Purge cache by pattern (**already extracted**) |
| A4 | GET | `/crawler/jobs` | List crawler jobs |
| A5 | POST | `/crawler/jobs` | Create crawler job |
| A6 | POST | `/crawler/jobs/claim` | Claim available crawler jobs |
| A7 | GET | `/crawler/jobs/:id` | Get single crawler job |
| A8 | PUT | `/crawler/jobs/:id` | Update crawler job |
| A9 | GET | `/stats` | Admin statistics dashboard |
| A10 | GET | `/users` | List users |
| A11 | PUT | `/users/:id` | Update user |
| A12 | PUT | `/users/:id/password` | Reset user password |
| A13 | POST | `/users` | Create user |
| A14 | DELETE | `/users/:id` | Delete user |
| A15 | GET | `/import/status` | Legacy import status |
| A16 | POST | `/figures/batch` | Legacy batch figure import |

## Current Review State Machine (inferred from code)

### Statuses (from admin.ts` reviewStatusSchema `)

```
pending → approved / rejected / needs_changes / resolved / stale
```

| Current Status | Action | Target Status | Allowed | Duplicate Allowed | Audit Produced | External Side Effects |
|---------------|--------|---------------|---------|-------------------|----------------|----------------------|
| any | approve_image | approved | ✅ | ✅ (idempotent update) | ✅ (decision saved) | Figure cache purge (SCAN) |
| any | reject_image | rejected | ✅ | ✅ (idempotent) | ✅ | None |
| any | keep_placeholder | resolved | ✅ | ✅ | ✅ | Figure cache purge (SCAN) |
| any | mark_detail_ok | resolved | ✅ | ✅ | ✅ | None |
| any | request_refetch | needs_changes | ✅ | ✅ (reuses existing crawler job) | ❌ | Creates crawler job |
| any | dismiss_stale | resolved | ✅ | ✅ | ✅ | None |
| any | keep_pending | pending | ✅ | ✅ (no-op) | ❌ | None |
| * | recheck | resolved/needs_changes/pending | ✅ | ✅ | ❌ | None |

### Repeated Operations

- **approve again**: Allowed. Item stays approved; decision updated with new timestamp.
- **reject after approve**: Allowed via action endpoint. Status changes from `approved` → `rejected`.
- **approve after reject**: Allowed.
- **keep_pending on pending**: Allowed (no-op, just adds note).
- **recheck after decision**: Allowed. Re-evaluates against DB state, may change status.

### Dedup Logic

1. On `POST /review/items`: checks existing `review:decision:*` key → if found, returns `suppressed` status
2. Then checks `findExistingPendingReview` (scans all `review:items` sorted set + individual GETs + fingerprint comparison) → if found, returns `duplicate`

## Transaction Boundaries

### Apply (POST /review/items/:id/apply)

The apply operation is complex with multiple writes spread across Redis + PostgreSQL:

```
Flow:
1. Read item from Redis
2. Prisma query: resolve figure
3. Prisma write: update/create figure (figure_import) OR
   Prisma create: revision + update figure (rewrite) OR
   Prisma write: image records, delete images (image, image_review) OR
   Prisma update: figure janCode (jan_match)
4. Redis write: save updated review item
5. Redis write: save review decision (if applicable)
6. Redis SCAN: purge figure caches
```

**Problem**: Steps 3-6 are not in a single transaction. If step 5 or 6 fails:
- PostgreSQL writes from step 3 are already committed (cannot rollback)
- Redis state becomes inconsistent with database state
- Review item status does not reflect actual production state

### Action (POST /review/items/:id/action)

```
1. Read item from Redis
2. Compute new status
3. Redis write: save updated item
4. Redis write: save decision (if suppressing action)
5. Potential Redis write: create crawler job (if request_refetch)
6. SCAN: purge figure caches (if image action)
```

## Concurrency Safety

**No concurrency protection exists.** Every write is a blind `SET` with no conditional check:

```ts
// Current pattern — vulnerable to lost updates:
const existingRaw = await app.redis.get(`review:item:${id}`);
const item = JSON.parse(existingRaw);
item.status = newStatus;
await app.redis.set(`review:item:${id}`, JSON.stringify(item));
```

Two admins acting simultaneously can:
1. Both read the same item with `pending` status
2. Both apply their own status change
3. Last write wins — one admin's decision is silently lost

## Audit Trail

Audit trail is maintained **within the item JSON blob** via `notes` field:
```
[2026-07-11T12:00:00Z] [Admin] 管理员批准候选图（Looks good）
```

There is **no** separate audit log table. If Redis is lost, audit history is lost.

## Power/Idempotency

- `approve_image`, `reject_image`: NOT database-idempotent for image records (creates duplicate `FigureImage` row unless check catches existing source)
- `request_refetch`: Has crawlerJobId dedup check in payload
- `keep_pending`: Truly idempotent (just note + status = pending)
- `recheck`: Idempotent (read-only evaluation, then save result)
- `bulk/cleanup`: Dry-run mode exists; idempotent for already-stale items

## External Dependencies

- `resolveReviewFigure` — Prisma query to figure table
- `normalizeReviewItemForFingerprint` — Prisma query to figure + figureImage + manufacturer + series + categories
- `evaluateReviewItem` — Prisma queries to figureImage, revision, figure
- `apply` — Prisma writes to figure, revision, figureImage, FigureCategory, FigureSculptor, FigureCharacter, FigureLocalized, FigureRelease
- `storeProcessedReviewImage` — Filesystem writes
- `processAndStoreImage` — HTTP downloads + image processing (sharp)
- `image-proxy` — HTTP downloads

## Current Test Coverage

| Suite | Tests | Covers |
|-------|-------|--------|
| admin-contract.test.ts | 8 | Auth (401) + cache purge (no review logic) |
| review-cache.test.ts | 3 | Review cache image signing (mentioned but not seen) |
| review-contract.test.ts | 10 | Review items API contract |
| **Review domain specific** | **0** | No tests for state machine, apply, action, bulk |

## Extraction Plan

### To Extract
- Schemas: `reviewItemSchema`, `reviewUpdateSchema`, `reviewQuerySchema`, `reviewDecisionQuerySchema`, `reviewActionSchema`, `reviewStatusSchema`, etc.
- Helpers: all `review*` functions, `computeReviewEvidenceFingerprint`, `normalizeReviewItemForFingerprint`, `evaluateReviewItem`, `findExistingPendingReview`, `saveReviewDecision`, etc.
- Routes: R1-R11 above

### To Leave in admin.ts
- A1-A16 (non-review routes)
- Imports for images.ts (processAndStoreImage, etc., used by apply)
- App registration for adminCacheRoutes
- Cache purge is already extracted (`adminCacheRoutes`)

### Dependencies
The apply endpoint needs `processAndStoreImage`, `upsertFigureImageRecord` from images.ts, and `storeProcessedReviewImage` which could remain in admin.ts or move. The review module should not own image processing logic.
