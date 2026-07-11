# Admin API Contract

Generated: 2026-07-11 | Source: `mw-backend/src/routes/admin.ts` (2323 lines, 27 routes)

Routes registered at prefix `/api/v1/admin`. Auth enforced by global `onRequest` hook in `app.ts:129-143` — requires valid JWT Bearer token with `role === "admin"` and `isActive === true`.

---

## Route Inventory

### AIGC

| # | Method | Path | Auth | Query | Params | Body | 200 Response | Error Codes | PostgreSQL | Redis | Side Effects |
|---|--------|------|------|-------|--------|------|-------------|-------------|------------|-------|-------------|
| 1 | POST | `/aigc/generate` | admin | — | — | `{ figureId: number, locale?: "ja"\|"en"\|"zh", promptVersion?: string }` | `{ success, data: { figureId, status, locale } }` | 404 (not found) | `figure.findUnique` | `lpush("aigc:queue", ...)` | — |
| 2 | GET | `/aigc/status/:figureId` | admin | — | `figureId` | — | `{ success, data: { status, result? } }` | — | `get("aigc:result:${id}")`, `lrange("aigc:queue",0,-1)` | — |

### Review — List & Query

| # | Method | Path | Auth | Query | Params | Body | 200 Response | Error Codes | PostgreSQL | Redis | Side Effects |
|---|--------|------|------|-------|--------|------|-------------|-------------|------------|-------|-------------|
| 3 | GET | `/review/items` | admin | `status?`, `type?`, `riskType?`, `limit`(≤200), `offset` | — | — | `{ success, data: ReviewItem[], meta: { count, total, limit, offset } }` | — | `figure.findMany` (batch enrich) | `zrevrange("review:items",0,-1)`, `get("review:item:${id}")` | — |
| 4 | GET | `/review/decisions` | admin | `figureId?`, `figureSlug?`, `riskType?`, `action?`, `limit`, `offset` | — | — | `{ success, data: Decision[], meta: { count, total, limit, offset } }` | — | `figure.findFirst` (slug→id) | `zrevrange("review:decisions",0,-1)`, `get(key)` | — |
| 5 | GET | `/review/stats` | admin | — | — | — | `{ success, data: { total, pending, pending_image_review, pending_detail_review, pending_rewrite, pending_figure_import, stale, resolved, rejected, approved, needs_changes, archived } }` | — | — | `zrevrange("review:items",0,-1)`, `get("review:item:${id}")`, `zcard("review:archive")` | — |

### Review — Single Item CRUD

| # | Method | Path | Auth | Query | Params | Body | 200 Response | Error Codes | PostgreSQL | Redis | Side Effects |
|---|--------|------|------|-------|--------|------|-------------|-------------|------------|-------|-------------|
| 6 | POST | `/review/items` | admin | — | — | `ReviewItem` (complex, ~40 fields) | `201: { success, data }` or `200: { success, data, meta: { suppressed/duplicate } }` | — | `figure.findUnique` (via fingerprint) | `get(decisionKey)`, `zrevrange("review:items",...)`, `set("review:item:${id}",...)`, `zadd("review:items",...)` | — |
| 7 | PUT | `/review/items/:id` | admin | — | `id` | `{ status?, priority?, payload?, notes?, candidateImage?, ... }` | `{ success, data }` | 404 | — | `get("review:item:${id}")`, `set("review:item:${id}",...)` | — |
| 8 | POST | `/review/items/:id/recheck` | admin | — | `id` | — | `{ success, data: { item, problems } }` | 404 | `figure.findUnique`, `figureImage.findMany`, `revision.findMany` | `get("review:item:${id}")`, `set("review:item:${id}",...)` | — |

### Review — Actions & Apply

