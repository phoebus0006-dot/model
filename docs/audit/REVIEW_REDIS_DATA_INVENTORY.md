# Review Redis Data Inventory

Generated: 2026-07-11 | Source code analysis (no production Redis access)

## Key Patterns

### 1. `review:item:{id}` — String (JSON)

| Attribute | Value |
|-----------|-------|
| Type | Redis String |
| Create | `POST /review/items`, `POST /review/items/:id/action` (update) |
| Read | `GET /review/items`, `GET /review/:id/recheck`, `POST /review/items/:id/action`, `POST /review/items/:id/apply`, `POST /review/items/bulk/cleanup`, `findExistingPendingReview()` |
| Update | `PUT /review/items/:id`, `POST /review/items/:id/action`, `POST /review/items/:id/apply`, `POST /review/items/:id/recheck`, `POST /review/items/bulk/cleanup` |
| Delete | Never deleted by application code |
| TTL | **None** — no `EXPIRE`, never explicitly set |
| Content | Full ReviewItem JSON (see schema below) |
| Key source | `id = ${Date.now()}-${Math.random().toString(36).slice(2, 8)}` (line 1005) |

**JSON Fields in `review:item:{id}`:**

| Field | Type | Always present | Example |
|-------|------|---------------|---------|
| `id` | string | ✅ | `"1783763065585-a1b2c3"` |
| `type` | string | ✅ | `"general"`, `"image_review"`, `"rewrite"`, `"figure_import"` |
| `title` | string | ✅ | `"JAN match needed"` |
| `status` | string | ✅ | `"pending"`, `"approved"`, `"rejected"`, `"needs_changes"`, `"resolved"`, `"stale"` |
| `source` | string | ❌ | `"mfc"`, `"localized-description-sync"` |
| `sourceId` | string | ❌ | `"12345"` |
| `priority` | number | ✅ | `0`-`3` |
| `confidence` | number | ❌ | `0.85` |
| `figureId` | string\|number | ❌ | `"42"` or `42` |
| `figureSlug` | string | ❌ | `"hatsune-miku"` |
| `riskType` | string | ❌ | `"image_low_count"`, `"detail_missing_description"` |
| `riskReason` | string | ❌ | Free text |
| `candidateImage` | object | ❌ | `{ source, imageId, width, height, ... }` |
| `currentPublicImage` | object | ❌ | `{ imageId, source, width, height }` |
| `detailSnapshot` | object | ❌ | `{ description, specCount, specs, categories }` |
| `suggestedAction` | string | ❌ | `"approve_image"` |
| `payload` | object | ❌ | Figure data, review problems, crawlerJobId |
| `notes` | string | ❌ | Audit trail embedded as multiline text |
| `automation` | object | ❌ | `{ provider, workflow, runId }` |
| `evidenceFingerprint` | string | ❌ | sha256 hex (64 chars) |
| `decisionReason` | string\|null | ❌ | Admin's reason |
| `reviewer` | string\|null | ❌ | Admin display name |
| `decisionAt` | string\|null | ❌ | ISO 8601 datetime |
| `currentStateEvidence` | object | ❌ | Current figure DB state snapshot |
| `createdAt` | string | ✅ | ISO 8601 |
| `updatedAt` | string | ✅ | ISO 8601 |

### 2. `review:items` — Sorted Set

| Attribute | Value |
|-----------|-------|
| Type | Redis Sorted Set (ZSET) |
| Score | `Date.now()` (timestamp in ms) |
| Member | Review item ID (e.g., `"1783763065585-a1b2c3"`) |
| Create | `POST /review/items` — ZADD |
| Read | `GET /review/items`, `GET /review/stats`, `findExistingPendingReview()`, bulk cleanup — ZREVRANGE |
| Update | Never updated (only add + read) |
| Delete | Never deleted by application code |
| TTL | **None** |
| Purpose | Index of all review items, ordered by creation time |

### 3. `review:decision:{figureKey}:{riskType}:{fingerprint}` — String (JSON)

