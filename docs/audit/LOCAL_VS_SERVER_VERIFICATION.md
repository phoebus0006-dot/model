# Local vs Server Verification

## Test Results Summary

| Suite | Local (no PG) | Server (with PG) | Notes |
|-------|---------------|-------------------|-------|
| `npm run test` | ✅ 144/144 (14 files) | — | 本地全部非 PG 测试通过 |
| `npm run test:unit` | ✅ 68/68 (7 files) | — | 纯函数 + 无外部依赖 |
| `npm run test:contract` | ✅ 39/39 (3 files) | — | Fastify inject + skipLifecycle |
| `npm run test:migration` | ✅ 13/13 (1 file) | — | SQL 文件静态分析 |
| `npm run test:integration` | ⏸️ SKIP (2 files, 11 tests) | ⚠️ 需服务器执行 | 需要真实 PostgreSQL |
| `npm run build` | ✅ | ✅ 确认 | tsup ESM build |
| `npx tsc --noEmit` | ✅ Exit 0 | ✅ 确认 | Typecheck |
| `npx prisma validate` | ✅ Schema valid | ✅ 确认 | |
| `npx prisma generate` | ✅ Client generated | ✅ 确认 | |
| `npm run admin-js-check` | ✅ ALL PASS | ✅ 确认 | |

## Source Code Audit Results

| Check | Status | Detail |
|-------|--------|--------|
| PUT /review/items/:id 状态机绕过 | ✅ FIXED | 6 forbidden fields → 422 |
| BigInt Number() 全仓库 | ✅ 0 REMAINING | 8/8 处已修复为 `String(id)` |
| ReviewApplyAttempt Schema | ✅ ADDED | 19 fields, additive |
| Migration SQL review | ✅ ADDITIVE ONLY | 3 tables + indexes + FK |
| Redis KEYS | ✅ 0 PRODUCTION KEYS | All replaced with scanKeys |
| Store mode default | ✅ redis | 未改变 |

## Server Verification Checklist

### Required (Phase 3.5-H complete gate)

- [ ] 服务器环境分类文档填写
- [ ] 源码对账（本地 vs 服务器 HEAD）
- [ ] 独立测试目录部署
- [ ] 隔离测试数据库创建
- [ ] 安全门禁通过

### PostgreSQL Migration

- [ ] 空库 `prisma migrate deploy` 成功
- [ ] ReviewItem, ReviewEvent, ReviewApplyAttempt 表存在
- [ ] 索引 + 约束存在
- [ ] 旧 Schema 升级验证
- [ ] 旧数据无变化

### PostgreSQL Integration Tests

- [ ] `npm run test:integration` 全部通过
- [ ] PostgresReviewStore CRUD ✅
- [ ] ReviewApplyAttempt 状态转换 ✅
- [ ] 事务回滚验证 ✅
- [ ] 两独立连接并发 ✅
- [ ] Idempotency key 唯一约束 ✅
- [ ] BigInt 最大值 `9223372036854775807` ✅

### Optional (WordPress/API)

- [ ] 测试 API 独立端口启动
- [ ] 只读 GET 接口验证
- [ ] 管理端审核列表浏览

## Evidence Files

各测试输出文件路径见 `docs/audit/evidence/`。
