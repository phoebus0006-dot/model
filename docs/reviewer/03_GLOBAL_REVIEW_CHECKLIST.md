# Global Review Checklist

## A. Repo / Build

- remote main SHA
- local HEAD/worktree
- untracked files
- dependency/package-lock diff
- build
- typecheck
- tests
- admin JS syntax check
- secret scan current refs
- operational data leak check

## B. Source-of-truth

- repo vs production API
- guanli artifact provenance
- NAS agent parity
- frontend endpoint map
- agent endpoint map

## C. Auth/Authz

- public/admin endpoint boundary
- role enforcement
- disabled user behavior
- password change behavior
- token invalidation strategy
- no admin secret in frontend JS

## D. Figure data

- source/source_id dedup
- JAN normalization
- title/slug uniqueness
- category/product_kind separation
- material mapping
- manufacturer/series/character relations
- manual edits protected from crawler overwrite

## E. Images

- source trust tier
- SSRF
- redirect validation
- real format validation
- server-side hash
- path containment
- duplicate detection
- primary image selection
- candidate identity
- preview/lightbox identity
- browser visibility

## F. Review workflow

- review dedup
- evidenceFingerprint
- human decision persistence
- keep_pending
- decisionReason/reviewer/time
- per-risk recheck
- original evidence vs current state
- action idempotency
- request_refetch concurrency
- unchanged evidence suppression

## G. UI

- login
- dashboard
- review list
- filters
- pagination
- filter resets page
- current image
- candidate image
- compare/lightbox
- keep_pending modal
- row loading
- double-click protection
- pageerror=0
- 429=0
- no request storm

## H. Community

- like idempotency
- favorite idempotency
- comment auth/edit/delete
- admin moderation
- collection privacy/state transitions
- personal metadata validation

## I. Editorial content

- article draft/publish
- article ↔ Figure
- article ↔ Series/Manufacturer/Character
- editor permission
- related article display

## J. Operations

- namespace-safe cache purge
- no FLUSHDB/FLUSHALL
- logs no secrets
- backup/dry-run/canary before batch
