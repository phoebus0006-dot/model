# Phase 1 + Phase 2 Contract (FROZEN)

> Status: **FROZEN**. This contract is the canonical source of truth for Phase 1
> (human review reliability) and Phase 2 (human decision memory). Any change to
> the enums, state machines, field shapes, fingerprint algorithm, suppression or
> reopen rules below requires an explicit contract amendment commit and reviewer
> approval. Agents MUST implement to this contract; they MUST NOT silently drift.
>
> Frozen at: main `96935338ef6faac87c4328f96e563ab700d900fc`.
> Supersedes: the ad-hoc Redis-only review/crawler implementation currently in
> `mw-backend/src/routes/admin.ts` (status enums `approved`/`stale`,
> `succeeded`/`cancelled`, no PostgreSQL persistence).

## 0. Governing Principles

1. **PostgreSQL is the source of truth** for ReviewItem, ReviewDecision,
   CrawlerJob and audit records. Redis is ONLY used as: read cache, short-lived
   queue ordering index, and distributed locks. A human decision is not
   "complete" until it is committed to PostgreSQL.
2. **Human decisions are sticky.** An unchanged evidenceFingerprint with an
   existing terminal/decision record MUST be suppressed, not re-created.
3. **Machine recall may exceed human acceptance.** Machine rules may flag
   liberally; a human may resolve even when the machine threshold is not met.
   The two standards are intentionally asymmetric.
4. **`all` is a query-only status.** It MUST NEVER be persisted.
5. **No status theft.** `created != executed`, `queued != completed`,
   `HTTP 200 != business correct`, `element exists != action works`.
6. **Status reconciliation is one-way.** Legacy Redis values are mapped to the
   canonical set on first persistence to PostgreSQL; the canonical set is the
   only set accepted by new writes.

---

## 1. UserRole

Canonical enum (persisted on `users.role`):

| Value | Scope |
|---|---|
| `user` | Registered visitor. Can like/favorite/comment/manage own collection. |
| `editor` | All `user` scope + edit figure data, publish articles, handle authorized review actions. |
| `admin` | All `editor` scope + user management, review management, crawler canary, cache purge, audit. |

Notes:
- `visitor` is an implicit unauthenticated role; it is NOT persisted.
- The legacy `editor`/`admin` strings already on `users.role` are retained as-is.
- No new roles are introduced in Phase 1/2.

---

## 2. ReviewStatus

Canonical enum (the ONLY values new writes may use):

| Value | Meaning |
|---|---|
| `pending` | Open, awaiting human action. |
| `needs_changes` | Human reviewed and requested changes (e.g. request_refetch returned, or mark_needs_manual_edit). |
| `resolved` | Human accepted the current state as good (approve_image, mark_detail_ok, keep_placeholder with acceptance). |
| `rejected` | Human rejected the candidate / dismissed the risk as not actionable in the rejected sense. |
| `archived` | Item moved out of the active queue without a human content decision: duplicate, already_fixed, figure_missing, insufficient_evidence-after-classification. |

### Legacy → Canonical mapping (one-way, applied on PG persistence)

| Legacy (current Redis) | Canonical |
|---|---|
| `pending` | `pending` |
| `needs_changes` | `needs_changes` |
| `resolved` | `resolved` |
| `rejected` | `rejected` |
| `approved` | `resolved` |
| `stale` | `archived` |

### Legal state transitions

```
pending ──approve_image / mark_detail_ok / keep_placeholder(accept)──▶ resolved
pending ──reject_image / dismiss(not actionable)────────────────────▶ rejected
pending ──request_refetch / mark_needs_manual_edit──────────────────▶ needs_changes
pending ──keep_pending──────────────────────────────────────────────▶ pending  (stays pending, records decision)
needs_changes ──refetch completed & evidence re-evaluated───────────▶ pending (reopen into review) OR resolved
needs_changes ──human resolve────────────────────────────────────────▶ resolved
resolved ──evidence changed / approved image gone────────────────────▶ pending (reopen)
rejected ──evidence changed──────────────────────────────────────────▶ pending (reopen)
any ──duplicate / already_fixed / figure_missing─────────────────────▶ archived
archived ──human explicit reopen─────────────────────────────────────▶ pending
```

