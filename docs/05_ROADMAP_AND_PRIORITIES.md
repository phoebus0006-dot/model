# ModelWiki 开发路线与优先级

## 持续性基础：可信数据与发布门槛

人工审核、证据、candidate identity、decision audit、重复抑制、reopen、权限、数据安全和 source-of-truth 对账是全阶段前提。它们是当前已在建的数据质量基础，必须继续做真实闭环验证；不替代下列产品阶段，也不能被扩大 crawler 所取代。

## P0：数据与语言基础

目标：让目录和法语体验成为后续页面可依赖的事实来源。

- 完整清点并统一法语字符串：Header、Footer、Search、Explorer、筛选、排序、详情、规格、Avis、账户、认证、邮件、校验与错误；
- Fabricant canonicalization 与 aliases，处理重复、native/英文变体和 0 商品实体；
- 统一 Category 名称/关系；Personnage 作为 P0 正式实体提前建立数据模型和 Figure 关系表；
- 定义 `display_title` 与 `original_title`/`full_name` 的导入、展示与回退规则；
- 建立统一 Placeholder 与图片来源/优先级契约；
- 明确并实现 Latest Added、Upcoming、Latest Releases 的字段和排序语义；
- 为内容关联和后续账户模型准备可迁移的数据契约。

## P1：详情页 MVP

目标：一张 Figure 页足以支持可靠浏览和收藏决策。

- 真正的关系面包屑；
- display title、original title 与简洁主信息；
- `Photos du Studio`、`Communauté`、`Photos officielles` 分来源 Gallery、主图优先级和统一 Placeholder；
- 按 `Informations générales`、`Caractéristiques`、`Sortie`、`Production` 分组的非空 Specifications；
- Studio 内容与社区 Avis 分离；
- 1 个总评分 + 4 个维度，并显示样本量；
- 登录用户可进入 Collection、Wishlist、Noter、Avis 流程的页面契约。

## P2：账户与收藏

目标：注册获得清晰、可持续的价值。

- Ma collection、Ma wishlist、Mes avis、Mon profil；
- 每用户每 Figure 一份可更新的 Rating/Avis；
- Favorite 到 Wishlist、figure Like 到内容互动的受控语义迁移；
- 收藏/愿望清单的权限、可见性、审计和个人统计；
- 为后续 Mes photos 保留模型与审核边界，但不抢先建设完整社交网络。

## P3：Explorer 与搜索

目标：把目录从数据库筛选器变成探索体验。

- 全局即时搜索 Figure、Personnage、Series、Fabricant；
- Explorer 筛选、chips、排序、结果数、重置和移动端筛选抽屉；
- Catégorie、Série、Personnage、Fabricant、Échelle、Année 等结构化筛选；
- Series/Fabricant 选择器提供录入搜索、热门项列表和分页/异步结果，避免传统超长 <select>；
- Personnages 按数据成熟度进入导航或 Explorer，但实体关系已在 P0 建立。

## P4：首页

目标：用真实数据引导探索，而不是以长列表或伪活跃填充页面。

- Hero + 全局搜索，Hero 使用实拍形象和副标题（如 "Explorez les figurines. Comparez les versions. Partagez votre avis."）；
- Explorer par catégorie（视觉分类卡片：Prize Figures、Scale Figures、Nendoroid、Action Figures、Resin & GK）与 Univers populaires（如 One Piece、Dragon Ball、Naruto、Demon Slayer、Hatsune Miku）；
- Derniers Tests par Phoebus 的封面和内容入口；
- 达到真实数据阈值后再显示 Derniers avis 与 Les mieux notées；
- 清晰命名的 Latest Added/Upcoming/Latest Releases 小型模块并链接 Explorer；
- 不在首页批量加载第三方视频 iframe。

## P5：Tests & Guides 内容体系

目标：沉淀可检索、可关联、可持续发布的 Studio 内容。

- Test、Unboxing、Comparatif、Guide d'authenticité、Guide collectionneur、Customisation & 3D 的独立内容页；
- 内容状态、法语字段、封面、作者、发布日期与 Figure/Series/Personnage/Fabricant 结构化关系；
- Figure 页关联内容、内容列表和编辑工作流；
- 只有实际测试或制作过的产品才显示相关 Studio/3D 信息。

## P5 之后：深化社区

先扩展用户实拍、Helpful 与公开收藏，再考虑关注、活动流、徽章、成员排行等社交能力。所有社区功能以真实内容、审核、举报、限流、隐私和审计为上线条件。

## 当前明确不应优先做

- 扩大 crawler 并发或大规模 MFC 抓取；
- 大规模自动 archive 或绕过人工审核；
- 在 P0 前重做首页或把视觉设计当作数据问题的替代；
- 重做整个管理后台 UI；
- 复杂 AI 图像模型替代人工审核；
- 复杂推荐算法、大规模微服务拆分或为未来扩展过度设计；
- 在没有真实 Avis/评分/内容数据时伪造社区活跃或榜单。

产品优先级保持不变：P0 数据/语言 -> P1 详情页 MVP -> P2 账户收藏 -> P3 Explorer+搜索 -> P4 首页 -> P5 内容体系 -> 社区深化。

## 全阶段执行门槛

每个阶段发布前均需验证：服务端角色/所有权拒绝路径、可回滚 schema migration、dry-run/backfill/冲突报告、canary/readback、关键法语路径、Placeholder/空状态、缓存失效、限流与错误监控。审核与 crawler 还必须具有操作前状态、真实动作、持久化、API readback、刷新结果以及必要的媒体或 job 验证；没有这些证据的能力只能标为目标或 `NOT TESTED`。

P0 的导入和 canonicalization 不得把 0 商品实体、重复 Fabricant/Category 或未经审查内容暴露给公共导航、搜索 facet 或首页聚合。P1 还验收图片放大与安全 fallback、相关推荐排己和按 figureId 去重、公开 API 不泄露草稿/审核证据/隐藏用户内容，以及 Studio、Avis、图片审核状态彼此独立。

P2 的 CollectionEntry 可逐步记录数量、备注、购入价格、日期、渠道与可见性；旧 Favorite/Like 数据迁移必须有映射、审计、回滚/补救和用户可理解结果，不能直接删除或混合语义。P3 的查询需参数化、分页、限制复杂度和可见性过滤，且覆盖 title、alias、Personnage、Fabricant、Série、JAN、MFC ID、source ID 与关键字。

P4 模块只读取明确的 API 字段和已发布状态，不能让 Theme 临时判断定义业务语义，图片优先使用安全、已审核且可稳定展示的资产。P5 保持 WordPress 负责内容编辑与呈现，API/DB 负责 `articleId`、实体关系和内容类型等结构化事实；发布、更新和关系变更均可审计。

任何阶段均不得未经授权修改管理员账号/密码或安全密钥、将 Redis 当作长期审核/业务事实来源、以手工 DB/job 状态代替真实流程，或以 HTTP 200、按钮、mock、report 或 queued job 宣称已发布/完成。
