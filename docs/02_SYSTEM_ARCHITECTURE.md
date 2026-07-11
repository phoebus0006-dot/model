# ModelWiki 系统架构

## 1. 当前基础与目标边界

当前仓库由 WordPress Theme（`modelwiki-theme/`）、管理端（`guanli_index.php`）、TypeScript API（`mw-backend/`）、PostgreSQL、Redis 与 NAS/Browser Agent 组成。现有人工审核、图片/详情风险、候选资产、证据与人工决定是数据质量基础；它们需要持续验证，不应被表述为所有目标模型均已落地。

目标架构保持 WordPress 适合编辑和展示内容的优势，由 API/数据库承担结构化目录、账户、权限、评分、收藏、审核与关联关系。PostgreSQL 是长期业务与审计事实来源；Redis 仅用于 cache、rate limit、短期队列和锁，关键审核决定不得仅留在 Redis。

Crawler/NAS Agent 用于受控冷启动、明确缺失、管理员 request_refetch 和小规模来源更新。它不得成为前台业务中心，也不得覆盖人工确认数据。

## 2. 目标领域模型

### Catalog 与本地化

目标 Figure 模型至少区分：稳定 id/slug、`display_title`、`original_title`/`full_name`、语言化展示字段、发布信息、规格、状态和来源。展示层优先使用法语字段/字符串；导入原文保留为证据，不能用英文回退悄悄混入法语界面。

目标实体包括 Category、Series、Personnage、Fabricant、Gamme/产品线以及可选生产角色。Personnage 是 P0 即应建立的正式实体，通过关系表连接 Figure；导航是否展示不改变该数据要求。

Fabricant 目标模型包含 canonical record、canonical name、native name、slug、country 和 alias records。导入、搜索和合并以 canonical id 为准；0 商品实体需要可见性/生命周期状态，不能默认进入公共聚合结果。Category 也应有统一 canonical 命名和关系约束。

### Media、内容与关系

`FigureImage`/媒体模型需要稳定身份、来源类型（Photos du Studio / Communauté / Photos officielles）、hash、尺寸、审核状态、排序与安全展示信息。Gallery API 按来源分组，并从已审核资产中选择当前最佳主图；缺图统一返回可识别的 Placeholder 状态（Logo + "Photo bientôt disponible"）。

编辑内容模型至少包含 type（如 Test、Unboxing、Comparatif、Guide d'authenticité、Guide collectionneur、Customisation & 3D）、标题、语言、状态、封面、正文/外部视频引用、作者和发布日期。通过显式 relation 表连接 Figure、Series、Personnage、Fabricant。Customisation & 3D 仅当实际制作过该产品的改装/3D 内容时才存在关联，不得自动生成。Studio 内容与社区 Avis 是不同域模型和不同发布规则。

### 账户与社区

目标账户模型以 CollectionEntry、WishlistEntry、Rating/Avis、UserPhoto 和 Profile 为核心，而不是 Figure Like/Favorite。Rating/Avis 对 `(userId, figureId)` 施加唯一约束，包含整体评分、Sculpture、Visage、Peinture、Rapport qualité-prix、文本、状态和修改时间。聚合结果保存或可计算为总分、维度均值和样本量。

旧 Favorite 到 Wishlist、旧 Like 到内容 Helpful/Like 的迁移必须有显式映射、回滚方案和用户可理解的结果；不允许无记录地删除或混合语义。

## 3. API 与页面契约

公共 API 应提供：

- 全局即时搜索与建议，覆盖 Figure、Series、Personnage、Fabricant；
- Explorer 的结构化筛选、排序、分页、结果数和 facet/候选值；
- Figure detail，返回关系面包屑、display/original 标题、分组 Gallery、规格、Studio 关联和社区评分摘要；
- 三种明确的列表语义：Latest Added、Upcoming、Latest Releases；
- 内容详情与按实体反查的关联内容。

认证 API 应提供幂等或去重的 Collection、Wishlist、Rating/Avis 操作及账户读取。所有写操作需要会话、所有权校验、输入校验和审计；公开收藏和用户图片只在用户选择公开且通过相应审核后返回。

管理员/审核 API 需要角色校验、最小字段暴露、决策原因、证据、当前状态、fingerprint 和 readback。搜索、列表和公开详情不得泄露被隐藏的用户内容、内部审核证据、草稿或管理字段。

## 4. 迁移与发布策略

新增模型须通过可回滚的 schema migration、索引、数据 backfill 和 feature flag 分阶段发布。对 title、manufacturer、category、personnage、收藏语义和内容关系的迁移先 dry-run 并记录映射/冲突/未处理项，再 canary、小批量、readback，最后扩大。

法语本地化应有字符串清单与覆盖检查。Home、Explorer 和榜单的阈值、排序字段和发布时间状态必须在 API 层明确，不得只靠 Theme 临时判断。

发布前需验证：migration 可运行、公开 API 契约、权限拒绝路径、审核 readback、法语关键路径、空状态/Placeholder、缓存失效和监控。未验证能力只能标为目标或在建。

## 5. 审核与数据流

图片和详情风险进入 ReviewItem，保存风险类型、原始证据、当前状态快照、candidate identity、action、reviewer、reason、time 与 evidence fingerprint。人工决定高于自动规则；同一 Figure/risk/fingerprint 的决定可抑制重复项，状态、图片集、候选或相关详情改变时允许 reopen。

