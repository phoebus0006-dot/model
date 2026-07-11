# Redis Key Migration Plan

| # | File | Line | Pattern | Classification | Status | Replacement |
|---|------|------|---------|---------------|--------|-------------|
| K1 | admin.ts | 1237 | `figures:detail:*` | Management (image decision) | ✅ Phase 2 | `scanKeys()`, batch UNLINK |
| K2 | admin.ts | 1751 | `figures:*` | Management (figure bulk reindex) | ✅ Phase 2 | `scanKeys()`, batch UNLINK |
| K3 | admin.ts | 2019 | `legacy:import:result:*` | Management (read-only, low cardinality) | ✅ Phase 3 | SCAN loop (read-only, no delete) |
| K4 | admin.ts | 2252 | `figures:*` | Management (data migration/cleanup) | ✅ Phase 2 | `scanKeys()`, batch UNLINK |
| K5 | admin.ts | (cache purge) | user-provided pattern | Management (admin cache purge) | ✅ Phase 2 | `CacheService.invalidateByPattern()` with allowlist |
| K6 | categories.ts | 15 | `categories:*` | Management (category CRUD cache invalidate) | ✅ Phase 3 | `scanKeys()` |
| K7 | figures.ts | 286-289 | `figures:detail:*`, `figures:list:*` | Management (figure CRUD cache invalidate) | ✅ Phase 3 | `scanKeys()` |
| K8 | images.ts | 393-396 | `figures:detail:*`, `figures:list:*` | Management (image decision cache invalidate) | ✅ Phase 3 | `scanKeys()` |
| K9 | characters.ts | 23 | `characters:list:*` | Management (character CRUD cache invalidate) | ✅ Phase 3 | `scanKeys()` |
| K10 | manufacturer.ts | 23 | `manufacturers:list:*` | Management (manufacturer CRUD cache invalidate) | ✅ Phase 3 | `scanKeys()` |
| K11 | series.ts | 22 | `series:list:*` | Management (series CRUD cache invalidate) | ✅ Phase 3 | `scanKeys()` |
| K12 | sculptor.ts | 23 | `sculptors:list:*` | Management (sculptor CRUD cache invalidate) | ✅ Phase 3 | `scanKeys()` |
| K13 | admin.ts | (legacy) | `legacy:import:queue` | Background (not KEYS, LPOP/RPUSH) | KEEP | Not KEYS — safe |

## Resolution

**All production `app.redis.keys()` calls eliminated.** Every instance replaced with SCAN-based iteration via `scanKeys()` helper.

- **Phase 2 handled**: K1-K5 (admin.ts request-path KEYS → SCAN)
- **Phase 3 handled**: K6-K12 (entity cache invalidate KEYS → SCAN, K3 legacy import SCAN-only)
- **Remaining**: 0 production KEYS calls
- **Status**: RESOLVED

## Verification

```bash
grep -rn "\.keys(" mw-backend/src --include="*.ts" | grep "app\.redis\.keys"
# → No results
```

The only `Object.keys()` references remaining are JavaScript standard operations, not Redis calls.