| # | Method | Path | Auth | Query | Params | Body | 200 Response | Error Codes | PostgreSQL | Redis | Side Effects |
|---|--------|------|------|-------|--------|------|-------------|-------------|------------|-------|-------------|
| 9 | POST | `/review/items/:id/action` | admin | — | `id` | `{ action: ReviewAction, notes?: string }` | `{ success, data: { item, action, crawlerJobId? } }` | 404 | — (indirect via `normalizeReviewItem`) | `get("review:item:${id}")`, `set("review:item:${id}",...)`, `keys("figures:detail:*")`, `del(...figKeys)`, `set("crawler:job:${id}",...)`, `zadd("crawler:jobs",...)` | Creates crawler job on `request_refetch` |
| 10 | POST | `/review/items/:id/apply` | admin | — | `id` | Varies by `item.type`: `{ figure?, janCode?, contentMd?, images?, ... }` | `{ success, data: { item, applied, problems? } }` | 404, 422 | **Heavy**: `figure.findFirst/update/create`, `figureImage`, `revision`, `$transaction` | `get("review:item:${id}")`, `set("review:item:${id}",...)`, `keys("figures:*")`, `del(...allKeys)`, `saveReviewDecision` | HTTP image download, filesystem write |
| 11 | POST | `/review/items/bulk/cleanup` | admin | — | — | `{ dryRun?: bool, markStale?: bool, olderThanDays?: int }` | `{ success, data: { updatedCount, skippedCount, totalScanned, dryRun, sampleUpdated } }` | — | — | `zrevrange("review:items",0,-1)`, `get("review:item:${id}")`, `set("review:item:${id}",...)` | — |

### Crawler Job Management

| # | Method | Path | Auth | Query | Params | Body | 200 Response | Error Codes | PostgreSQL | Redis | Side Effects |
|---|--------|------|------|-------|--------|------|-------------|-------------|------------|-------|-------------|
| 12 | GET | `/crawler/jobs` | admin | `status?`, `runner?`, `source?`, `limit`(≤200) | — | — | `{ success, data, meta: { count, limit } }` | — | — | `zrevrange("crawler:jobs",0,...)`, `get("crawler:job:${id}")` | — |
| 13 | POST | `/crawler/jobs` | admin | — | — | `CrawlerJob { source, task, runner?, priority?, payload?, ... }` | `201: { success, data }` | — | — | `set("crawler:job:${id}",...)`, `zadd("crawler:jobs",...)` | — |
| 14 | POST | `/crawler/jobs/claim` | admin | — | — | `{ runner, workerId, limit? }` | `{ success, data, meta: { count } }` | — | — | `zrevrange("crawler:jobs",0,500)`, `get("crawler:job:${id}")`, `set("crawler:job:${id}",...)` | — |
| 15 | GET | `/crawler/jobs/:id` | admin | — | `id` | — | `{ success, data }` | 404, 500 | — | `get("crawler:job:${id}")` | — |
| 16 | PUT | `/crawler/jobs/:id` | admin | — | `id` | `{ status?, runner?, priority?, payload?, result?, error?, notes?, notBefore? }` | `{ success, data }` | 404 | — | `get("crawler:job:${id}")`, `set("crawler:job:${id}",...)` | — |

### Cache Administration

| # | Method | Path | Auth | Query | Params | Body | 200 Response | Error Codes | PostgreSQL | Redis | Side Effects |
|---|--------|------|------|-------|--------|------|-------------|-------------|------------|-------|-------------|
| 17 | POST | `/cache/purge` | admin | — | — | `{ pattern?: string, paths?: string[], purgeAll? }` | `{ success, data: { purged, mode, matched, deleted, namespaces } }` | 422 (bad pattern/namespace) | — | `scan(cursor,"MATCH",pattern,"COUNT","100")`, `unlink(...keys)` | — |

### System & Users

| # | Method | Path | Auth | Query | Params | Body | 200 Response | Error Codes | PostgreSQL | Redis | Side Effects |
|---|--------|------|------|-------|--------|------|-------------|-------------|------------|-------|-------------|
| 18 | GET | `/stats` | admin | — | — | — | `{ success, data: { counts: {...}, recentFigures, upcomingReleases, topManufacturers } }` | — | 7×count + 3×findMany (Promise.all) | — | — |
| 19 | GET | `/users` | admin | — | — | — | `{ success, data: User[] }` | — | `user.findMany` | — | — |
| 20 | PUT | `/users/:id` | admin | — | `id` | `{ displayName?, role?, isActive? }` | `{ success, data }` | 400, 404 | `user.findUnique`, `user.count` (admin), `user.update` | — | — |
| 21 | PUT | `/users/:id/password` | admin | — | `id` | `{ newPassword }` | `{ success, data: { message } }` | 400, 404, 422 | `user.findUnique`, `user.update` (passwordHash) | — | `bcrypt.hash` |
| 22 | POST | `/users` | admin | — | — | `{ email, password, displayName, role? }` | `201: { success, data }` | 409, 422 | `user.findUnique`, `user.create` | — | `bcrypt.hash` |
| 23 | DELETE | `/users/:id` | admin | — | `id` | — | `{ success, data: { message } }` | 400, 404 | `user.findUnique`, `user.count` (admin), `$transaction` (delete favorites+user) | — | — |

