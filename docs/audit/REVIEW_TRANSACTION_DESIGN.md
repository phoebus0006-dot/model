# Review Transaction Design

Generated: 2026-07-11

## Current State

All review data is stored in Redis as JSON blobs. There is no PostgreSQL persistence for review items, decisions, or audit trails.

### Apply Route (R9) Transaction Flow

```
1. Read item from Redis (GET review:item:{id})
2. Resolve figure from PostgreSQL (Prisma findFirst)
3. Prisma writes:
   a. (figure_import) create/update figure + relations + images + revision
   b. (rewrite) create revision, update activeRevisionId
   c. (image) processAndStoreImage + upsertFigureImageRecord + deleteMany
   d. (image_review) processAndStoreImage + upsertFigureImageRecord
   e. (jan_match) update figure.janCode
4. Redis save updated item (SET review:item:{id})
5. Redis save decision (SET review:decision:{key} + ZADD review:decisions)
6. Redis SCAN purge figure caches
```

**Problem**: No atomicity across steps 3-6.
- If step 4 fails: PostgreSQL writes committed but Redis state inconsistent
- If step 5 fails: decision not saved (but apply succeeds)
- If step 6 fails: stale cache served to users

### Action Route (R7) Transaction Flow

```
1. Read item from Redis
2. Compute new status
3. Redis save updated item
4. Redis save decision (if suppressing action)
5. Redis create crawler job (if request_refetch)
6. Redis SCAN cache purge (if image action)
```

**Problem**: Steps 3-6 are separate Redis calls. Between step 1 and 3, another admin's actions are lost.

## Recommended Architecture

### Phase 4 Proposal: PostgreSQL Audit Trail

```prisma
model ReviewAuditLog {
  id         BigInt   @id @default(autoincrement())
  reviewId   String   @map("review_id")
  action     String
  fromStatus String?  @map("from_status")
  toStatus   String?  @map("to_status")
  reviewer   String?
  reason     String?
  payload    Json?
  createdAt  DateTime @default(now()) @map("created_at")

  @@map("review_audit_logs")
}
```

This enables:
- `$transaction` to atomically write review action + audit log
- Recovery after Redis loss
- Proper audit trail with queries

### Concurrency Fix: Conditional Redis Update

Replace:
```ts
const item = JSON.parse(await redis.get(key));
item.status = newStatus;
await redis.set(key, JSON.stringify(item));
```

With Lua script:
```lua
-- REVIEW_ITEM_CAS
local key = KEYS[1]
local expectedStatus = ARGV[1]
local newData = ARGV[2]
local current = redis.call("GET", key)
if not current then return {0, "NOT_FOUND"} end
local decoded = cjson.decode(current)
if decoded.status ~= expectedStatus then return {0, "CONFLICT"} end
redis.call("SET", key, newData)
return {1, "OK"}
```

Or for simple cases, use `WATCH`/`MULTI`:
```ts
await redis.watch(`review:item:${id}`);
const raw = await redis.get(`review:item:${id}`);
const item = JSON.parse(raw!);
item.status = newStatus;
const multi = redis.multi();
multi.set(`review:item:${id}`, JSON.stringify(item));
const [err, results] = await multi.exec();
if (err || !results) throw new Error("Concurrent modification detected");
```

### Outbox Pattern for Cache Invalidation

```ts
// In transaction:
await prisma.$transaction([
  prisma.reviewAuditLog.create({ data: { ... } }),
  prisma.outbox.create({ data: { type: "CACHE_PURGE", payload: { pattern: "figures:*" } } }),
]);

// Background worker:
// SELECT * FROM outbox WHERE processed = false
// SCAN + UNLINK
// MARK processed
```

This ensures cache invalidation survives Redis unavailability without blocking the apply route.

## Current Mitigations

Since there is no Prisma model for review items, the following mitigations apply:

| Issue | Mitigation |
|-------|------------|
| No audit log table | Audit trail embedded in item.notes JSON field |
| Blind SET overwrite | Low risk in single-admin operation; documented for multi-admin |
| Redis-only persistence | Redis persistence (RDB/AOF) provides some recovery |
| Cache invalidation failure | User-visible stale data until next mutation; no data corruption |
