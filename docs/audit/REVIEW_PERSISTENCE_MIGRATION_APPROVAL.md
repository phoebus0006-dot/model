# Review Persistence Migration Approval

```
审批类型：最小数据库 Schema 与持久化迁移
不是：前端重写
不是：后端整体重写
不是：微服务拆分
```

## 1. 为什么必须迁移

当前审核系统以 **Redis 为唯一事实来源**。PostgreSQL 中**没有审核实体表**。

这意味着：
- Redis 宕机 → 所有审核条目、人工决定、审计历史**完全丢失**
- 无 ACID 事务 → apply 路由的 DB 写入和 Redis 保存无法原子化
- 无并发控制 → 两个管理员可相互覆盖决定
- 无审计查询 → 审计历史嵌在 JSON `notes` 字段中，不可查询
- 数据量无上限 → `review:items` 和 `review:decisions` 无限增长（无 TTL）

详见 `REVIEW_REDIS_DATA_INVENTORY.md`。

## 2. 当前风险

| 风险 | 等级 | 影响 |
|------|------|------|
| Redis 数据丢失 | CRITICAL (P0) | 所有审核历史不可恢复 |
| 无事务保护 | HIGH (P1) | 部分 apply 状态不一致 |
| 盲写并发覆盖 | MEDIUM (P1) | 管理员决策被静默覆盖 |
| 无审计查询 | MEDIUM (P2) | 无法回答"谁在何时做了什么" |

## 3. 推荐数据库模型

### 方案 A（推荐）：ReviewItem + ReviewEvent 两表

- `ReviewItem` — 审核条目的主表，含状态、类型、证据指纹、payload、乐观锁
- `ReviewEvent` — 事件记录表，捕获每次状态转换、操作者、原因

详见 `REVIEW_SCHEMA_CHANGE_PROPOSAL.md` §2。

## 4. Prisma Schema Diff 草案

```prisma
model ReviewItem {
  id                  BigInt    @id @default(autoincrement())
  publicId            String    @unique
  type                String    @default("general")
  title               String
  source              String?
  sourceId            String?
  status              String    @default("pending")
  priority            Int       @default(1)
  confidence          Decimal?  @db.Decimal(4, 3)
  figureId            BigInt?
  figureSlug          String?
  riskType            String?
  riskReason          String?
  suggestedAction     String?
  evidenceFingerprint String?   @unique
  reviewer            String?
  decisionReason      String?
  decisionAt          DateTime?
  appliedAt           DateTime?
  payload             Json?
  notes               String?
  version             Int       @default(0)
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  events ReviewEvent[]
}

model ReviewEvent {
  id           BigInt   @id @default(autoincrement())
  reviewItemId BigInt
  event        String
  action       String?
  fromStatus   String?
  toStatus     String
  actor        String?
  reason       String?
  metadata     Json?
  requestId    String?
  createdAt    DateTime @default(now())
}
```

## 5. 索引和约束

| 表 | 索引/约束 | 目的 |
|----|-----------|------|
| ReviewItem | `publicId UNIQUE` | 匹配 Redis ID，防重复回填 |
| ReviewItem | `evidenceFingerprint UNIQUE` | 防重复证据（松约束，可改为普通索引） |
| ReviewItem | `INDEX(status, type)` | 列表查询 |
| ReviewItem | `INDEX(figureId)` | 按 Figure 查找审核 |
| ReviewItem | `INDEX(riskType)` | 风险类型筛选 |
| ReviewEvent | `INDEX(reviewItemId, createdAt)` | 事件按时间排序 |
| ReviewEvent | `INDEX(requestId)` | 幂等键查询 |

## 6. Redis 回填范围

全部 `review:item:{id}` 和 `review:decision:{...}` keys。
不包含 `review:items`（Sorted Set，仅索引）和 `review:decisions`（同上）。

## 7. 迁移阶段（6 阶段渐进切换）

| Stage | 操作 | 风险 | 可回滚 |
|-------|------|------|--------|
| 0 | 新增表，不修改现有代码 | 极低 | ✅ |
| 1 | Dry-run + 历史回填 | 低 | ✅ TRUNCATE |
| 2 | 双写 (PG + Redis) | 中 | ✅ 环境变量回退 |
| 3 | 影子读对比 | 低 | ✅ 不影响响应 |
| 4 | PostgreSQL 主读 | 中 | ✅ 环境变量回退 |
| 5 | 停止 Redis 写 | 低 | ✅ 重新启用 |
| 6 | 最终清理 | 低 | ✅ 单独审批 |

