# Regression and Release Gate

## Gate 0 Repository

remote main known；worktree understood；secret scan；typecheck；tests；admin JS syntax check。

## Gate 1 Security

无 admin cache FLUSHDB/FLUSHALL；SSRF tests；file validation；signing tests；authz tests；log secret check。

## Gate 2 API Contract

frontend/agent endpoints exist；production contract matches expected；persistent status schema correct；pagination correct；禁止 N+1 的路径无回归。

## Gate 3 Admin UI

login、dashboard、review list、filters、pagination、reload、current image、candidate、lightbox，且 pageerror=0、429=0、5xx=0。

## Gate 4 Review Workflow

真实 canary：keep_pending、一个 image action、一个 detail action、request_refetch idempotency。生产写测试需明确批准。

## Gate 5 Crawler

仅在需要发布 crawler 时：exact canary job、状态时间线、真实 writeback、review state、无 queue-wide consumption。

## Gate 6 Public Product

homepage、list、search、detail、related、image zoom、匿名浏览、登录动作、collection、comments、related review article。

## Release decision

- APPROVE：当前 scope gates 全通过
- APPROVE WITH KNOWN LIMITATION：仅非安全/非数据完整性/非闭环限制
- REQUEST CHANGES：security gap/source inconsistency/missing evidence/broken interaction/state inconsistency/data risk
- BLOCK RELEASE：credential leak/destructive cache or data op/unauthorized access/uncontrolled crawler/production white screen/severe corruption
