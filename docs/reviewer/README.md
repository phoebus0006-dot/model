# ModelWiki Reviewer Baseline

本目录是独立 Reviewer、测试执行器和发布审查的长期基线。它回答：怎么审、怎么测、什么证据才算完成、当前有哪些已知风险。

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

## 状态枚举

`VERIFIED` / `PARTIAL` / `FAILED` / `NOT TESTED` / `INCONSISTENT`
