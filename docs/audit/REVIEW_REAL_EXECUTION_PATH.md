# Review Real Execution Path

## 1. Create Review Item

```
POST /review/items
→ reviewItemSchema validation
→ normalizeReviewItemForFingerprint(app, data)
  → resolveReviewFigure(app.prisma, item, payload)  [Prisma: figure.findFirst]
  → prisma.figure.findUnique (get current state)
  → computeReviewEvidenceFingerprint(item) [pure crypto]
→ reviewDecisionKey(candidate)  [check existing suppression decision]
  → redis.get(`review:decision:{key}`)
→ if no suppression: findExistingPendingReview(app, candidate)
  → redis.zrevrange("review:items")
  → redis.get(`review:item:{id}`)  [N+1: 1 GET per item]
→ id = `${Date.now()}-${random}`
→ redis.set(`review:item:{id}`, JSON.stringify(item))  [write]
→ redis.zadd("review:items", Date.now(), id)  [write]
→ 201 response
```

## 2. Action on Review Item

```
POST /review/items/:id/action
→ reviewActionSchema validation
→ redis.get(`review:item:{id}`)  [read]
→ compute new status from actionStatusMap
→ normalizeReviewItemForFingerprint(app, updatedItem)
  → resolveReviewFigure(app.prisma, item, payload)  [Prisma]
  → prisma.figure.findUnique
  → computeReviewEvidenceFingerprint
→ redis.set(`review:item:{id}`, JSON.stringify(updatedItem))  [write]
→ saveReviewDecision(app, updatedItem, action, ...)
  → reviewDecisionKey(decisionItem)
  → redis.set(`review:decision:{key}`, JSON.stringify(decision))  [write]
  → redis.zadd("review:decisions", Date.now(), key)  [write]
→ if request_refetch: redis.set/get crawler job + zadd
→ if image action: scanKeys(app.redis, "figures:detail:*")  [cache purge]
→ 200 response
```

## 3. Apply Review Item

```
POST /review/items/:id/apply
→ redis.get(`review:item:{id}`)  [read]
→ type-dispatch:
  figure_import:
    → prisma.figure.findFirst (existing check)
    → prisma.figure.create or update + relations (categories, sculptors, characters, localized, releases)
    → for each image: processAndStoreImage (HTTP download + sharp) + upsertFigureImageRecord (DB)
    → prisma.revision.create + prisma.figure.update (activeRevisionId)
  rewrite:
    → prisma.figure.findFirst
    → prisma.$transaction: revision.updateMany + revision.create + figure.update
  image / image_review:
    → prisma.figure.findFirst
    → for each processed image: storeProcessedReviewImage (sharp + fs.write)
    → for each source image: processAndStoreImage (HTTP) + upsertFigureImageRecord
    → prisma.figureImage.deleteMany
→ evaluateReviewItem(app, item)  [Prisma queries]
→ normalizeReviewItemForFingerprint(app, updatedItem)  [Prisma + crypto]
→ redis.set(`review:item:{id}`, JSON.stringify(updatedItem))  [write]
→ if reviewDecisionAction: saveReviewDecision (Redis write)
→ scanKeys(app.redis, "figures:*")  [cache purge]
→ 200 response
```

## 4. Recheck

```
POST /review/items/:id/recheck
→ redis.get(`review:item:{id}`)  [read]
→ evaluateReviewItem(app, item)  [Prisma queries: figureImage, revision, figure]
→ compute next status (resolved / needs_changes / keep current)
→ redis.set(`review:item:{id}`, JSON.stringify(updatedItem))  [write]
→ 200 response
```

## 5. List / Stats

```
GET /review/items
→ redis.zrevrange("review:items", 0, -1)  [ALL IDs]
→ for each ID: redis.get(`review:item:{id}`)  [N+1 pattern]
→ in-memory filter + pagination
→ for each item in page: prisma.figure.findMany (batch by idSet + slugSet)
→ response

GET /review/stats
→ redis.zrevrange("review:items", 0, -1)  [ALL IDs]
→ for each ID: redis.get(`review:item:{id}`)  [N+1 pattern]
→ in-memory aggregation
→ redis.zcard("review:archive")
→ response
```

## Key Observations

- **N+1 pattern**: List and Stats read ALL IDs from the sorted set, then do individual GET per ID
- **No transactions across Redis + Prisma**: Apply has Prisma writes and Redis writes in separate steps
- **State machine bypass**: PUT /review/items/:id allows direct status modification without action endpoint
- **Blind writes**: No CAS, no version, no atomicity
