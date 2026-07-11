# ModelWiki 用户需求

## 1. 访客

访客应能以法语完成以下任务：

- 通过全局即时搜索查找 Figure、Personnage、Série 或 Fabricant；
- 从 Figurines、Series、Personnages、Fabricants、Tests & Guides、Communauté 进入浏览；
- 在 Explorer 中组合筛选并清楚看到结果数、筛选条件、排序和重置操作；
- 在 Figure detail 中阅读可靠图片、关系面包屑、简洁标题、完整原名、分组规格、Studio 内容与社区 Avis；
- 区分 Dernières fiches ajoutées、Sorties à venir 和 Dernières sorties；
- 阅读独立的 Test、Unboxing、Comparatif 与 Guide 页面。

无图、无评论或数据不足必须诚实呈现。统一 Placeholder、冷启动投稿邀请和数据阈值是体验的一部分，不得以空白、假活跃或单样本榜单替代。

注册用户可登录/退出、修改自己的密码，并管理自己的 Collection、Wishlist、Avis、个人资料和相应可见性。除有明确后续阶段的内容互动外，用户不得修改他人资料、评分、审核项或目录资料。编辑者可在授权范围内维护 Figure 的描述、规格和 Category/Series/Personnage/Fabricant/生产角色关系，并创建、预览、发布和更新 Studio 内容。审核者可处理被分配的审核项但不能伪造用户行为或提升自己的角色。管理员可管理账号状态、角色、内容可见性、审核策略、缓存与小样本 crawler 触发，并查看系统审计；密码重置走受控流程，管理员永远不可读取明文密码。

## 2. Figure detail MVP

P1 的详情页必须提供：

- `display_title` 与可展开/可见的 `original_title`/`full_name`；
- 根据 Series、Personnage、Gamme 等真实关联生成的面包屑；
- `Photos du Studio`、`Communauté`、`Photos officielles` 分来源 Gallery，标注来源类型并支持主图切换；
- 当前最佳可用图片与统一 Placeholder；
- 按 `Informations générales`、`Caractéristiques`、`Sortie`、`Production` 分组的非空规格；
- 与 Figure 结构化关联的 Phoebus Studio 内容，且与社区 Avis 分栏；
- Note générale、4 个评分维度和明确样本量；
- 登录后可用的 Collection、Wishlist、Noter、Avis 操作。

详情页不得把完整导入标题硬塞入 H1，不得将 Like、Favorite、Own、Wishlist 作为四个含义重叠的 Figure 操作，也不得把 Studio Review 与用户评论混成一个列表。

在数据存在时，详情还应展示 Fabricant、Série、Personnage、分类、产品类型、材质、比例、高度、发售日期、价格、JAN、来源链接、描述和可追踪规格。图片应支持放大、合理排序及 404 安全 fallback；未经审核的房间、展示柜、合集图或低质缩略图不得长期作为唯一主图。相关推荐必须排除当前 Figure、按 `figureId` 去重，并可依据同 Personnage、Series、Fabricant 或分类建立关系。

## 3. 注册用户与账户

P2 的账户价值为：

- Ma collection：拥有的 Figure，可逐步增加数量、备注、购入信息和可见性；
- Ma wishlist：想要的 Figure；
- Mes avis：每个用户每个 Figure 一份、可更新的评分与评价；
- Mes photos：在后续社区阶段开放的实拍管理；
- Mon profil：头像、名称、简介与真实收藏统计。

一个用户对同一 Figure 只能保留一条有效评分记录；更新必须重新计算聚合分数与样本量。收藏、Wishlist、Avis、图片上传和公开资料的可见性必须由账户所有者控制，管理员/审核者只能在明确权限范围内处理违规内容。

CollectionEntry 至少支持状态、备注、数量、购入价格、购入日期、购入渠道和可见性；P2 首屏以拥有/想要为核心，预订、售出、关注等扩展状态不得重新引入与 Wishlist 重叠的 Figure 操作。账户页应包含个人收藏、Wishlist、Avis、账号设置和可用的统计；估值、再版/价格提醒不属于当前承诺。

