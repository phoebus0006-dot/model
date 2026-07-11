# Build and Test Baseline

| Metric | Phase 1 Start | Phase 1 End | Phase 2 End |
|--------|---------------|-------------|-------------|
| Metric | Phase 1 Start | Phase 1 End | Phase 2 End | Phase 3 End |
|--------|---------------|-------------|-------------|-------------|
| Metric | Phase 1 Start | Phase 1 End | Phase 2 End | Phase 3 End | Phase 3.5 End | Phase 3.6 End |
|--------|---------------|-------------|-------------|-------------|---------------|---------------|
| Test count | 22 | 22 | 41 | 64 | 91 | 134 |
| Test files | 3 | 3 | 6 | 7 | 10 | 13 (prev + postgres-review-store, migration-full, migration-safety) |
| JS tests | 22 | 22 | 41 | 64 | 91 | 134 |
| Python tests | 0 | 0 | 17 | 17 |
| Production KEYS | 12 | 12 | 5 (admin.ts) | 0 (all eliminated) |
| `npm run build` | N/A | ✅ | ✅ |
| `npx tsc --noEmit` | N/A | ✅ | ✅ |
| `npm run admin-js-check` | N/A | ✅ | ✅ |
| Python `py_compile` | N/A | ✅ | ✅ |

## Test Files

| File | Tests | Type | Depends On |
|------|-------|------|------------|
| `src/test/app-contract.test.ts` | 8 | HTTP contract | `skipLifecycle: true` |
| `src/test/admin-contract.test.ts` | 8 | Admin auth + cache purge | `skipLifecycle: true` |
| `src/test/cache-service.test.ts` | 10 | Unit (scanKeys, CacheService) | None |
| `src/test/bigint.test.ts` | 2 | JSON serialization | None |
| `src/test/review-contract.test.ts` | 10 | Review items API contract | `skipLifecycle: true` |
| `src/test/review-cache.test.ts` | 3 | Review items cache contract | `skipLifecycle: true` |
| `tests/test_crawler_common.py` | 17 | Mock HTTP, JsonlReport | None |

## Build Commands

```bash
npm run test        # 41 JS tests, all pass
npm run build       # tsup — ESM build success
npx tsc --noEmit    # Typecheck passes
npm run admin-js-check  # Admin.ts JS syntax check passes
cd /repo && python -m pytest tests/ -v  # 17 Python tests pass
```