Rules:
- `archived` is reachable from any state by the queue-cleanup classifier only
  (duplicate, already_fixed, figure_missing). It is NEVER set by a content
  decision action.
- `keep_pending` does NOT change `status`; it records a `ReviewDecision` with
  `action=keep_pending` and the item remains `pending`.
- Reopen from `resolved`/`rejected`/`archived` back to `pending` is allowed ONLY
  under the reopen conditions in §10.

---

## 3. ReviewAction

Canonical enum (the action a human/automation took; recorded on ReviewDecision):

| Value | Applies to | Resulting status (typical) |
|---|---|---|
| `approve_image` | image / image_review | resolved |
| `reject_image` | image / image_review | rejected |
| `keep_placeholder` | image / image_review | resolved (accepted current state incl. placeholder) |
| `mark_detail_ok` | detail_review | resolved |
| `mark_needs_manual_edit` | detail_review | needs_changes |
| `request_refetch` | image / detail | needs_changes (and creates exactly one CrawlerJob) |
| `keep_pending` | any | pending (unchanged; decision recorded) |
| `dismiss_stale` | any (queue cleanup only) | archived |

Notes:
- `request_refetch` MUST create exactly one CrawlerJob (idempotent per
  evidenceFingerprint within the active window — see §9) and link
  `reviewItem.crawlerJobId`.
- Legacy `dismiss_stale` is retained but is ONLY valid in the queue-cleanup
  classifier path, never as a human content decision.

---

## 4. ReviewRiskType

Canonical enum (the risk vocabulary; superset of current implementation, kept
stable). Grouped by family:

### Image family
- `image_missing`
- `image_low_count`
- `image_low_quality_fallback`
- `image_suspicious_banner`
- `image_suspicious_thumbnail`
- `image_possible_user_photo`
- `image_possible_collection_or_room`
- `image_wrong_subject`
- `image_restore_candidate`

### Detail family
- `detail_missing_description`
- `detail_sparse_specs`
- `detail_conflict`

### Classification family
- `category_uncertain`

### Catch-all
- `general_risk`

These match the current `reviewRiskTypeSchema` exactly; no rename, no removal.
A new risk type requires a contract amendment.

---

## 5. CrawlerJobStatus

Canonical enum (the ONLY values new writes may use):

| Value | Meaning |
|---|---|
| `created` | Job record exists in PostgreSQL; not yet enqueued for a runner. |
| `queued` | Enqueued (visible to eligible runners via the queue index). |
| `claimed` | A runner has claimed it exclusively; work not yet started. |
| `running` | Runner is actively executing the fetch. |
| `completed` | Runner finished and wrote back successfully. |
| `failed` | Runner finished with error or max attempts exhausted. |
| `deferred` | Runner deferred (e.g. source 429/403/captcha); eligible for re-queue after `notBefore`. |

### Legacy → Canonical mapping (one-way)

| Legacy (current Redis) | Canonical |
|---|---|
| `queued` | `queued` |
| `claimed` | `claimed` |
| `running` | `running` |
| `succeeded` | `completed` |
| `failed` | `failed` |
| `deferred` | `deferred` |
| `cancelled` | `failed` (with `result.error` noting cancellation) |

(Note: the legacy implementation jumps straight to `queued`; the new `created`
state is introduced so a job record can exist before being visible to runners.
Manual/admin-created canary jobs start as `created` and transition to `queued`
only when explicitly released.)

### Legal state transitions

```
created ──release/enqueue──▶ queued
queued ──claim──────────────▶ claimed
claimed ──start──────────────▶ running
running ──success────────────▶ completed
running ──error──────────────▶ failed
running ──429/403/captcha────▶ deferred
claimed ──timeout/release────▶ queued   (re-queue, attempt counter unchanged)
deferred ──notBefore passed──▶ queued    (re-queue, attempt counter unchanged)
failed ──admin retry─────────▶ created   (new attempt, attempt counter +1; capped at maxAttempts)
completed ──(terminal)──────▶ —
```

