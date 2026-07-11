# Carry-Over Backlog

Generated: 2026-07-11

| ID | Module | Issue | Risk | Blocking | Plan Phase |
|----|--------|-------|------|----------|------------|
| B1 | PostgreSQL | Server migration validation not executed (no Docker/psql locally) | Migration unverified on real PG | WAITING_SERVER_VALIDATION | Phase 3.5-H (async) |
| B2 | PostgreSQL | PostgresReviewStore integration tests not run on real PG | Store untested against actual DB | WAITING_SERVER_VALIDATION | Phase 3.5-H (async) |
| B3 | PostgreSQL | Two-connection concurrency test not run | Concurrency safety unproven | WAITING_SERVER_VALIDATION | Phase 3.5-H (async) |
| B4 | PostgreSQL | BigInt max value not verified end-to-end on real PG | Precision safety unproven | WAITING_SERVER_VALIDATION | Phase 3.5-H (async) |
| B5 | Review apply | Full Saga compensation not implemented | Partial failures not recoverable | NON_BLOCKING | Phase 5+ |
| B6 | Review apply | ReviewApplyAttempt not wired into apply flow | Saga tracking not active | NON_BLOCKING | Phase 5+ |
| B7 | Review | 6 Number() conversions in admin.ts response DTOs still risk BigInt precision for IDs > 9e15 | Precision loss for very large IDs | NON_BLOCKING | Phase 5 |
| B8 | Review | review:archive has no write path — ZCARD is read-only | Stats may be inaccurate | NON_BLOCKING | Phase 5 |
| B9 | Redis | No TTL on review:item:* or review:decision:* keys | Unbounded growth | NON_BLOCKING | Phase 5+ |
| B10 | Admin | 11 review routes still in admin.ts (being extracted in Phase 4) | Architecture debt | NON_BLOCKING | Phase 4 |
| B11 | Security | Password strength check in admin.ts uses `isValidPassword` but no min-length for non-admin user creation | Weak passwords allowed | NON_BLOCKING | Phase 5 |
