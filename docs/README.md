# ModelWiki 产品与架构基线文档

本目录是 ModelWiki 的产品、架构和工程约束基线。

任何 OpenCode / Trae / Hermes / 人工开发者在修改项目之前，都应先阅读这些文档。

## 文档目录

1. `00_PRODUCT_VISION.md`
   - 产品定位
   - 核心用户
   - 产品边界
   - 已确认业务决策

2. `01_USER_REQUIREMENTS.md`
   - 访客、注册用户、编辑者、管理员需求
   - 收藏、点赞、评论、评测内容需求
   - 前台页面需求
   - 管理后台需求

3. `02_SYSTEM_ARCHITECTURE.md`
   - 当前系统映射
   - 推荐目标架构
   - 模块边界
   - 数据与审核流转
   - Crawler 冷启动定位

4. `03_CONTENT_GOVERNANCE_AND_REVIEW.md`
   - 自动检测与人工审核关系
   - 图片审核
   - 详情审核
   - 人工决策优先级
   - evidence fingerprint 与重复审核抑制

5. `04_SECURITY_AND_ENGINEERING_GUARDRAILS.md`
   - 安全约束
   - 生产操作约束
   - Git 与凭据约束
   - Reviewer 证据标准
   - 禁止状态偷换

6. `05_ROADMAP_AND_PRIORITIES.md`
   - 开发优先级
   - 阶段性目标
   - 明确暂不做事项

Reviewer / QA Baseline:
`docs/reviewer/README.md`

## 最高级原则

ModelWiki 不是“爬虫采集展示站”。

它是：

> 手办资料库 + 收藏管理平台 + 轻量社区 + 编辑/评测内容平台 + 管理审核系统。

Crawler 主要服务于冷启动和少量后续补全。随着站点成熟，内容质量、人工编辑、用户收藏与社区互动应成为主线。

## 决策优先级

发生冲突时，按以下顺序判断：

1. 本目录中已确认的产品决策；
2. 人工审核与内容安全原则；
3. 数据完整性与安全约束；
4. 当前架构约束；
5. 单次执行器报告或临时实现。

执行器报告不能覆盖产品基线。