| Attribute | Value |
|-----------|-------|
| Type | Redis String |
| Pattern | `review:decision:${redisKeyPart(figureKey)}:${redisKeyPart(riskType)}:${fingerprint}` |
| Create | `saveReviewDecision()` — only for "suppressing" actions (approve_image, reject_image, keep_placeholder, mark_detail_ok, dismiss_stale) |
| Read | `POST /review/items` (dedup check), `GET /review/decisions` |
| Update | Never (overwritten on same key — last decision wins) |
| Delete | Never deleted by application code |
| TTL | **None** |
| Content | `{ reviewItemId, figure, type, riskType, evidenceFingerprint, action, status, reviewer, decisionReason, decisionAt }` |

**Decision key example:** `review:decision:id:42:image_low_count:a1b2c3d4e5f6...`

### 4. `review:decisions` — Sorted Set

| Attribute | Value |
|-----------|-------|
| Type | Redis Sorted Set (ZSET) |
| Score | `Date.now()` |
| Member | Decision key (e.g., `"review:decision:id:42:image_low_count:a1b2..."`) |
| Create | `saveReviewDecision()` — ZADD |
| Read | `GET /review/decisions` — ZREVRANGE |
| Update | Never |
| Delete | Never deleted by application code |
| TTL | **None** |
| Purpose | Index of all suppression decisions |

### 5. `review:archive` — Sorted Set

| Attribute | Value |
|-----------|-------|
| Type | Redis Sorted Set (ZSET) |
| Read | `GET /review/stats` — ZCARD (count only) |
| Write | **No writes found in current code** — ZCARD only |
| TTL | Unknown |

Data is written to `review:archive` only if legacy archive functionality was removed or it's written by external scripts not in this codebase.

## Orphan Keys Risk

- Review items with IDs in the sorted set but whose `review:item:{id}` key was deleted or expired → **No TTL set, so no expiration risk**
- Decisions with keys in `review:decisions` sorted set but whose `review:decision:{...}` key was deleted → **Same, no TTL**
- No collection/cleanup mechanism ever runs on these keys

## Rebuildability

| Data | Rebuildable? | Source |
|------|-------------|--------|
| Review item content | ❌ Not reconstructable | Human decisions, crawler metadata, manual notes |
| Review status/decision | ❌ Not reconstructable | Administrator judgment calls |
| Image candidate data | ❌ Not reconstructable | External URLs, processed image metadata |
| Figure import payload | ⚠️ Partial | Figure source data may be re-fetched by crawler |
| Rewrite drafts | ❌ Not reconstructable | AI-generated content, human edits |
| Audit trail (notes) | ❌ Not reconstructable | Human-written notes |
| Archived items | ❌ Not reconstructable | If `review:archive` is the only copy |

## Cache Safety

The `review:` namespace is **blocked** from cache purge operations:
- `src/modules/admin-cache/routes.ts:17`: `BLOCKED_NAMESPACES = ["review:", "crawler:", "session:", "rate-limit:"]`
- `src/shared/cache/cache-service.ts:25`: `BLOCKED_NAMESPACE_PREFIXES = ["review:", ...]`

This means cache purge endpoints cannot accidentally delete review data. ✅

## Inventory Summary

| Key Pattern | Type | Count Estimate | TTL | Data Loss Risk | Notes |
|-------------|------|---------------|-----|---------------|-------|
| `review:item:{id}` | String | Unbounded | None | CRITICAL | Main review data |
| `review:items` | ZSET | Same as items | None | CRITICAL | Index of all items |
| `review:decision:{...}:{...}:{...}` | String | Unbounded | None | HIGH | Suppression decisions |
| `review:decisions` | ZSET | Same as decisions | None | HIGH | Index of decisions |
| `review:archive` | ZSET | Unknown | None | MEDIUM | Read-only in current code |

**Estimated total keys**: Depends on deployment duration. Each admin review + action generates 2-3 Redis keys.
