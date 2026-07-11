# ModelWiki 产品愿景

## 1. 产品定位

ModelWiki 的目标是从数据库列表升级为可探索的手办百科。用户应能从 Figurines、Series、Personnages、Fabricants、分类和内容入口持续发现，而不只按商品编号检索。

每个 Figure 页面同时是收藏决策页：它应帮助用户理解实物、版本差异、可靠图片、规格、Phoebus Studio 是否测试过，以及社区如何评价。注册的价值必须明确：管理 Collection 和 Wishlist、评分、发布 Avis、后续上传实拍并形成个人收藏主页。

产品主语言为法语。完整本地化是 P0，而非视觉润色：导航、筛选、排序、规格、账户、认证、邮件、校验与错误信息不得混用法语和英语。其他语言可以作为后续能力，但不能削弱法语主体验。

## 2. 信息架构

目标桌面导航为：

- Figurines
- Series
- Personnages
- Fabricants
- Tests & Guides
- Communauté

右侧提供全局即时搜索、语言入口与账户入口；点击 ModelWiki Logo 返回 Home，Home 不占用独立导航项。

`Personnages` 是正式实体，在 P0 阶段即应建立数据模型并通过关系表连接 Figure。即使数据覆盖或导航空间不足时暂放在 Figurines/Explorer 内，数据模型也不应等待。一级导航是否展示可按数据成熟度渐进。

搜索不是一个多步骤文字导航。桌面端由搜索图标展开全局搜索，移动端提供固定入口；搜索覆盖 Figure、Personnage、Series 和 Fabricant，并在输入时给出可选结果。

## 3. 页面原则

### Figure detail

详情页优先于首页，是用户从搜索、内容或外部短视频进入后的核心落点。它使用简洁的 `display_title` 作为视觉标题，并保留 `original_title`/`full_name` 以呈现导入的完整原名。面包屑必须来自真实关系，例如 Series -> Personnage -> Figure，不得用猜测的文本拼接替代。

图片采用“当前最佳可用”的优先级：Phoebus Studio 高质量实拍、可信高质量社区实拍、官方产品图、统一 Placeholder。Gallery 按来源分为 `Photos du Studio`、`Communauté`、`Photos officielles`，每个图标注来源类型并支持主图切换；没有图片时显示统一的 Placeholder（Logo + "Photo bientôt disponible"），而不是加载失败文本。

规格按 `Informations générales`、`Caractéristiques`、`Sortie`、`Production` 分组，只显示真实存在字段；空组不显示。Studio 的测试、Unboxing、Comparatif 或 Guide 与社区 Avis 分离：前者是编辑内容，后者是用户贡献。

Figure 的核心行为是 `Je la possède`（Collection）、Wishlist、Noter 与 Avis。旧 figure Like/Favorite 不应与这些收藏意图并存；迁移时 Favorite 应映射或引导到 Wishlist，Like 保留给 Avis 或 Studio 内容等可被点赞的内容对象。

评分初期固定为一份用户评分：1 个 Note générale 加 4 个维度（Sculpture、Visage、Peinture、Rapport qualité-prix）。聚合评分必须显示样本量，不能仅显示数值。

### Explorer、Home 与内容

Explorer 是浏览界面而非后台筛选器。桌面端使用左侧筛选、结果 Grid、筛选 chips 与排序；移动端使用 Filters 抽屉或 Bottom Sheet。可筛选 Catégorie、Série、Personnage、Fabricant、Échelle 和 Année de sortie。Series 与 Fabricant 的选择器应提供录入搜索、热门项和分页/异步结果，而非传统超长 <select>。

Home 的首要 CTA 是全局搜索。Hero 区域使用 Phoebus Studio 实拍形象而非运营 Banner，副标题如 "Explorez les figurines. Comparez les versions. Partagez votre avis."。目标模块依次为 Hero + Search、Explorer par catégorie（视觉分类卡片，如 Prize Figures、Scale Figures、Nendoroid、Action Figures、Resin & GK）、Univers populaires（如 One Piece、Dragon Ball、Naruto、Demon Slayer、Hatsune Miku）、Derniers Tests par Phoebus（含 TEST/UNBOXING/COMPARATIF/GUIDE 类型标签）、社区模块、榜单、Dernières fiches ajoutées。社区与榜单都必须满足真实数据阈值；冷启动时使用诚实的投稿邀请（如 "Partagez votre expérience — Vous possédez une figurine ? Notez-la et partagez votre avis avec la communauté."），不伪装活跃。

Tests & Guides 是长期差异化内容，而不是直接嵌入一排短视频。每篇 Test、Unboxing、Comparatif、Guide d'authenticité、Guide pour collectionneurs、Customisation & 3D 都有独立页面和结构化关联。Customisation & 3D 仅当 Phoebus Studio 实际制作过该产品的改装或 3D 内容时才显示，不得为每个 Figure 自动生成"3D 打印台"入口。只有实际测试过的 Figure 才显示相关 Studio 内容。

## 4. 数据与内容原则

- Fabricant 使用 canonical entity、slug、native name、country 和 aliases；导入时用 aliases 归并，不能让同一厂商因大小写、英文或日文名称重复出现。
- 0 商品实体必须被隐藏、合并、标记待处理或从可浏览入口排除，不能污染导航和筛选。
- Category 命名和层级统一，避免同义重复。
- `Dernières fiches ajoutées`（按录入时间）、`Sorties à venir`（未来发售）与 `Dernières sorties`（已发售）是不同语义，API、后台和页面不得混用“nouveautés”。
- Personnages、Series、Fabricants 与编辑内容都应是可关联实体；内容关系必须可追踪，不能只依赖富文本链接。

## 5. 产品边界

ModelWiki 不以商城、复杂推荐算法或完整社交网络为当前目标。社区先服务于真实收藏、评分和 Avis，之后才增加实拍、Helpful、公开收藏、关注、动态、徽章和排行。

数据质量治理仍是产品可信度的前提：机器发现风险，人工结合原始证据与当前状态作决定。Crawler 仅是可控的数据补全工具，不是内容质量的最终来源。

## 6. 可信资料的决策规则

- 自动规则负责发现风险、保留来源和提出候选；人工负责接受性、来源冲突和发布决定。自动任务不得在没有明确版本/变更策略时覆盖人工确认的字段或媒体。
- 官方厂商、明确可信的零售商和已验证结构化来源可在基础安全校验后自动补全；社区上传、不确定来源、共享候选、疑似房间/展示柜/合集图和宣传横幅必须进入人工审核。
- 图片数量低于机器阈值只表示需要检查。一张与商品相关、清晰、来源可信或经人工确认且可稳定显示的图片，允许作为已解决结果；反过来，来源标签、尺寸或 URL 域名都不能单独证明视觉质量。
- 同一 Figure、风险类型和未变化证据已存在人工决定时，后续扫描必须抑制重复项。主图或图片集合变化、已批准媒体删除/失效、候选变化、相关详情变化或人工明确 reopen 时，才可重新进入审核。