## 4. Explorer、搜索与首页

P3 的 Explorer 支持 Catégorie、Série、Personnage、Fabricant、Échelle、Année de sortie 等筛选。Series 与 Fabricant 选择器提供录入搜索、热门项列表和分页/异步结果，避免传统超长 <select>。移动端筛选进入抽屉或 Bottom Sheet，而非长页面垂直堆叠。价格可以存在，但不是 Wiki 的高优先级筛选。

P4 Home 的模块必须有可配置、可验证的数据来源与阈值：

- Derniers Tests 只展示已发布内容的封面、类型和页面入口，不批量加载第三方视频 iframe；
- Derniers avis 仅在达到足够真实、已发布 Avis 数量后出现；
- Les mieux notées 至少达到约定的最小样本量（产品决定前不得自行假设），并展示样本量；
- Latest Added、Upcoming、Latest Releases 使用不同的字段和排序；
- 最新条目保持有限数量并链接到完整 Explorer。

搜索必须支持 title、alias、Personnage、Fabricant、Série、JAN、MFC ID、source ID 和关键字，并允许结果继续筛选。相关推荐、搜索、facet、首页模块和公开列表必须排除隐藏实体及未达发布条件的用户内容。

## 5. 编辑、审核者与管理员

编辑者负责 Tests & Guides 的内容稿和关系维护；内容类型、发布日期、封面、正文和 Figure/Series/Personnage/Fabricant 关联必须可编辑并可审计。

审核者负责图片候选、详情冲突、用户 Avis 和用户图片的人工判断。审核界面必须同时给出原始证据和当前数据库状态，保存 action、reason、reviewer、时间与 evidence fingerprint。审核者可拒绝、隐藏、要求补充或升级处理，但不能绕过权限直接伪造用户行为。

管理员负责角色、账号状态、内容可见性、审核策略与受控发布。管理员看不到明文密码，也不得将批量数据操作当作普通 UI 操作。

管理端 Dashboard 应能查看 Figure、图片、用户、Avis/用户内容、pending/needs_changes 审核、crawler queued/running/failed、图片覆盖率和详情完整率。Figure 管理需支持搜索、编辑、查看 id/slug/关系/图片数/详情缺失与审核状态，并可跳至前台和对应审核项。主数据管理至少覆盖 Category、Fabricant、Series、Personnage 和生产角色；社区内容管理必须支持搜索、关联对象查看、隐藏或删除，并留下审计记录。

图片审核界面必须同时提供当前主图、当前图片数、完整图库、candidate 与放大预览、current vs candidate 对比、来源、尺寸、riskType、riskReason、shared candidate warning、Original Evidence 和 Current State。动作只能走 `approve_image`、`reject_image`、`keep_placeholder`、`request_refetch`、`keep_pending` 等受审计路径。详情审核必须展示当前 description、specs、缺失字段、冲突字段、原始证据、当前状态和建议动作，并使用 `mark_detail_ok`、`request_refetch`、`keep_pending`、`mark_needs_manual_edit` 处理。

## 6. 社区分期

社区不是 P1-P5 前的阻塞性社交网络。顺序为：

1. Collection、Wishlist、Rating、Avis；
2. 用户实拍、Helpful、公开收藏；
3. 关注、活动流、徽章、排名。

每一阶段上线前都要有举报、隐藏、删除、限流和审计路径。不存在足够真实内容时，页面应邀请用户贡献，而不是制造热度。

## 7. 通用验收

任何 UI 功能都不能以按钮存在、HTTP 200 或 mock 响应作为完成标准。验收必须记录操作前状态、实际操作、API 响应、持久化状态、API readback 和页面刷新后的结果；媒体和 crawler 相关操作还需验证媒体可用性或 job 状态及 writeback。未覆盖的路径应标为 `NOT TESTED`，而非默认完成。
