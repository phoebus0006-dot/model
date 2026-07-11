# Global Review Checklist

## A. Repo / Build

- remote main SHA
- local HEAD/worktree
- untracked files
- dependency/package-lock diff
- build
- typecheck
- tests
- admin JS syntax check
- secret scan current refs
- operational data leak check

## B. Source-of-truth

- repo vs production API
- guanli artifact provenance
- NAS agent parity
- frontend endpoint map
- agent endpoint map

## C. Auth/Authz

- public/admin endpoint boundary
- role enforcement
- disabled user behavior
- password change behavior
- token invalidation strategy
- no admin secret in frontend JS

## D. Figure data

- source/source_id dedup
- JAN normalization
- `display_title` 面向用户、`original_title`/full_name 保留原始可追溯名称；不得用一个字段混用两种目的
- title/slug uniqueness
- category/product_kind separation；分类名称和前端 France locale 一致
- material mapping
- Manufacturer 使用 canonical entity：`canonical_name`、`native_name`、`aliases`、slug；重复实体和 0 产品实体的处理有可审计规则
- Series/Personnage/Figure 的真实关系可读回；不得以字符串猜测关系来伪造 breadcrumb 或筛选结果
- Latest/"nouveautes" 的排序字段、筛选条件和文案语义一致：录入时间、发售日期、未来发售不得混称
- 内容实体（Test、Unboxing、Comparatif、Guide 等）与 Figure 的关联可创建、读取和删除，并有 canonical source/权限边界
- manual edits protected from crawler overwrite

## E. Images

- source trust tier
- SSRF
- redirect validation
- real format validation
- server-side hash
- path containment
- duplicate detection
- `sourceType` 可追溯且与实际来源 Tab/标签一致（Studio、Communauté、officielle 等）
- primary image selection 使用最佳可用图片，不假设所有 Figure 都已有 Studio 图片；优先级和 fallback 可测试
- 无图时使用统一设计的 placeholder，不把加载失败或空白冒充内容
- candidate identity
- preview/lightbox identity
- browser visibility

## F. Review workflow

- review dedup
- evidenceFingerprint
- human decision persistence
- keep_pending
- decisionReason/reviewer/time
- per-risk recheck
- original evidence vs current state
- action idempotency
- request_refetch concurrency
- unchanged evidence suppression

## G. UI

- login
- dashboard
- review list
- filters
- pagination
- filter resets page
- current image
- candidate image
- compare/lightbox
- keep_pending modal
- row loading
- double-click protection
- pageerror=0
- 429=0
- no request storm
- France locale 全字符串：Header、Footer、搜索、Explorer/Browse、filters、sort、详情、规格、Collection、Wishlist、Avis、账户、登录注册、密码校验、错误和邮件激活流程；不得出现混合英法字符串
- Figure 详情：`display_title` 可见，`original_title` 仍可访问；breadcrumb 从真实 Series/Personnage/Figure 关系生成；规格按 Informations generales/Caracteristiques/Sortie/Production 分组，空字段不渲染
- Gallery：来源 Tab/标签和图片 `sourceType` 相符，最佳可用主图可见，placeholder 可见且可访问
- Studio Test/Review 与社区 Avis 为独立区域、独立数据源和独立动作，不能混成同一 comments 列表

## H. Community

- like idempotency
- Favorite 到 Wishlist 有明确兼容、迁移或清退方案；不得在未说明策略时让旧数据静默丢失或双写漂移
- Collection/Wishlist 添加、删除、重复提交幂等；跨用户读取、修改和删除均被拒绝
- 一个用户每个 Figure 仅一条可编辑 rating/avis；总分加 4 个维度，详情展示聚合分数和样本数
- avis auth/create/edit/delete、评分更新、admin moderation、rate limit、output escaping
- admin moderation
- collection privacy/state transitions
- personal metadata validation

## I. Editorial content

- article draft/publish
- article ↔ Figure
- article ↔ Series/Manufacturer/Character
- editor permission
- related article display

## J. Operations

- namespace-safe cache purge
- no FLUSHDB/FLUSHALL
- logs no secrets
- backup/dry-run/canary before batch
