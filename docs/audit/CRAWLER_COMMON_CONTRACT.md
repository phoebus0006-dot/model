# crawler_common.py Contract

Generated: 2026-07-11

## Status

Compatibility reconstruction from import signatures (Phase 1). Not historical source recovery.

## Covered Interfaces

| Function/Class | Status | Tests |
|----------------|--------|-------|
| `JsonlReport` | ✅ | Append-only write, path, JSONL format, non-string values |
| `resolve_api_base(site_url=None)` | ✅ | Env var priority, trailing slash, default fallback |
| `resolve_admin_user()` | ✅ | Env var `MW_ADMIN_USERNAME`, default "admin" |
| `resolve_admin_password()` | ✅ | Env var `MW_ADMIN_PASSWORD`, default "admin" |
| `submit_review_item(api_base, headers, data)` | ✅ | URL construction, timeout, non-2xx error, JSON return |

## Mock Coverage

All HTTP calls are mocked via `unittest.mock.patch`. No real network access.

## Unverified Production Behaviors

| Behavior | Risk | Notes |
|----------|------|-------|
| Network timeout behavior | Low | Tested via mock assertion on `timeout=30` param |
| Redis unavailable in submit_review_item | Low | Not a Redis operation; sends HTTP POST to API |
| `JsonlReport` with concurrent writers | Medium | Current impl opens file once per write; concurrent NAS agent could interleave |
| `resolve_*` in Docker/cloud environment | Low | Standard env var pattern; works in any Python env |
| File path creation for nested dirs | Medium | `JsonlReport.__init__` calls `os.makedirs` — works if parent dir writable |

## Pre-production Checklist

- [ ] Run `test_crawler_common.py` in CI
- [ ] Verify `JsonlReport` path creation in restricted Docker containers
- [ ] Verify `submit_review_item` against a staging API endpoint
- [ ] Test with `MODELWIKI_ADMIN_USERNAME/PASSWORD` naming (if alternate env vars are used by NAS agent)
