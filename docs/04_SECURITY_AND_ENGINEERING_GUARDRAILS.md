# 安全与工程约束

## 1. 凭据、权限与隐私

禁止在聊天、报告、Git、示例或测试回退中输出/提交密码、password hash、token、cookie、Authorization header、JWT secret、`.env`、DB dump、SSH key 或真实个人资料。所有凭据经环境变量和安全 secret 管理。

角色至少区分 visitor、user、editor、moderator/reviewer、admin。公开读取、本人账户写入、编辑内容、审核决定和管理员配置必须使用服务端权限校验，不能靠前端隐藏按钮。管理员不得查看明文密码；账号、角色、密码与安全配置的变更需要明确授权和审计。

Collection、Wishlist、Avis、用户图片和 Profile 默认按所有者与可见性控制。公开端不得暴露私有收藏、隐藏内容、内部审核证据、草稿、IP/设备信息或不必要的用户数据。

## 2. 社区与搜索防滥用

登录、注册、重置密码、搜索建议、评分、Avis、Helpful、收藏写入、举报和上传都需要按用户/IP/资源的 rate limit、输入长度与格式校验、幂等/去重以及 abuse 日志。对 Avis、用户图片和公开资料需有举报、隐藏、删除、申诉/复核与审计路径。

评分 API 必须保证 `(userId, figureId)` 唯一，更新为受控 upsert；聚合只使用 published/eligible 记录。不得允许客户端提交聚合分数、样本量、审核状态、所有者 id 或内容关联 id。

全局搜索和 Explorer 的查询必须参数化、分页、限制复杂度并避免向未授权用户泄露隐藏实体。Facet、自动建议与首页榜单必须遵守同一发布/可见性规则。

## 3. 外部媒体与上传

外部图片 fetch 仅允许 http/https；每个重定向 hop 都要做 DNS/IP 检查，阻止 loopback、私网、link-local、metadata IP、IPv6 ULA 和 IPv4-mapped IPv6 私网地址，并限制重定向和响应大小，优先采用业务 allowlist。

上传必须执行 decoded size limit、真实格式探测、允许格式白名单、服务端 hash、路径 containment、临时写入与原子 rename；客户端 hash 不符应拒绝。用户图片和 candidate asset 需要稳定 identity，审核、预览、批准和最终显示不得指向不同资产。

## 4. 数据、迁移与发布

Figure title、法语字段、Fabricant canonicalization/aliases、Category、Personnage、内容关联、Favorite/Like 语义和账户模型的变更都属于数据迁移。必须提供 schema migration、索引、可追溯 backfill、冲突报告、dry-run、canary、readback 和回滚/补救方案。不得手工改生产 DB 模拟成功。

发布新页面或 API 前必须明确目标/当前基础/已验证状态，完成权限、迁移、关键法语路径、空状态/Placeholder、排序语义、审核 readback、限流和错误监控检查。Home 模块（Derniers avis、Les mieux notées 等）仅当达到产品定义的真实数据阈值后才显示；冷启动阶段显示贡献邀请而非伪装活跃。未验证功能不得以文档、mock 或 HTTP 200 宣称完成。

所有批量操作遵循：dry-run -> 统计 -> reviewer 审核 -> canary -> 小批量 -> 验证 -> 再扩大。禁止 DELETE ALL、TRUNCATE、FLUSHDB、无 dry-run 的批量 archive、大规模 crawler、手工改 job status 或以 mock 冒充生产。

## 5. 审核与 UI 约束

审核决定必须保存 reviewer、reason、time、证据、当前状态和 fingerprint。自动规则可以偏召回，但不能覆盖人工决定；状态和证据变化时才按 reopen 规则重新进入队列。

前台和管理端改动应局部、可验证、可回退。禁止未经批准重做登录/管理 UI、删除审核字段、隐藏核心 action、用提高 rate limit 掩盖请求风暴或为局部修复整体回退页面。避免双击、inflight 重复请求、过期请求和媒体 URL 生命周期泄漏。

## 6. Git 与事实来源

禁止 report-only commit 冒充功能修复、patch 代替源码、force push（除安全泄露且经授权）、提交 operational data 或含敏感信息的临时证据。每轮改动保持小范围并有真实 diff、相关检查和审查。

GitHub main、生产 backend、生产管理端和 NAS Agent 必须可对账；任何版本漂移都标记为 `SOURCE STATE = INCONSISTENT`，先对账再扩大开发或发布。

## 7. 操作授权与验证状态

执行者不得擅自改管理员用户名或密码、创建替代管理员绕过验证、修改 JWT secret 或输出 password hash。账号安全变更必须由明确授权触发，并保留操作者、原因、时间和结果的审计。

验收证据只能写为 `VERIFIED`、`PARTIAL`、`FAILED`、`NOT TESTED` 或 `INCONSISTENT`：`VERIFIED` 要求代码、运行结果和业务状态一致；其余分别表示闭环不足、真实失败、无真实证据、或报告/代码/API/DB/统计冲突。不得将 created/queued、按钮、payload、sourceType、report 更新或手工 DB 状态偷换为真实完成。

## 8. 细化网络与文件边界

外部 fetch 的每个重定向 hop 都必须执行 DNS A/AAAA 与连接目标检查，并防 DNS rebinding；除既有 IP 范围拦截外，还要限制响应大小、超时与重定向次数。上传须在既有格式/哈希/路径规则外，必要时规范化或重新编码；任何审核、预览、批准和最终显示必须绑定同一 candidate/media identity。

Crawler job 必须保留真实状态机 `created -> queued -> claimed -> running -> completed | failed | deferred` 和结果 writeback。处理审核队列或生产数据时，禁止粗暴清空；旧项只能先分类、统计并保留可复核证据。

## 9. UI 与请求生命周期

前台和管理端只能做局部、可验证、可回退的改动。禁止未经批准重做管理后台或登录布局、删除已有审核字段、隐藏核心 action、为局部修复整体回退页面，或通过提高 rate limit 掩盖请求风暴。交互必须防 double-click、inflight 重复请求和过期请求；媒体 URL 有明确生命周期；避免全量 render 重发大量图片请求，并在验收中确认浏览器 console `pageerror=0`。
