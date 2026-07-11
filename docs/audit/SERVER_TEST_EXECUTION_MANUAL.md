# 服务器测试执行手册

## 前置条件

- ✅ 已登录服务器
- ✅ 已安装 Node 18+、npm、git
- ✅ 已安装或可访问 PostgreSQL
- ✅ 已确定服务器环境类型（PRODUCTION/STAGING/TEST）

---

## 1. 服务器环境取证

```bash
cd /path/to/repo
hostname > docs/audit/evidence/server-head.txt
whoami >> docs/audit/evidence/server-head.txt
date >> docs/audit/evidence/server-head.txt
uname -a >> docs/audit/evidence/server-head.txt

git rev-parse HEAD > docs/audit/evidence/server-head-commit.txt
git branch --show-current > docs/audit/evidence/server-branch.txt
git status --short > docs/audit/evidence/server-status.txt
git remote -v > docs/audit/evidence/server-remote.txt

node --version > docs/audit/evidence/server-runtime-versions.txt
npm --version >> docs/audit/evidence/server-runtime-versions.txt
python --version >> docs/audit/evidence/server-runtime-versions.txt
psql --version >> docs/audit/evidence/server-runtime-versions.txt 2>/dev/null || echo "psql not found" >> docs/audit/evidence/server-runtime-versions.txt
redis-cli --version >> docs/audit/evidence/server-runtime-versions.txt 2>/dev/null || echo "redis-cli not found" >> docs/audit/evidence/server-runtime-versions.txt
docker --version >> docs/audit/evidence/server-runtime-versions.txt 2>/dev/null || echo "docker not found" >> docs/audit/evidence/server-runtime-versions.txt

ss -lntp > docs/audit/evidence/server-listening-ports.txt
```

## 2. 环境分类

打开 `docs/audit/SERVER_ENVIRONMENT_CLASSIFICATION.md` 逐行填写。

## 3. 创建隔离测试数据库

```bash
# 方案 A：服务器已有 PostgreSQL + 有创建库权限
sudo -u postgres createdb modelwiki_migration_test -O postgres
sudo -u postgres createdb modelwiki_upgrade_test -O postgres
sudo -u postgres psql -c "CREATE USER modelwiki_test WITH PASSWORD 'test_only_password';"
sudo -u postgres psql -c "GRANT ALL ON DATABASE modelwiki_migration_test TO modelwiki_test;"
sudo -u postgres psql -c "GRANT ALL ON DATABASE modelwiki_upgrade_test TO modelwiki_test;"

# 方案 B：有 Docker
docker compose -f mw-backend/docker-compose.test.yml up -d
```

## 4. 部署测试源码

```bash
# 创建独立测试目录
mkdir -p ~/modelwiki-test
cd ~/modelwiki-test

# 从生产仓库 clone（或从本机 scp）
git clone /path/to/production/repo .  # 或 git clone <url>

# 安装依赖
cd mw-backend
npm install
```

## 5. 安全门禁 + Migration（空库）

```bash
export DATABASE_URL='postgresql://modelwiki_test:test_only_password@localhost:5432/modelwiki_migration_test'

npx tsx scripts/assert-test-database.ts 2>&1 | tee ../../docs/audit/evidence/server-test-db-gate.txt
# 输出必须包含 "test database target: ..." 且没有 "FATAL"

npx prisma validate
npx prisma generate
npx prisma migrate deploy 2>&1 | tee ../../docs/audit/evidence/server-fresh-migrate.txt

# 验证表存在
psql $DATABASE_URL -c "\dt review_*" 2>&1 | tee -a ../../docs/audit/evidence/server-fresh-migrate.txt
psql $DATABASE_URL -c "\d review_items" 2>&1 | tee -a ../../docs/audit/evidence/server-fresh-migrate.txt
psql $DATABASE_URL -c "\d review_events" 2>&1 | tee -a ../../docs/audit/evidence/server-fresh-migrate.txt
psql $DATABASE_URL -c "\d review_apply_attempts" 2>&1 | tee -a ../../docs/audit/evidence/server-fresh-migrate.txt
```

## 6. 旧 Schema 升级验证

