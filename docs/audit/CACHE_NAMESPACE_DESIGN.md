# Cache Namespace Design

Generated: 2026-07-11

---

## Current Namespace Layout (all v1 implicit)

| Namespace | Pattern | TTL | Set By | Invalidated By | Description |
|-----------|---------|-----|--------|----------------|-------------|
| `figures:detail:<slug>` | `figures:detail:*` | 3600s | `GET /figures/:slug` | PUT/DELETE figures, image CRUD, review apply/action | Single figure detail cache |
| `figures:list:<query-hash>` | `figures:list:*` | 300s | `GET /figures` | PUT/DELETE figures, image CRUD | Figure list with filters |
| `series:list:<query-hash>` | `series:list:*` | 600s | `GET /series` | Series write | Series list |
| `sculptors:list:<query-hash>` | `sculptors:list:*` | 600s | `GET /sculptors` | Sculptor write | Sculptor list |
| `manufacturers:list:<query-hash>` | `manufacturers:list:*` | 600s | `GET /manufacturers` | Manufacturer write | Manufacturer list |
| `characters:list:<query-hash>` | `characters:list:*` | 600s | `GET /characters` | Character write | Character list |
| `categories:<lang>` | `categories:*` | 600s | `GET /categories` | Category write | Category tree |
| `review:item:<id>` | `review:item:*` | ∞ | POST review items | Action/apply/cleanup | Per-review-item data |
| `review:decisions` | `review:decisions` | ∞ | saveReviewDecision | — | Sorted set of decisions |
| `crawler:job:<id>` | `crawler:job:*` | ∞ | POST/claim jobs | PUT job update | Crawler job data |
| `aigc:result:<figureId>` | `aigc:result:*` | ∞ | AIGC completion | — | AIGC generation result |
| `aigc:queue` | `aigc:queue` | ∞ | POST aigc/generate | — | AIGC job queue (list) |
| `legacy:import:*` | `legacy:import:*` | ∞ | Legacy imports | — | Legacy import state |

## Version Pointer Scheme (Proposed)

```
cache-version:figures = 12
cache-version:series  = 1
cache-version:sculptors = 1
cache-version:manufacturers = 1
cache-version:characters = 1
cache-version:categories = 1

figures:v12:detail:<slug>
figures:v12:list:<query-hash>
series:v1:list:<query-hash>
...
```

When data changes:
1. Increment version counter for affected domain
2. Old keys are naturally evicted by TTL or lazily skipped on read
3. No KEYS/SCAN needed for invalidation

## What to Version

| Domain | Suitable for Version Switch? | Reasons |
|--------|---------------------------|---------|
| figures:detail | YES | Mostly static descriptions + images; version increment on figure update |
| figures:list | YES | Depends on figures data + filters; version on any figure write |
| series/sculptors/manufacturers/characters | YES | Low-write domains; version on entity write |
| categories | YES | Very low write frequency; version on category admin |
| review:* | NO | Not cached data; operational state |
| crawler:* | NO | Not cached data; operational state |
| aigc:* | NO | Not cached data; operational state |
| legacy:import:* | NO | Legacy, feature-gated |

## TTL Strategy

| Cache Type | Current TTL | Recommended TTL | Rationale |
|-----------|------------|-----------------|-----------|
| figures:detail | 3600s (1h) | 3600s | Changes infrequent; stale-while-revalidate acceptable |
| figures:list | 300s (5m) | 300s | Search results should be fresh |
| entity lists | 600s (10m) | 600s | Entity metadata changes rarely |
| categories | 600s (10m) | 3600s | Very stable |

## Redis Unavailability Degradation

| Scenario | Behavior |
|----------|----------|
| Redis down on read | Fall through to PostgreSQL; log error; no crash |
| Redis down on write | Fail open — write to DB; cache becomes stale; log error |
| Redis down on cache purge | Report error to admin; do not block the operation |
| Redis connection flapping | Retry strategy already configured (3 retries in plugin, 1 in skipLifecycle) |

## Background Cleanup

After version switch, old version keys remain until TTL expires. For aggressive cleanup:
- A background job can scan old version patterns and UNLINK them
- Not needed immediately; TTL handles natural eviction

## Key Growth Prevention

- Version pointer keys are single Redis strings, not unbounded
- Old version data is TTL-bound (max 3600s)
- Review/crawler operational data needs archival policy (future work)
