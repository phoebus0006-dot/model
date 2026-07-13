# Wave 2 Agent Contracts (FROZEN)

> **Status: FROZEN** — These contracts are the authoritative specifications for Wave 2 agents.
> **Start conditions NOT yet met.** Do not execute until all Wave 1 conditions pass.

## Wave 2 Start Conditions (ALL must be TRUE)

- [ ] repository reconciliation 已人工批准
- [ ] canonical SHA 已冻结
- [ ] User 邮箱认证恢复 (Agent A 完成)
- [ ] Guanli AdminAccount 独立认证完成 (Agent B 完成)
- [ ] Schema migration 完整 (Agent C 完成)
- [ ] clean checkout 测试基线通过 (Agent D 完成)
- [ ] Review 存储模型可用 (Agent E 完成)

**Until all above are TRUE, Agents F/G/H MUST NOT start.**

---

## Agent F: Review API 集成

**Branch:** `agent/review-api-integration`
**Wave:** 2 (first)
**Start condition:** Wave 1 complete + Review storage model available

### Tasks
1. PostgreSQL 是 Review 的唯一事实源
2. recheck 不自动关闭人工审核
3. action 写 append-only ReviewDecision
4. GET readback 返回: reviewer, decisionReason, decisionAt
5. 图片数使用 `_count.images`
6. 主图只加载一张
7. PUT 不允许直接修改 status
8. duplicate suppression 依据人工决定
9. evidence changed 时 reopen
10. request_refetch 幂等
11. 管理接口只能接受 AdminAccount 身份
12. 普通 User 邮箱 JWT 调用管理接口必须返回 401/403
13. actor 必须记录 AdminAccount.id，不是普通 User.id
14. 非法状态跳转返回 409
15. 所有 BigInt ID 返回字符串

### Required Tests
- 8 images
- recheck no mutation
- decision audit
- duplicate decided
- pending active
- reopen
- refetch idempotency
- concurrency
- ordinary User token rejected
- AdminAccount token accepted

### File Ownership
- `mw-backend/src/routes/admin.ts` (review API portions)
- `mw-backend/src/review/**`
- `mw-backend/src/domain/review/**`
- Review API tests

### Prohibited
- 修改用户认证 (Agent A/B domain)
- 修改 guanli 认证 UI (Agent H domain)
- 修改 crawler state machine (Agent G domain)

---

## Agent G: Crawler 与 NAS Agent

**Branch:** `agent/crawler-state-integration`
**Wave:** 2 (second)
**Start condition:** Agent F complete OR parallel with F (different files)

### Tasks
1. 使用统一 Crawler 状态机 (from Agent E)
2. claim 原子化
3. NAS Agent 与后端版本握手
4. Agent 启动时报告: code SHA, protocol version, hostname, agentId
5. 后端拒绝不兼容 protocol
6. completed 前必须 readback
7. 不扩大并发 (concurrency = 1)
8. 不大规模抓取生产站点
9. 所有测试使用 fixture/mocked source
10. Crawler 操作 actor 使用 AdminAccount 或明确 system actor

### File Ownership
- `mw-backend/src/crawler/**`
- `nas_crawler_agent.py`
- `test_crawler_state.py`
- crawler protocol tests

### Prohibited
- 修改用户认证
- 修改 guanli 认证
- 修改 Review API (Agent F domain)
- 连接生产数据库/Redis
- 大规模抓取生产站点

---

## Agent H: Guanli UI 集成

**Branch:** `agent/guanli-ui-integration`
**Wave:** 2 (third)
**Start condition:** Agent B (guanli admin auth) complete + Agent F (review API) complete

### Tasks
1. guanli 登录使用 username，不显示 email 输入
2. 不调用普通 `/auth/login`
3. 使用独立后台 token/session (from Agent B)
4. 登出只清除后台 session
5. 普通用户前台 session 不影响后台
6. 审核操作显示: current state, evidence, candidate, decision history
7. action 后真实 GET readback
8. 防 double-click
9. abort stale request
10. object URL 正确释放
11. 不重做整体 UI
12. 浏览器测试验证两套账号隔离

### File Ownership
- `modelwiki-theme/page-guanli.php`
- `guanli_index.php`
- `modelwiki-theme/tests/admin-ui-check.mjs`
- guanli UI tests

### Prohibited
- 修改普通用户前端页面
- 修改后端认证逻辑 (Agent A/B domain)
- 修改 Review 业务逻辑 (Agent F domain)

---

## Integrator: 受控合并

**Branch:** N/A (operates on main)
**Start condition:** All Wave 1 + Wave 2 agents complete

