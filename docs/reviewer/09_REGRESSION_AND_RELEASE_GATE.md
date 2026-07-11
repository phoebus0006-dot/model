# Regression and Release Gate

## Gate 0 Repository

remote main known；worktree understood；secret scan；typecheck；tests；admin JS syntax check。

## Gate 1 Security

无 admin cache FLUSHDB/FLUSHALL；SSRF tests；file validation；signing tests；authz tests；log secret check。

## Gate 2 API Contract

frontend/agent endpoints exist；production contract matches expected；persistent status schema correct；pagination correct；禁止 N+1 的路径无回归。

当 scope 涉及 P0 时，额外验证 France locale 字符串和错误状态、Manufacturer canonical/native/alias 关系、Personnage/分类/Latest 语义以及内容实体与 Figure 的 referential integrity。

## Gate 3 Admin UI

login、dashboard、review list、filters、pagination、reload、current image、candidate、lightbox，且 pageerror=0、429=0、5xx=0。

## Gate 4 Review Workflow

真实 canary：keep_pending、一个 image action、一个 detail action、request_refetch idempotency。生产写测试需明确批准。

## Gate 5 Crawler

仅在 scope 发布 crawler、导入、补数或 crawler 写回链路时：exact canary job、状态时间线、真实 writeback、review state、无 queue-wide consumption。其他发布不要求 crawler canary，也不得把 queued job 当 release evidence；执行细则见 `07_CRAWLER_CANARY_PROTOCOL.md`。

## Gate 6 Public Product

按 scope 应用以下门禁，而不是要求尚未实施的路线图功能：

- `P1 Figure detail`：`display_title`/`original_title`、真实关系 breadcrumb、规格分组和缺失隐藏、Gallery sourceType/来源 Tab/最佳主图或 placeholder、Studio 内容与社区 Avis 分离、Figure 关联内容。
- `P2 Collection/Wishlist/Avis`：匿名与跨用户权限、添加/删除幂等、Favorite 迁移策略、每用户每 Figure 一条可编辑 avis、总分加四维聚合和样本数。
- 后续 Explorer/Search、首页、内容和社区 scope：验证相应的导航、筛选、搜索、数据阈值/冷启动空态和权限闭环。

仍适用的基础 smoke：homepage、list、search、detail、related、image zoom、匿名浏览和登录动作（仅对本次变更覆盖的页面执行）。

## Release decision

- APPROVE：当前 scope gates 全通过
- APPROVE WITH KNOWN LIMITATION：仅非安全/非数据完整性/非闭环限制
- REQUEST CHANGES：security gap/source inconsistency/missing evidence/broken interaction/state inconsistency/data risk
- BLOCK RELEASE：credential leak/destructive cache or data op/unauthorized access/uncontrolled crawler/production white screen/severe corruption

数据修复、缓存、生产 UI 和紧急停止仍按 `08_PRODUCTION_CHANGE_SAFETY_PROTOCOL.md` 执行；发布报告的证据状态仍按 `02_EVIDENCE_AND_STATUS_STANDARD.md`。
