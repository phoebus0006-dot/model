# ModelWiki Reviewer Baseline

本目录是独立 Reviewer、测试执行器和发布审查的长期基线。它回答：怎么审、怎么测、什么证据才算完成、当前有哪些已知风险。它以《ModelWiki 网站改版方案》为产品路线依据，但不把路线图描述成已实施功能。

## 使用顺序

1. 先读 `docs/00_PRODUCT_VISION.md` 至 `docs/05_ROADMAP_AND_PRIORITIES.md`。
2. 再按顺序阅读本目录 `00` 至 `11`。
3. 每次新会话先重新确认 GitHub、生产 API、生产 guanli、NAS agent 和本地工作区状态。
4. 执行器报告只是 claim，不是 evidence。

## 核心原则

- Reviewer 不是主执行器。
- 不把 queued 当 completed，不把 created 当 executed。
- 不把按钮存在当闭环，不把 HTTP 200 当业务正确。
- 不把 API metadata 当视觉质量通过。
- 安全、人工审核可靠性、数据完整性优先于开发速度。
- Crawler 主要服务冷启动和少量后续补全，不是长期产品中心。
- crawler canary 只在 crawler、导入、补数或其写回链路相关的变更中触发；通用发布不以 crawler 执行为前置条件，详见 `07_CRAWLER_CANARY_PROTOCOL.md`。

## 当前审查优先级

- `P0 数据质量与法语`：France locale 全字符串完整性；Manufacturer 标准化；Personnage、分类、Latest 语义；无图 placeholder；数据关系和内容关联的正确性。
- `P1 Figure 详情页`：`display_title`/`original_title`、真实关系 breadcrumb、规格分组与缺失字段隐藏、Gallery 来源和主图选择、Studio 内容与社区 Avis 分离。
- `P2 Collection / Wishlist / Avis`：权限与幂等性；每用户每 Figure 一条可编辑评分/avis；总分、4 个维度和样本数；Favorite 到 Wishlist 的兼容或清退策略。
- 后续：Explorer/Search、首页、Tests & Guides 内容体系、用户照片和社区深化。它们仍应按本目录的证据、人工审核和生产安全要求审查。

## 持续适用的协议

- 证据状态和闭环标准：`02_EVIDENCE_AND_STATUS_STANDARD.md`。
- 人工审核、候选图片和详情审核的既有规则：`00_REVIEWER_BOOTSTRAP.md`、`03_GLOBAL_REVIEW_CHECKLIST.md`。
- crawler 专项 canary：`07_CRAWLER_CANARY_PROTOCOL.md`。
- 生产变更、数据修复、缓存及紧急停止：`08_PRODUCTION_CHANGE_SAFETY_PROTOCOL.md`。

## 状态枚举

`VERIFIED` / `PARTIAL` / `FAILED` / `NOT TESTED` / `INCONSISTENT`