Rules:
- `completed` and `failed` (at maxAttempts) are terminal unless reopened by admin retry.
- A runner in canary mode MUST only claim a job whose id is on the server-side
  allowlist (exact `--job-id` claim). Queue-wide consumption is forbidden in canary.
- `resultSummary` and (for completed) writeback evidence MUST be persisted to
  PostgreSQL, not only Redis.

---

## 6. ReviewItem fields

Persisted to PostgreSQL table `review_items` (Prisma model `ReviewItem`).
Redis key `review:item:{id}` mirrors the row as a read cache only.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | String (PK) | yes | Deterministic, sortable. Format: `{ulid}`. Legacy ids (`{ts}-{rand}`) are kept verbatim on migration. |
| `type` | enum ReviewType | yes | `jan_match \| figure_import \| rewrite \| image \| general \| image_review \| detail_review` (unchanged from current). |
| `riskType` | enum ReviewRiskType | conditional | Required when `type` is `image_review`/`detail_review`/`image`. |
| `status` | enum ReviewStatus | yes | Canonical set only. Default `pending`. |
| `title` | String | yes | Non-empty. MUST NOT be `"-"` in the admin list response. |
| `source` | String? | no | Originating system/source label. |
| `sourceId` | String? | no | Originating system's item id. |
| `figureId` | BigInt? | no | FK to figures. Preferred over figureSlug. |
| `figureSlug` | String? | no | Denormalized for display; resolved to figureId on write when possible. |
| `priority` | Int | yes | 0–3, default 1. |
| `confidence` | Float? | no | 0–1. |
| `riskReason` | String? | no | Max 1000 chars. |
| `candidateImage` | Json? | no | `{ source, imageId?, width?, height?, fileSize?, aspectRatio?, url?, cachedUrl? }`. Identity is authoritative (see §11). |
| `currentPublicImage` | Json? | no | Live snapshot of the figure's current public primary image at decision time. |
| `originalEvidence` | Json? | no | **Frozen** snapshot at creation time. NEVER overwritten. |
| `currentStateSnapshot` | Json? | no | Refreshed on recheck. Distinct from originalEvidence. |
| `detailSnapshot` | Json? | no | `{ description?, specCount?, specs?, categories? }`. |
| `suggestedAction` | enum ReviewAction? | no | Machine suggestion; non-binding. |
| `payload` | Json? | no | Free-form context (janCode, sourceUrl, etc.). |
| `notes` | String? | no | Free text. |
| `evidenceFingerprint` | String | yes | sha256 hex, 64 chars. Unique within active (non-archived) items per (figureId, riskType). See §8. |
| `forceReopen` | Boolean | no | If true, bypass suppression on create. Default false. |
| `crawlerJobId` | String? | no | FK to crawler_jobs.id when request_refetch created a job. |
| `automation` | Json? | no | `{ provider, workflow?, runId? }`. |
| `reviewerId` | BigInt? | no | FK to users.id of last human actor. |
| `decisionReason` | String? | no | Last human reason text. |
| `decisionAt` | DateTime? | no | Last human decision timestamp. |
| `lastAction` | enum ReviewAction? | no | Last action applied. |
| `createdAt` | DateTime | yes | |
| `updatedAt` | DateTime | yes | |

Unique constraint: `@@unique([figureId, riskType, evidenceFingerprint], name: "review_items_active_fingerprint")`
— but archived rows are excluded from the uniqueness window by filtering on
status, so a reopened item can re-use a fingerprint that was archived. The
repository enforces: an active (non-archived) row with the same fingerprint
triggers suppression (§9).

---

## 7. ReviewDecision fields

Persisted to PostgreSQL table `review_decisions` (Prisma model `ReviewDecision`).
Append-only audit log. One ReviewItem has many ReviewDecisions.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | BigInt (PK) | yes | autoincrement. |
| `reviewItemId` | String | yes | FK to review_items.id. |
| `action` | enum ReviewAction | yes | What was done. |
| `statusBefore` | enum ReviewStatus | yes | Item status before this decision. |
| `statusAfter` | enum ReviewStatus | yes | Item status after this decision. |
| `reviewerId` | BigInt? | yes | FK to users.id; null only for automation-initiated. |
| `reviewerRole` | enum UserRole | yes | Role at decision time (audit). |
| `decisionReason` | String? | no | Max 2000 chars. |
| `crawlerJobId` | String? | no | Set when action=request_refetch. |
| `candidateImageHash` | String? | no | sha256 of the approved/rejected candidate identity (§11). |
| `evidenceFingerprint` | String | yes | Copied from the item for fast audit queries. |
| `metadata` | Json? | no | Additional structured context. |
| `createdAt` | DateTime | yes | |