### Merge Order (STRICT)
1. `repository-reconciliation`
2. `frontend-email-auth`
3. `guanli-admin-auth`
4. `schema-migration-reconciliation`
5. `test-baseline`
6. `review-storage-recovery`
7. `review-api-integration`
8. `crawler-state-integration`
9. `guanli-ui-integration`
10. reviewer fixes

### Per-Merge Procedure
1. 记录 pre-merge SHA
2. 检查文件所有权 (no cross-agent file conflicts)
3. 检查 migration 冲突
4. 执行完整 gate (`node scripts/gate.mjs`)
5. 记录 post-merge SHA
6. 测试失败立即停止
7. 不继续合并下一个分支
8. 不 force push
9. 不 squash 掉必要迁移历史
10. 不提交 bundle、patch、tar.gz

### Integrator MUST NOT
- 使用旧的"全部测试通过"报告
- 跳过任何 merge 步骤
- Force push
- Squash migration history
- Commit recovery artifacts

---

## Agent R: 最终独立 Reviewer

**Branch:** N/A (fresh clone, read-only review)
**Start condition:** Integrator complete

### Reviewer MUST start from fresh clone

### Section 1: Source-of-Truth
验证: origin/main SHA, local SHA, deployment SHA, guanli deployed version, NAS Agent SHA, migration version, dirty/untracked, active worktrees, stale branches

任何不一致标记: `INCONSISTENT`

### Section 2: 账号体系验证
**普通用户:** 邮箱注册, 邮箱登录, 邮箱唯一, 邮箱规范化, 密码找回, 停用后失效, 普通用户不能访问 guanli

**后台管理员:** username 登录, 不要求 email, 使用 AdminAccount, 独立 JWT/session, 停用后失效, 改密后旧 token 失效, Admin token 不冒充普通 User

**必须实际尝试:**
1. 普通邮箱用户 token 调用后台接口 → 预期 401/403
2. guanli 管理员 token 调用普通用户身份接口 → 预期 401/403 或无普通用户身份
3. 使用普通邮箱登录信息登录 guanli → 预期失败
4. 使用 guanli username 登录普通用户入口 → 预期失败

### Section 3: 仓库验证
确认: main 无 patch, main 无 tar.gz, main 无 diff.txt, 无未解释 recovery 文件, migrations 完整, lockfile 唯一, clean checkout 可复现, 本地和远端一致

### Section 4: 测试验证
必须使用真实 disposable: PostgreSQL, Redis, temporary storage

记录每条命令: command, exit code, discovered, executed, passed, failed, skipped, duration

不得把 mock-only 标记为真实集成 VERIFIED

### Section 5: Review/Crawler 验证
实际验证: ReviewItem 持久化, ReviewDecision audit, recheck 无状态修改, duplicate suppression, reopen, real image count, request_refetch, atomic claim, illegal transition, writeback readback, concurrent actions

### Section 6: 浏览器验证
使用浏览器分别验证: 普通用户邮箱登录页, guanli username 登录页, session 隔离, 审核 action 闭环, Console error=0, pageerror=0, double-click, stale request abort, logout isolation

### Section 7: 最终状态
每项只能标记: `VERIFIED` | `PARTIAL` | `FAILED` | `NOT TESTED` | `INCONSISTENT`

### Final Conclusion
满足以下全部条件前:
- 仓库一致
- 两套账号体系正确隔离
- migrations 真实通过
- 测试数字可复现
- Review/Crawler 闭环真实通过
- 浏览器闭环通过

**最终结论必须是: `DO_NOT_DEPLOY` / `DO_NOT_ADVANCE_TO_PHASE_3`**

---

## Wave Execution Timeline

```
Wave 1 (parallel):
  Agent A (frontend-email-auth)     ─┐
  Agent B (guanli-admin-auth)       ─┤
  Agent C (schema-migration)        ─┤── after A+B contracts frozen
  Agent D (test-baseline)           ─┤── parallel with C
  Agent E (review-storage-recovery) ─┘── after canonical approved

  [GATE: Wave 1 complete + human approval]

Wave 2 (sequential/parallel):
  Agent F (review-api-integration)      ── after E
  Agent G (crawler-state-integration)   ── parallel with F (different files)
  Agent H (guanli-ui-integration)       ── after B + F

  [GATE: Wave 2 complete]

Integrator: merge in strict order (10 steps)

  [GATE: Integration complete]

Agent R: fresh clone review

  [GATE: VERIFIED or DO_NOT_DEPLOY]
```