详见 `REVIEW_MIGRATION_RUNBOOK.md`。

## 8. API 兼容性

- 现有 11 个审核 API 路由：**URL、method、响应字段、认证方式均不变**
- `guanli_index.php`：**无需修改**
- `crawler_common.py`、NAS Agent、爬虫：**无需修改**

## 9. 管理端兼容性

- 管理端通过 API 调用审核功能，不直接访问数据库
- 所有 API 响应格式在迁移阶段保持一致（通过 ReviewStore 接口抽象）
- 无浏览器 E2E 测试，需手动验证登录、审核列表、操作、apply

## 10. 回滚方案

- Stage 0: `prisma migrate down 1`
- Stage 1: `TRUNCATE review_items CASCADE`
- Stage 2-4: `REVIEW_STORE_MODE=redis` 环境变量回退
- Stage 5-6: 恢复 Redis 写入代码路径

任何阶段发现问题 → 回退到上一阶段。无需停机回滚。

## 11. 数据验证方案

迁移全程运行 `scripts/audit-review-redis.ts` + `scripts/backfill-reviews-to-postgres.ts --dry-run`：
- 回填前：记录 Redis key 总数
- 回填后：PG count ≈ Redis count
- 抽样比较：关键字段一致性

## 12. 预计修改文件

| 文件 | 修改 |
|------|------|
| `prisma/schema.prisma` | +2 models (ReviewItem, ReviewEvent) + 索引 |
| `src/modules/reviews/store-interface.ts` | (已创建) |
| `src/modules/reviews/postgres-store.ts` | 新建 — PostgresReviewStore |
| `src/modules/reviews/dual-store.ts` | 新建 — DualWriteReviewStore |
| `src/modules/reviews/repository.ts` | 重命名为 RedisReviewStore 或实现接口 |
| `src/modules/reviews/service.ts` | 依赖 ReviewStore 接口 |
| `src/modules/reviews/routes.ts` | (未来) 使用 store |
| `scripts/backfill-reviews-to-postgres.ts` | 新建 |
| `src/test/*` | 新增 Store 实现和 mode 测试 |

## 13. 禁止自动执行的操作

- ❌ 不执行 `prisma migrate deploy`（需手动审批后执行）
- ❌ 不回填生产数据（需 Stage 1 审批）
- ❌ 不切换默认读写路径（Stage 0-1 默认仍为 Redis）
- ❌ 不删除 Redis 数据（Stage 6 需单独审批）
- ❌ 不修改现有 Prisma 模型
- ❌ 不修改 admin.ts 中的 11 个审核路由

## 14. 审批结果（Phase 3.6）

```
用户已选择 B：
批准新增审核持久化表、正式 migration 文件、测试数据库验证和 dry-run；
暂未批准生产回填、生产双写、主读切换或 Redis 数据删除。
```

## 15. Phase 3.6 执行情况

| 操作 | 状态 |
|------|------|
| 新增 `ReviewItem` + `ReviewEvent` 模型 | ✅ 已添加至 `prisma/schema.prisma` |
| 生成 additive migration SQL | ✅ 已审查，纯 CREATE + 索引 + FK |
| PostgresReviewStore 事务实现 | ✅ 含乐观锁 version + ReviewEvent 同事务写入 |
| 幂等支持 | ✅ ReviewEvent.requestId 唯一索引 |
| dry-run 回填脚本 | ✅ `scripts/audit-review-redis.ts`（只读 SCAN） |
| Redis → DTO 解析模块 | ✅ `src/modules/reviews/migration/` |
| 数据对账模块 | ✅ `reconciliation.ts` |
| 测试 | ✅ 134 tests, 13 files, ALL PASS |
| 默认 Store mode | 保持 `redis`（未切换） |
| 生产回填 | ❌ 未执行 |
| 生产双写 | ❌ 未启用 |
| PostgreSQL 主读切换 | ❌ 未执行 |
| Redis 数据删除 | ❌ 未执行 |