Index: `reviewItemId`, `(reviewItemId, createdAt)`.

---

## 8. evidenceFingerprint canonical input

The fingerprint is a stable sha256 over a CANONICAL string. The canonical
string is built from normalized parts joined by `|`, in this fixed order:

```
sha256(
  type
  + "|" + (figureId as decimal string, or figureSlug, or "no-fig")
  + "|" + riskType            // for image/image_review/detail_review; else "no-risk"
  + "|" + evidenceBody        // type-specific, see below
)
```

### evidenceBody by type

| type | evidenceBody |
|---|---|
| `image` / `image_review` | `candidateImage.url ?? candidateImage.source ?? "no-image"` |
| `detail_review` | `detailSnapshot.description ?? "no-desc"` |
| `jan_match` | `payload.janCode ?? "no-jan"` |
| `figure_import` | `payload.sourceUrl ?? "no-url"` |
| `rewrite` / `general` | `title` |

### Canonicalization rules
- `figureId`: if present, use `BigInt.prototype.toString()` (no scientific
  notation, no grouping). If absent, use `figureSlug`. If both absent, `"no-fig"`.
- Strings are NOT lowercased or trimmed (matching current behavior); changing
  this is a contract amendment.
- `evidenceBody` is taken verbatim; empty/undefined becomes the documented
  fallback token.
- The output is a 64-char lowercase hex sha256.

This matches the current implementation in `admin.ts` lines 594–611, now
formalized. The repository MUST compute the fingerprint server-side on create
when the client does not supply one, and MUST reject a client-supplied
fingerprint that does not match the canonical recomputation (to prevent
fingerprint spoofing for suppression bypass).

---

## 9. Duplicate suppression conditions

On `POST /review/items` (create), with `forceReopen != true`:

1. Compute canonical `evidenceFingerprint`.
2. Look up an ACTIVE (status != `archived`) ReviewItem with the same
   `(figureId, riskType, evidenceFingerprint)` in PostgreSQL.
3. If found:
   - If its status is `pending` or `needs_changes`: return `200` with
     `suppressed: true, reason: "duplicate_active"`, data = existing item. Do
     NOT create a new row.
   - If its status is `resolved` or `rejected` (terminal human decision):
     return `200` with `suppressed: true, reason: "duplicate_decided"`,
     data = existing item. Do NOT create a new row. (Human decision is sticky.)
4. If only ARCHIVED rows match: create a new ReviewItem (the prior was
   classified out, not decided).
5. If no match: create normally.

`forceReopen=true` bypasses steps 2–3 and creates a new row (used after evidence
change or admin explicit reopen). The caller MUST also set a `reopenReason`.

---

## 10. Reopen conditions

A resolved/rejected/archived ReviewItem MAY transition back to `pending` ONLY
when one of the following is true:

| Condition | Evidence |
|---|---|
| Primary image changed | `figure_images` primary row for figureId differs from `candidateImage.imageId`/hash at decision time. |
| Image set changed | The multiset of active `figure_images` ids for figureId differs from the set recorded in `originalEvidence.imageIds`. |
| Approved image deleted | The image whose id = `decision.candidateImageHash`/imageId no longer exists in `figure_images`. |
| Approved image invalidated | Image endpoint returns non-image content-type or HTTP >= 400. |
| Candidate changed | `candidateImage.source`/`url` differs from the decided candidate. |
| Detail-relevant fields changed | For detail_review: any of description/manufacturer/series/scale/material/height changed since `originalEvidence`. |
| Human explicit reopen | Admin action with `reopenReason`. |

Reopen creates a NEW ReviewItem (new id) referencing the old one via
`payload.reopenedFrom`, with `forceReopen=true` and a fresh evidenceFingerprint
if the evidence changed. The old item stays in its terminal status for audit.

