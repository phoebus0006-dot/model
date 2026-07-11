# 内容治理与人工审核

## 1. 角色与原则

机器负责发现风险、保留证据、建议动作和有限自动补全；人工负责判断可接受性、解决冲突、决定发布或拒绝。人工决定是最终兜底，但必须有理由、身份、时间、当前状态和可复核的证据。

当前审核治理是新产品的数据基础：它保护 Gallery、规格、Studio 内容和未来用户贡献的可信度。它不意味着新详情页、账户、内容系统或社区已经上线。

## 2. 图片与详情审核

图片风险包括缺图、低数量、低质量、缩略图、房间/展示柜/合集图、宣传图、不可信来源、共享候选或 candidate mismatch。审核页必须显示 Figure 标识与标题、当前主图和图库、候选放大预览、来源、尺寸、风险理由、原始证据和当前状态。

允许的人工动作至少包括 `approve_image`、`reject_image`、`keep_placeholder`、`request_refetch`、`keep_pending`。图片少于自动阈值不等于不能发布：一张内容相关、质量足够、来源可信或人工确认且稳定可显示的图片可以被 resolved。

详情审核处理 description、规格、分类、Fabricant、发布日期及来源冲突。UI 必须区分 Original Evidence 和 Current State；旧 snapshot 不能长期冒充当前事实。动作包括 `mark_detail_ok`、`request_refetch`、`keep_pending`、`mark_needs_manual_edit`。

## 3. 决策记忆与 reopen

ReviewItem/Decision 至少保留 figure、risk type、candidate identity、原始证据、当前状态、action、status、reviewer、decision reason、decision time 与 `evidenceFingerprint`。

同一 figure + risk type + fingerprint 已有人工 resolved/rejected/keep 决定时，自动扫描不得生成同一审核项。以下情况允许 reopen 或新建项：主图变化、图片集合变化、批准图片删除/失效、候选变化、相关详情字段变化或人工明确 reopen。fingerprint 不得依赖会过期的 signed URL。

## 4. Studio、Avis 与用户图片

Phoebus Studio 的 Test、Unboxing、Comparatif、Guide d'authenticité、Guide collectionneur 和 Customisation & 3D 是编辑内容；社区 Avis 是用户评价，两者必须分开呈现、存储和审核。Customisation & 3D 仅当实际制作过该产品的改装/3D 内容时才显示关联，不得自动生成。Studio 内容与 Figure/Series/Personnage/Fabricant 的关联必须是结构化关系，不能仅留在文章正文。

社区 Avis 可包含一份总体评分、4 个维度、文字和后续实拍。用户对一个 Figure 只有一份可更新的 Avis/Rating。公开前应支持 pending、published、hidden、removed 等明确状态；聚合评分只计算符合发布规则的记录，并显示样本量。

用户实拍、Avis、Helpful、公开收藏按社区阶段上线。每类用户贡献必须有举报入口、限流、反垃圾策略、审核/隐藏动作和审计；被隐藏或删除的内容不得继续出现在搜索、详情聚合或首页模块。

## 5. 内容发布与冷启动

Tests & Guides 的每篇内容（Test、Unboxing、Comparatif、Guide d'authenticité、Guide collectionneur、Customisation & 3D）须拥有独立页面、编辑状态、语言、类型、作者/来源、发布日期、封面和结构化关联。首页只展示已发布且有合法封面的内容，不批量嵌入第三方播放器。

社区模块和评分榜单需要产品定义的最小真实数据阈值。阈值未达到时显示贡献邀请或隐藏模块；不得以 0/1 条内容、单个评分或测试数据伪装社区活跃。

Latest Added、Upcoming 和 Latest Releases 需要由后端明确数据来源和排序语义，审核者可追溯异常条目的状态和来源。

## 6. 审计闭环

任何审核或发布动作的证据最少为：操作前状态 -> action/API 响应 -> 持久化状态 -> API readback -> 页面刷新结果。涉及图片还需确认媒体 endpoint、HTTP status、content type、尺寸和必要的视觉检查。

旧队列不得粗暴清空。先 dry-run 分类为 still exists、already fixed、duplicate review、figure missing 或 insufficient evidence，再记录 before/classification/after 统计并保持总和自洽。

## 7. 来源分级、视觉标准与状态证据

Tier 1 是官方或明确可信的结构化来源，可自动写入或在基础校验后发布；Tier 2 是可信零售商，可自动补全但在来源冲突时必须进入审核；Tier 3 是社区上传、用户图片和不确定来源，必须以 candidate 进入人工视觉判断。自动规则可偏向召回，例如少于三张图创建风险项；人工接受规则可以更严格或更灵活，但不得被后续扫描反向覆盖。

视觉审核必须将候选归类为 normal product image、thumbnail、room photo、display case、collection photo、promotional banner、unrelated 或 uncertain。不得只凭 `sourceKind`、宽高、URL 域名或图片数量推断视觉质量。候选媒体必须保持稳定 identity：审核者看到、批准和最终展示的资产完全一致；资产替换需留下审计，并在适用时 reopen。

证据状态只能标记为 `VERIFIED`、`PARTIAL`、`FAILED`、`NOT TESTED` 或 `INCONSISTENT`。`VERIFIED` 要求代码、运行结果与业务状态一致；其余分别表示闭环不足、真实验证失败、无真实执行证据、或报告/代码/API/DB/统计矛盾。不得把 created/queued、按钮、HTTP 200、payload、sourceType、mock 或手工 DB 状态表述为完成。

## 8. Crawler 与发布闭环

Crawler 相关审核还需验证 `queued -> running -> completed/failed/deferred`、结果 writeback 和最终 review state；仅创建 job 或收到 payload 不构成完成。旧队列分类后的处置为：still exists 保留、already fixed archive、duplicate 保留最有价值项并 archive 其余、figure missing archive、insufficient evidence 保留。