### Legacy Imports & Utilities

| # | Method | Path | Auth | Query | Params | Body | 200 Response | Error Codes | PostgreSQL | Redis | Side Effects |
|---|--------|------|------|-------|--------|------|-------------|-------------|------------|-------|-------------|
| 24 | GET | `/import/status` | admin | — | — | — | `{ success, data: { queueLength, isProcessing, currentJob, recentImports } }` | 410 (feature disabled) | — | `llen("legacy:import:queue")`, `get("legacy:import:processing")`, `keys("legacy:import:result:*")` | — |
| 25 | GET | `/review/image-proxy` | admin+ | `url` (rate limited 100/min) | — | — | Binary image (Content-Type, Cache-Control) | 401, 422 | — | — | HTTP download via `downloadImage(url)` |
| 26 | POST | `/review/cache-candidate` | admin+ | — | — | `{ reviewId, hash, contentBase64, ext? }` | `201: { success, data: { reviewId, hash, ext, url } }` | 401, 422, 500 | — | — | Filesystem: mkdir, writeFile, rename; sharp encode; HMAC signing |
| 27 | POST | `/figures/batch` | admin | — | — | `{ figures: FigureInput[] }` (max 100) | `{ success, data: { total, results: [{slug,status,id?,error?}] } }` | 410 (feature disabled) | `figure.findFirst/create`, `processAndStoreImage` | `keys("figures:*")`, `del(...allKeys)` | HTTP image download per figure |

---

## Redis KEYS Usage (Blocking Calls)

| ID | File:Line | Pattern | Caller Route | Auth | Risk | Current Mitigation |
|----|-----------|---------|--------------|------|------|-------------------|
| K1 | admin.ts:1235 | `figures:detail:*` | `POST /review/items/:id/action` | admin | HIGH — request-path, blocking | None |
| K2 | admin.ts:1749 | `figures:*` | `POST /review/items/:id/apply` | admin | HIGH — request-path, blocking | None |
| K3 | admin.ts:2092 | `legacy:import:result:*` | `GET /import/status` | admin | LOW — read-only status, small expected cardinality | Keys limited to 10 via slice |
| K4 | admin.ts:2318 | `figures:*` | `POST /figures/batch` | admin | HIGH — request-path, blocking | None |

---

## Auth Model

All admin routes require admin JWT with active status. Enforcement is via global `onRequest` hook in `app.ts` (lines 129-143):
1. Extract Bearer token from `Authorization` header
2. Verify JWT → get `userId`, `role`
3. Query `prisma.user.findUnique` — must be `isActive === true` and `role === "admin"`
4. Set `(req as any).user = { userId, role }`

Additional auth checks exist for:
- `GET /review/image-proxy` (line ~2120): checks `req.user`
- `POST /review/cache-candidate` (line ~2150): checks `req.user`
- Feature gates: `GET /import/status` and `POST /figures/batch` check `ENABLE_LEGACY_ADMIN_IMPORTS`

---

## Contract Test Coverage Plan

| Category | Routes | Minimum Tests |
|----------|--------|--------------|
| Auth | all admin routes | 3: no auth, non-admin, valid admin |
| Review list | `GET /review/items`, `GET /review/stats` | 3: default, pagination, filters |
| Review action | `POST /review/items/:id/action` | 5: approve, reject, keep_pending, recheck, not found |
| Bulk cleanup | `POST /review/items/bulk/cleanup` | 5: all success, partial, empty, duplicate, exceeds limit |
| Cache purge | `POST /cache/purge` | 5: admin-only, success fields, bad pattern, Redis error, partial |
| Users | `GET /users`, `PUT /users/:id`, etc. | 3: list, update, create |
