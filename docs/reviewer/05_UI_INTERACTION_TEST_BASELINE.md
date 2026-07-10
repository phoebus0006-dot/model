# UI Interaction Test Baseline

## 原则

UI 测试验证真实交互，不验证字符串存在。`keepPending` 字符串存在不代表 keep_pending 可用。

## Admin login smoke

`open login → fill env-backed credentials → login → dashboard visible`，并记录 pageerror、console error、401、429、5xx。禁止输出凭据。

## Review list

验证 pending/all/rejected/riskType filter；page 1/page 2；filter change resets page 1；total 与 API meta.total 一致。

## Review card 必需信息

Figure title、figureId/slug、riskType、riskReason、original evidence、current state、image count、primary image、candidate、source、dimensions、shared warning。禁止长期 title='-'、count='...'、旧 snapshot 冒充 current state。

## Candidate visual test

验证 thumbnail、preview、lightbox 可见；preview/lightbox 同资产；没有 broken direct URL；不能把 302 当成功；content-type=image/*；dimensions 与 metadata 一致；无 proxy request storm。记录 proxy requests、重复 URL 次数、429、failed resources。

## keep_pending

`open review → click keep pending → modal → reason → submit → API → status remains pending → decisionReason/reviewer/time saved → reload persists → no crawler job`

## approve_image

`before → approve → storage write → API readback → endpoint → refreshed admin → public detail verification`

## request_refetch

`click → exactly one job → double-click no duplicate → payload correct → review linked to job`

## Render stability

检查全局 render、alert 是否重建图片 DOM、blob URL 生命周期、重复 listener、stale request abort、inflight dedup、double-click disabled。

## 生产默认 smoke 为只读

只做 login/dashboard/list/filter/pagination/reload/image/lightbox。未经批准不做 approve/reject/request_refetch/keep_pending/cache purge/user modification。