受信来源可以自动补全后接受基础校验；冲突、不确定来源、社区上传和可疑图片必须进入人工审核。任何“批准”都必须可追溯到审核者实际看到并确认的同一媒体身份。

## 6. 当前实现映射与服务职责

| 层 | 当前位置/服务 | 必须承担的职责 | 不应承担的职责 |
| --- | --- | --- | --- |
| Public Frontend | `modelwiki-theme/` | Home、Browse/Search、Figure 与实体页、账户页、CMS 内容呈现 | 以 Theme 临时判断定义业务状态、权限或列表语义 |
| Admin / Reviewer | `guanli_index.php` | 管理员登录、Dashboard、Figure、Review、用户与 Job 查看 | 为重构而破坏稳定 UI，或绕过 API 直接伪造业务结果 |
| API / Domain | `mw-backend/`（Prisma schema + TypeScript source） | Auth、结构化目录、图片服务、审核、crawler job、账户/社区 API、业务校验 | 把访问控制或事实来源下放给客户端 |
| PostgreSQL | 业务数据库 | Figure 主数据、关系、媒体、用户、收藏、Avis、内容关联、审核决定和长期审计 | 被 Redis 或临时文件替代为最终事实来源 |
| Redis | cache、rate limit、短期队列、短锁 | 加速和短生命周期协调 | 单独保存关键人工决定或长期审计 |
| NAS / Browser Agent | `nas_crawler_agent.py` | 浏览器抓取、小规模 refetch、冷启动采集、图片获取、job claim 与结果写回 | 作为长期前台业务中心或覆盖人工确认数据 |

## 7. 模块与持久化契约

Identity & Access 负责注册、登录、改密、角色、账号状态、session/token 与审计。角色至少为 visitor、user、editor、moderator/reviewer、admin；权限只能由 API 服务端校验。

Catalog 除目标模型外还应保持 aliases、product kind、分类、Fabricant（含 canonical name、native name、slug、country、alias records）、Series、Personnage、生产角色、发售、价格、比例/材质/高度和 source identity。规格按 `Informations générales`、`Caractéristiques`、`Sortie`、`Production` 分组。每个新本地化字段或关系应有稳定 id、来源和变更记录，不能仅靠展示文字建立事实。

Media 需维护 primary image、gallery、来源 metadata、dimensions、hash、质量/审核 flag、安全展示信息与缩略图/详情派生图。候选媒体链严格为：

```text
source URL -> browser/NAS fetch -> review cache -> server validation
-> candidateAsset identity -> ReviewItem -> preview/lightbox -> approve -> FigureImage
```

审核者预览的 candidate、批准的 candidate 和最终写入的媒体必须是同一稳定 identity，禁止审核 A 而展示或写入 B。

ReviewItem 至少持久化 `id`、`figureId`、`riskType`、`status`、`source`、`riskReason`、`originalEvidence`、`currentStateSnapshot`、`candidateAssetId`/`candidateImage`、`createdAt`、`updatedAt`、`lastAction`、`reviewerId`、`decisionReason`、`decisionAt`、`evidenceFingerprint`。持久化状态只能是 `pending`、`needs_changes`、`resolved`、`rejected`、`archived`；`all` 只可作为查询参数。

## 8. 数据来源、指纹与 crawler 状态机

官方厂商、可信零售商和验证过的结构化来源可经基础校验自动写入；社区上传、不确定来源、共享候选及疑似房间、展示柜、合集或横幅图必须先审核。详情的可信结构化来源可自动写入，冲突、稀疏或异常值进入 detail review。

Fingerprint 应由 `figureId + riskType + primaryImageId + sorted(imageIds) + candidateAssetHash + 风险相关详情字段` 的稳定哈希构成，且不得依赖会过期的 signed URL。同 Figure、risk 和 fingerprint 的既有人工决定必须 suppress；fingerprint 改变、已批准图片删除/失效或当前状态恶化可 reopen。

Crawler job 必须严格流转：

```text
created -> queued -> claimed -> running -> completed | failed | deferred
```

created 不等于已执行，queued 不等于 completed，HTTP 200 或 payload 正确不等于数据正确或审核闭环。冷启动与稳定运营都必须小批、可追踪；稳定期只用于新增导入、明确缺失、管理员 request_refetch、少量来源更新和验证。

## 9. 实施与读写边界

公共详情、搜索和列表 API 只读已发布且对当前请求者可见的数据，并返回结构化分页、结果数、facet/候选值和明确的排序字段；认证写 API 对 Collection、Wishlist、Rating/Avis 使用会话、所有权校验、输入校验与幂等/去重。评分聚合只计算符合发布规则的记录，客户端不能提交聚合分数、样本量、审核状态、所有者或实体关系 id。

Admin/Review API 使用角色校验和最小字段暴露，保存 action、reason、reviewer、time、evidence、current state、fingerprint，并在写入后提供 readback。搜索、facet、自动建议、首页榜单和公开详情都不得泄露隐藏用户内容、内部审核证据、草稿或管理字段。新 schema 与 backfill 必须包含索引、映射/冲突/未处理项报告、dry-run、canary、readback 与回滚或补救路径。
