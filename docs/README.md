# ModelWiki 产品与架构基线文档

本目录定义 ModelWiki 的产品方向、目标架构和不可突破的工程约束。它适用于 OpenCode、Trae、Hermes 与人工开发者；执行任何功能、数据或发布操作前都应先阅读。

## 当前状态

ModelWiki 正从“可查询的商品数据库”升级为法语优先的手办百科、收藏决策页和社区。Personnage 作为 P0 正式实体，Fabricant canonicalization、统一 Placeholder、Latest/Upcoming/Releases 语义区分与法语全量本地化构成数据与语言基础。人工审核、证据留存与重复审核抑制是现有数据质量基础，部分能力已在建并必须持续以真实闭环验证；它们不是前台产品路线的替代品。

下列前台能力均为目标，除非文档明确标为“当前基础”或有独立验收证据，否则不得将其描述为已经上线：完整法语本地化、重构详情页、Collection/Wishlist、即时搜索、首页内容模块、Tests & Guides 与社区深化。

## 阅读路线

1. `00_PRODUCT_VISION.md`
   - 产品定位、信息架构、语言与数据原则
2. `01_USER_REQUIREMENTS.md`
   - 访客、账户、编辑与管理员的页面和行为需求
3. `02_SYSTEM_ARCHITECTURE.md`
   - 当前服务映射、目标数据模型、API/DB/Redis 边界、媒体与迁移契约
4. `03_CONTENT_GOVERNANCE_AND_REVIEW.md`
   - 证据、来源分级、人工审核、reopen、内容发布与社区治理
5. `04_SECURITY_AND_ENGINEERING_GUARDRAILS.md`
   - 身份权限、滥用防护、上传/外链媒体、迁移、发布与操作红线
6. `05_ROADMAP_AND_PRIORITIES.md`
   - 唯一的产品阶段顺序和暂不优先事项

Reviewer / QA 基线仍在：`docs/reviewer/README.md`。

## 最高级原则

ModelWiki 不是“爬虫采集展示站”。它是：

> 可探索的手办百科 + 收藏决策工具 + 可持续内容体系 + 有审核边界的社区。

爬虫只服务于冷启动、明确缺失和受控 refetch；它不得决定产品优先级，也不得覆盖人工确认内容。

发生冲突时，按以下顺序决策：

1. 本目录确认的产品方向与 `05_ROADMAP_AND_PRIORITIES.md` 的阶段顺序；
2. 内容安全、人工审核和数据可信原则；
3. 权限、隐私、数据完整性与发布约束；
4. 当前架构边界；
5. 单次执行器报告或临时实现。

执行器报告、按钮存在或 mock 结果都不能覆盖产品基线或构成上线证据。每个可交付能力至少以操作前状态、真实操作、服务端响应、持久化状态、API readback 和刷新后的页面结果构成闭环；涉及媒体时还须验证实际 endpoint、HTTP status、content type、尺寸和必要的视觉检查。