---

## 11. Candidate asset identity

The reviewer-visible candidate, the preview/lightbox asset, and the approved
asset MUST be the same identity:

```
candidate source URL
  → browser/NAS fetch
  → server-side cache (review:image:{sha256})
  → review item candidateImage (url OR cachedUrl; identity keyed by sha256)
  → preview endpoint
  → lightbox endpoint
  → approve_image action (records candidateImageHash)
  → official FigureImage (sha256 must match candidateImageHash)
```

Rules:
- `candidateImage.url` (original) and `candidateImage.cachedUrl` (server cache)
  MUST resolve to the same bytes (same sha256).
- The preview and lightbox endpoints MUST serve from `cachedUrl` and return
  `content-type: image/*`.
- `approve_image` MUST write a `FigureImage` whose `sha256` equals the recorded
  `candidateImageHash`. A mismatch is a hard reject.
- A 302 on the original URL is NOT success; the cache must hold the decoded
  bytes.

---

## 12. API return structure

All review/crawler API responses use this envelope:

```json
{
  "success": true,
  "data": { ... } | [ ... ] | null,
  "meta": { "total": 0, "page": 1, "limit": 50 } | null,
  "suppressed": false,
  "reason": null
}
```

Error envelope:

```json
{
  "success": false,
  "error": { "code": "ERROR_CODE", "message": "...", "details": { ... } }
}
```

### Review list (`GET /admin/review/items`)

```json
{
  "success": true,
  "data": [
    {
      "id": "...",
      "type": "image_review",
      "riskType": "image_low_count",
      "status": "pending",
      "title": "Figure title (NOT '-')",
      "figureId": "286",
      "figureSlug": "...",
      "priority": 1,
      "riskReason": "...",
      "suggestedAction": "approve_image",
      "candidateImage": { "source": "...", "url": "...", "cachedUrl": "...", "width": 668, "height": 668 },
      "currentPublicImage": { "imageId": "12", "source": "...", "width": 123, "height": 256 },
      "originalEvidence": { "imageCount": 0, "imageIds": [], "primaryImageId": null, "capturedAt": "..." },
      "currentStateSnapshot": {
        "imageCount": 1,
        "primaryImageId": "12",
        "descriptionLength": 0,
        "validSpecCount": 2,
        "missingFields": ["description"]
      },
      "evidenceFingerprint": "ab12...",
      "crawlerJobId": null,
      "reviewerId": null,
      "decisionReason": null,
      "decisionAt": null,
      "lastAction": null,
      "sharedCandidateWarning": false,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "meta": { "total": 130, "page": 1, "limit": 50 },
  "suppressed": false,
  "reason": null
}
```

The list response MUST enrich each item with the CURRENT figure state
(`currentStateSnapshot`) computed server-side at query time — never a stale
snapshot stored at creation. `originalEvidence` is the frozen creation-time
snapshot. The two are always separate fields.

### Review create (`POST /admin/review/items`)

- `201` on new item: `{ success: true, data: item, suppressed: false, reason: null }`
- `200` on suppression: `{ success: true, data: existingItem, suppressed: true, reason: "duplicate_active" | "duplicate_decided" }`

### Review action (`POST /admin/review/items/:id/action`)

Request: `{ action, decisionReason?, candidateImage? }`
Response: `{ success: true, data: updatedItem, decision: { id, action, statusBefore, statusAfter, crawlerJobId? } }`

### Review recheck (`POST /admin/review/items/:id/recheck`)

Re-evaluates the item against current figure state and returns the updated
`currentStateSnapshot` plus a `recheckResult`:
`{ stillProblem: boolean, reason: string, eligibleResolve: boolean }`.

### Crawler job (`GET /admin/crawler/jobs/:id`)

```json
{
  "success": true,
  "data": {
    "id": "...",
    "source": "amiami",
    "task": "refetch_images",
    "runner": "local_browser",
    "status": "completed",
    "priority": 1,
    "payload": { "figureId": "286", "needImages": true, "needDetails": false },
    "resultSummary": { "imagesAdded": 2, "detailsUpdated": 0 },
    "error": null,
    "attempts": 1,
    "maxAttempts": 3,
    "notBefore": null,
    "linkedReviewItemId": "01J...",
    "createdAt": "...",
    "claimedAt": "...",
    "completedAt": "..."
  }
}
```

