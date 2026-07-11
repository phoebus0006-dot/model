# Phase 11 Production Call Chain — Final

## Component Wiring Status

| Component | Production Caller | Status |
|-----------|-----------------|--------|
| apply-handler.ts (32 KB) | routes.ts → scoped plugin → adminApplyRoute | **PRODUCTION_ACTIVE** |
| apply-lock.ts | routes.ts → preHandler (acquire) + onResponse (release) | **PRODUCTION_ACTIVE** ✅ |
| apply-errors.ts | ❌ | **DEAD** (imported by nothing) |
| apply-types.ts | ❌ | **DEAD** |
| apply-service.ts | ❌ | **DEAD** |
| apply-route.ts | ❌ placeholder | **DEAD** |
| image-security.ts | ❌ (test only) | **TEST_ONLY** |
| image-storage.ts | ❌ | **DEAD** |
| image-repository.ts | ❌ | **DEAD** |
| image-service.ts | ❌ | **DEAD** |
| apply-dependencies.ts | ❌ | **DEAD** |

## Production Apply Call Chain (final)

```
HTTP POST /review/items/:id/apply
→ auth onRequest (admin.ts global hook)
→ scoped plugin (routes.ts)
  → preHandler: status check + acquireLock (SET NX PX)
  → apply-handler.ts (existing business logic)
  → onResponse: releaseLock (Lua compare-and-delete)
→ reply.send
```

## Progress vs Goal

| Requirement | Status |
|------------|--------|
| Lock acquisition | ✅ SET NX PX with unique token |
| Lock release | ✅ Lua compare-and-delete |
| Status check before lock | ✅ pending/needs_changes only |
| Re-check after lock acquire | ❌ (handled inside preHandler before handler) |
| Business logic via service | ❌ handler.ts still 32KB |
| Image service shared | ❌ handler.ts uses inline sharp/fs |
| Dead scaffolding cleaned | ❌ 6 files still DEAD |

## Phase 12 Required

1. Replace 32KB apply-handler.ts with apply-route.ts + apply-service.ts
2. Wire image-service.ts into both images API and apply
3. Delete 6 DEAD scaffolding files
4. Add production-path tests for locked apply
