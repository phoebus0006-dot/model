# Known Risks and Open Questions

## P0 / 数据质量与法语

### France locale completeness
需对 Header、Footer、搜索、Browse/Explorer、filters、sort、详情、规格、账户、登录注册、密码校验、错误和邮件激活做运行时全字符串审计。禁止英法混用和缺失翻译键。状态：`NOT TESTED`。

### Canonical catalog entities
Manufacturer 的 `canonical_name`、`native_name`、`aliases`、重复合并及 0 产品实体处理规则尚未验证；Personnage 实体、分类规范和 Figure 关系的 source-of-truth 也未确认。状态：`REVIEW REQUIRED`。

### Latest semantics
"Dernieres fiches ajoutees"、"Dernieres sorties" 和 "Sorties a venir" 的排序字段、空/未来日期规则尚未定稿。状态：`REVIEW REQUIRED`。

### Content-to-Figure relation
Tests、Unboxings、Comparatifs、Guides 与 Figure 的 canonical relation、下线行为和编辑权限未验证。状态：`NOT TESTED`。

## P0 / Existing Operational Risks

### Source provenance
生产 guanli artifact 与 repo source SHA 不同，build/minify/deploy chain 是否可复现待确认。状态：`NOT VERIFIED`。

### NAS agent drift
repo agent 与 NAS agent 不一致。状态：`INCONSISTENT`。不要直接同步启动，先支持 exact canary claim。

### Crawler closure
queued jobs 尚未证明执行和 writeback。状态：`NOT TESTED`。

### Cache purge safety
确认后台 cache purge 不会 FLUSHDB/FLUSHALL，也不会碰 review/crawler/session/rate-limit keys。状态：`REVIEW REQUIRED`。

### Review cache signing
独立 secret、no fallback、TTL、timing-safe compare、path safety。状态：`REVIEW REQUIRED`。

### SSRF
DNS resolution、IPv6、redirect validation、rebinding。状态：`REVIEW REQUIRED`。

### Candidate asset identity
必须证明 `review candidate = preview = lightbox = approved asset = official FigureImage`。状态：`REVIEW REQUIRED`。

## P1

### Detail-page data presentation
`display_title`/`original_title` 的数据迁移、真实 breadcrumb、规格分组/空字段隐藏、Gallery `sourceType`、来源 Tab、最佳主图和 placeholder 都尚未证明已实施。Studio 内容与社区 Avis 的完全隔离同样待验证。状态：`NOT TESTED`。

### Human decision memory
需要 evidence fingerprint、suppression、reopen rule。

### request_refetch concurrency
需要 per-review lock、atomic job/review linking、double-click protection。

### Review current state
确认 current Figure data、original evidence、current state 分离，避免 stale snapshot 误导审核员。

## P2 / Collection, Wishlist and Avis

### Collection model
需明确 one Figure one state、group 与 status 是否共存、quantity 语义、公开默认值，以及跨用户授权和请求幂等。状态：`REVIEW REQUIRED`。

### Wishlist and Favorite transition
Favorite 到 Wishlist 必须选择并记录兼容层、可回滚迁移或明确清退策略；旧入口、历史数据和 API 客户端在过渡期的读写规则尚未验证。状态：`REVIEW REQUIRED`。

### Rating and Avis uniqueness
需验证 `(user, Figure)` 唯一约束、可编辑记录、总分加四维范围、聚合样本数、删除/编辑重算及审核策略。状态：`NOT TESTED`。

## 后续产品扩展问题

### Review article model
明确 WordPress article 是否为 canonical content source、backend relation table、article taxonomy、editor workflow。

### Search architecture
是否引入专用搜索引擎应根据真实数据规模决定，不提前过度设计。

### Explorer, homepage and community data thresholds
Explorer/Search、首页和社区模块应在相应 scope 审查。首页的社区 Avis 和最高评分模块需要真实数据阈值与冷启动空态，不得伪造活跃或让 1 个评分进入榜单。状态：`REVIEW REQUIRED`。