### Crawler claim (`POST /admin/crawler/jobs/claim`)

Canary mode (server-side allowlist): request MUST include `jobIds: [id1, id2]`;
the server claims ONLY those. Queue-wide claim (no `jobIds`) is forbidden when
`canaryMode=true` on the runner.

---

## 13. Storage responsibility matrix

| Data | PostgreSQL (source of truth) | Redis (cache/queue/lock) |
|---|---|---|
| ReviewItem row | YES (review_items) | `review:item:{id}` mirror (cache, TTL 1h) |
| Review active order | derived by query | `review:items` ZSET (index, rebuilt from PG) |
| ReviewDecision | YES (review_decisions) | not cached |
| evidenceFingerprint index | YES (unique constraint) | `review:fingerprint:{fp}` → id (cache) |
| CrawlerJob row | YES (crawler_jobs) | `crawler:job:{id}` mirror (cache) |
| Crawler queue order | derived by query | `crawler:jobs` ZSET (index) |
| Review processed image bytes | file system | `review:image:{sha256}` (cache) |
| Figure detail cache | n/a | `figures:detail:*` (cache only) |

Cache invalidation: on any ReviewItem/CrawlerJob write, the corresponding
`review:item:{id}` / `crawler:job:{id}` cache key is overwritten or deleted;
the ZSET index is updated. The ZSET is rebuildable from PostgreSQL at any time
(rebuild procedure is part of the review-storage agent).

---

## 14. Cache purge safety (carried from security baseline)

- `POST /admin/cache/purge` operates ONLY on the `figures:*`, `search:*`,
  `community:*` namespaces via `SCAN` + `UNLINK`.
- BLOCKED namespaces (MUST be rejected): `review:`, `crawler:`, `session:`,
  `rate-limit:`, `aigc:`.
- `FLUSHDB` / `FLUSHALL` are forbidden everywhere; the codebase MUST NOT
  contain either token in a Redis call path.
- The legacy `app.redis.keys("figures:*")` pattern in admin.ts MUST be replaced
  with `SCAN` (performance + blocking safety).

---

## 15. Non-goals for Phase 1/2

- No new crawler sources, no crawler concurrency increase, no batch MFC scrape.
- No admin UI rewrite, no login layout change, no new navigation.
- No review article / collection model changes (Phase 3+).
- No search engine introduction.
- No microservice split.

---

## 16. Agent ownership map

| Agent | Owns | Branch | Merge order |
|---|---|---|---|
| review-storage | Prisma models, migration, repository (PG+Redis), status reconciliation, fingerprint canonicalization | `agent/review-storage` | 1 |
| runtime-security | SSRF on image-proxy, review cache signing, cache purge SCAN, FLUSHDB guard | `agent/runtime-security` | 2 |
| crawler-state | CrawlerJob PG model + state machine, exact canary claim, writeback to PG | `agent/crawler-state` | 3 |
| review-api-integration | review list enrichment, original vs current split, recheck, apply closure, action persistence | `agent/review-api-integration` | 4 |
| admin-ui | keep_pending modal, decision fields display, candidate identity, double-click guard (no rewrite) | `agent/admin-ui` | 5 |
| qa-ci | test scaffolding, secret scan, typecheck, admin JS check, PHP syntax, migration validate | `agent/qa-ci` | 6 |
| reviewer fixes | post-merge review fixes | `reviewer/fixes` | 7 |

Each agent works in an independent worktree + branch. No two agents edit the
same file simultaneously. Cross-agent contract is THIS document.

---

## 17. Amendment protocol

Any change to enums, state machines, fingerprint algorithm, suppression/reopen
rules, or field shapes requires:
1. A commit on `main` amending this file with a clear changelog entry.
2. Reviewer approval.
3. Re-freeze note with the new base SHA.

Agents MUST NOT deviate from this frozen contract in their implementations; if
an agent discovers a needed change, it raises it as a carry-over item for
contract amendment rather than silently drifting.