```bash
export UPGRADE_DB='postgresql://modelwiki_test:test_only_password@localhost:5432/modelwiki_upgrade_test'

# 迁移到旧 Schema（审核前）
# 注：需要确定审核 migration 之前的最后一个 migration 名称
git stash  # 暂存审核 schema 修改
# 或者使用旧分支部署旧 migration

# 插入代表性旧数据（使用手动 SQL 或 seed 脚本）
psql $UPGRADE_DB -c "
  INSERT INTO users (email, display_name, role) VALUES ('test@test.com', 'Test User', 'admin');
  INSERT INTO figures (slug, name) VALUES ('test-figure', 'Test Figure');
  INSERT INTO figure_images (figure_id, sha256, size, format) VALUES (1, 'abc123', 'raw', 'webp');
" 2>&1 | tee ../../docs/audit/evidence/server-old-data-before.txt

# 记录旧数据数量
psql $UPGRADE_DB -c "SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM figures;" >> ../../docs/audit/evidence/server-old-data-before.txt

# 应用审核 migration
export DATABASE_URL=$UPGRADE_DB
npx prisma migrate deploy 2>&1 | tee ../../docs/audit/evidence/server-upgrade-migrate.txt

# 验证旧数据未变化
psql $UPGRADE_DB -c "SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM figures;" >> ../../docs/audit/evidence/server-old-data-after.txt
psql $UPGRADE_DB -c "SELECT * FROM users;" >> ../../docs/audit/evidence/server-old-data-after.txt
psql $UPGRADE_DB -c "SELECT * FROM figures;" >> ../../docs/audit/evidence/server-old-data-after.txt

# 验证新表存在
psql $UPGRADE_DB -c "\dt review_*" >> ../../docs/audit/evidence/server-upgrade-migrate.txt
```

## 7. 集成测试（真实 PostgreSQL）

```bash
export DATABASE_URL='postgresql://modelwiki_test:test_only_password@localhost:5432/modelwiki_migration_test'
export SKIP_DB_TESTS=false

# 运行集成测试
npx vitest run --reporter verbose src/test/integration/ 2>&1 | tee ../../docs/audit/evidence/server-test-integration.txt

# 期望结果：所有 integration 测试 PASS，0 SKIP
```

## 8. API 联调（可选——非破坏性）

```bash
# 启动测试 API 服务（独立端口）
cd ~/modelwiki-test/mw-backend
HOST=127.0.0.1 PORT=3900 NODE_ENV=test DATABASE_URL=$DATABASE_URL npx tsx src/index.ts &
TEST_PID=$!
sleep 3

# 测试健康检查
curl -s http://127.0.0.1:3900/health

# 测试 401
curl -s http://127.0.0.1:3900/api/v1/admin/review/items

# 停止测试服务
kill $TEST_PID 2>/dev/null
```

## 9. 验证清理

```bash
# 删除测试数据库（确认不再需要后）
# sudo -u postgres psql -c "DROP DATABASE IF EXISTS modelwiki_migration_test;"
# sudo -u postgres psql -c "DROP DATABASE IF EXISTS modelwiki_upgrade_test;"
# docker compose -f mw-backend/docker-compose.test.yml down -v
```

---

## Phase 3.5-H 附录：证据文件清单

所有证据文件保存到相对于仓库根目录的 `docs/audit/evidence/server/`。

| 文件 | 对应命令 |
|------|----------|
| `server35h-environment.txt` | `hostname; node --version; psql --version; docker --version` |
| `server35h-git-state.txt` | `git rev-parse HEAD; git status --short; git branch` |
| `server35h-source-checksums.txt` | `find . -type f -not -path '*/node_modules/*' -print0 \| xargs -0 sha256sum` |
| `server35h-fresh-gate.txt` | `npx tsx scripts/assert-test-database.ts` |
| `server35h-fresh-migrate.txt` | `npx prisma migrate deploy` |
| `server35h-fresh-tables.txt` | `psql $DATABASE_URL -c "\dt"` |
| `server35h-fresh-indexes.txt` | `psql $DATABASE_URL -c "SELECT ... FROM pg_indexes"` |
| `server35h-fresh-constraints.txt` | `psql $DATABASE_URL -c "SELECT ... FROM information_schema.table_constraints"` |
| `server35h-upgrade-before.txt` | 旧 Schema 升级前数据统计 |
| `server35h-upgrade-migrate.txt` | 升级 migration 执行输出 |
| `server35h-upgrade-after.txt` | 升级后旧数据对账 |
| `server35h-test-integration.txt` | `npm run test:integration` |
| `server35h-concurrency.txt` | 两独立连接并发测试 |
| `server35h-idempotency.txt` | 数据库唯一约束测试 |
| `server35h-apply-attempt.txt` | ReviewApplyAttempt 真实 PG 测试 |
| `server35h-bigint.txt` | BigInt 最大值端到端验证 |
| `server35h-npm-test.txt` | `npm run test` |
| `server35h-build.txt` | `npm run build` |
| `server35h-tsc.txt` | `npx tsc --noEmit` |
| `server35h-pytest.txt` | `python -m pytest tests/ -v` |
| `server35h-status-after.txt` | 测试完成后 `git status --short` |
| `server35h-after.patch` | 测试完成后 `git diff --no-ext-diff HEAD` |

### 退出码验证

每条命令执行后检查 `$?`。非零退出码必须在报告中记录原因。
