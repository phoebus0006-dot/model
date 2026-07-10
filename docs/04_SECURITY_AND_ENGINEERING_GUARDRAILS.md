# 安全与工程约束

## 1. 凭据

禁止：

- 在聊天输出密码
- 在报告输出密码 hash
- 提交 token
- 提交 cookie
- 提交 Authorization header
- 提交 JWT secret
- 提交 .env
- 提交 DB dump
- 提交 SSH key
- 在 example 文件中写真实值
- 在 test.sh 使用真实密码 fallback

所有凭据通过环境变量或安全 secret 管理。

---

## 2. 管理员账号约束

执行器不得：

- 修改管理员用户名
- 擅自修改管理员密码
- 创建替代管理员绕过验证
- 修改 JWT_SECRET
- 输出 password hash

账号安全变更必须由用户明确授权。

---

## 3. 生产操作约束

禁止：

- DELETE ALL
- TRUNCATE
- FLUSHDB
- 清空 review queue
- 批量 archive 未 dry-run
- 批量 crawler
- 大规模抓 MFC
- 手工改 DB 模拟成功
- 手工改 job status
- mock 冒充生产

所有批量变更必须：

1. dry-run
2. 统计
3. reviewer 审核
4. canary
5. 小批量
6. 验证
7. 再扩大

---

## 4. 安全边界

### SSRF

外部图片 fetch 必须：

- allow http/https only
- DNS resolve A/AAAA
- block loopback
- block private IP
- block link-local
- block metadata IP
- block IPv6 ULA
- block IPv4-mapped IPv6 private
- validate every redirect hop
- limit redirect count
- business allowlist preferred
- prevent DNS rebinding

### File Upload

必须：

- decoded size limit
- real image format detection
- allowed formats only
- server-side hash
- client hash mismatch reject
- normalize/re-encode if needed
- path containment
- no traversal
- temp write
- atomic rename

---

## 5. Reviewer 证据等级

允许状态：

- VERIFIED
- PARTIAL
- FAILED
- NOT TESTED
- INCONSISTENT

### VERIFIED

代码、运行结果、业务状态一致。

### PARTIAL

部分完成，闭环不足。

### FAILED

真实验证失败。

### NOT TESTED

没有真实执行证据。

### INCONSISTENT

报告、代码、API、DB、统计互相矛盾。

---

## 6. 禁止状态偷换

禁止：

- queued 当 completed
- created 当 executed
- 按钮存在当闭环
- HTTP 200 当业务正确
- payload 正确当 crawler 完成
- API sourceKind 正确当视觉质量通过
- report 更新当代码修复
- mock 当生产结果
- DB 手工状态当真实业务流程

---

## 7. UI 稳定性约束

禁止执行器未经批准：

- 重做管理后台 UI
- 修改登录布局
- 删除已有审核字段
- 隐藏核心 action
- 为局部修复整体回退页面
- 用提高 rate limit 掩盖请求风暴

必须：

- 局部更新
- 防 double-click
- inflight dedup
- abort stale request
- 图片 URL 生命周期管理
- Console pageerror=0
- 避免全量 render 重新发大量图片请求

---

## 8. Git 约束

禁止：

- report-only commit 冒充功能修复
- patch 文件代替源码
- force push，除非明确处理安全泄露并经授权
- rewrite history 作为普通开发手段
- 提交 operational data
- 提交临时 evidence 文件含敏感数据

每轮：

- small scope
- real diff
- tests
- commit
- push main
- Reviewer 审查

---

## 9. Source-of-Truth 约束

必须保持：

- GitHub main
- production backend
- production guanli
- NAS agent

版本可追踪。

如果存在漂移：

→ SOURCE STATE = INCONSISTENT

先对账，再开发。
