## Objective
EMERGENCY_UI_AND_ADMIN_RECOVERY — 恢复前台、统一后台、旧审核队列下线

## Git State
- recovery/live-ui-admin branch created from review/phase12-r4 (SHA 0320454)
- 4 commits ahead of base: frontend restore, admin unification, status enum fix, docs update
- Pushed to origin (upstream tracking set)

## Changes Made

### Restored Frontend (Phase 12 baseline a4c9d82)
- Reverted all Phase 13 index.php, page-browse.php, functions.php, main-v27.css changes
- Removed api-client.js, feature-flags.js (new Phase 13 files)
- Net: -975 lines Phase 13, +160 lines Phase 12 baseline

### Unified Admin Entry
- **Canonical:** page-admin.php + admin.js (WordPress theme admin)
- **Redirected:** guanli_index.php → 301 Moved Permanently to /admin/
- guanli_index.php replaced 1519-line standalone admin SPA with 6-line redirect

### Fixed Review State Machine
- `handleReviewStatus()`: was using PUT /items/:id (bypasses state machine)
- Now uses POST /items/:id/action with proper actions (approve_image, reject_image, request_refetch, mark_detail_ok)
- Added "Applied", "Failed", "All" filter tabs to review UI
- Added review detail modal with: type, source, target figure, risk type, candidate data (JSON), candidate images, event history, action buttons
- Added "applied", "failed" to backend REVIEW_STATUSES enum
- Applied review button still uses POST /items/:id/apply (correct behavior)
- Removed "Automation Notes" card, removed auto-recheck behavior

### Removed Phase 13 Artifacts
- Deleted frontend-api-client.test.ts (36 tests, files no longer exist)
- Phase 13 audit doc updated: frontend = NOT IMPLEMENTED

### Test Status
- 280 tests pass, 23 files, 0 failures (down from 316, removed Phase 13 test file)
- npm test, test:unit, test:contract, test:migration, test:app-startup, admin-js-check all pass
- build: 224.64 KB ESM, typecheck: 0 errors

## Remaining For READY_FOR_LIVE_UI_REVIEW
- [ ] 执行 NAS 生产环境只读检查（`git rev-parse HEAD`, `git status`, SHA256 文件哈希）
- [ ] 生产环境部署恢复分支内容
- [ ] 真实审核闭环测试（创建→列表→详情→批准/拒绝→服务器返回→持久化→刷新验证）
- [ ] 前台每页截图（桌面+移动）：首页、Browse、Search、Figure detail、Series、Manufacturers
- [ ] 后台截图：Dashboard、审核队列、审核详情、审核完成
- [ ] Credential rotation 文档更新
