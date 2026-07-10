# ModelWiki 系统架构

## 1. 当前实现映射

当前仓库主要结构对应：

### WordPress Theme / Frontend

目录：

`modelwiki-theme/`

职责：

- 首页
- Browse
- Search
- Figure detail
- Series / Manufacturer / Sculptor 等页面
- 用户账户页
- 评测/文章展示能力应继续基于 CMS 优势扩展

### 管理后台前端

文件：

`guanli_index.php`

职责：

- 管理员登录
- Dashboard
- Figure 管理
- Review 管理
- 用户管理
- Job 查看

长期应逐步模块化，但不能为了重构而破坏稳定 UI。

### API Backend

目录：

`mw-backend/`

技术职责：

- API
- Auth
- Figure data
- Image serving
- Review
- Crawler jobs
- User/community APIs
- Redis cache
- PostgreSQL access

当前后端目录包含 Prisma schema 和 TypeScript source，应作为结构化数据和业务规则的主要服务层。

### PostgreSQL

职责：

- Figure 主数据
- 分类关系
- 图片记录
- 用户
- 收藏
- 点赞
- 评论
- 评测关联
- 长期审计数据

### Redis

适合：

- cache
- rate limit
- short-lived job queue
- ephemeral locks

不应长期把关键人工决策仅存在 Redis。

### NAS / Browser Crawler Agent

文件：

`nas_crawler_agent.py`

职责：

- 浏览器能力抓取
- 小规模 refetch
- 冷启动数据采集
- 图片获取
- job claim
- job result 写回

不应成为网站长期主业务中心。

---

## 2. 目标逻辑架构

```text
                   ┌─────────────────────┐
                   │  Public Frontend     │
                   │  WordPress Theme     │
                   └──────────┬──────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │   API / Domain       │
                   │   TypeScript         │
                   └─────┬───────┬──────┘
                         │       │
              ┌──────────┘       └──────────┐
              ▼                             ▼
      ┌──────────────┐              ┌──────────────┐
      │ PostgreSQL    │              │ Redis         │
      │ source truth  │              │ cache/jobs    │
      └──────────────┘              └──────┬───────┘
                                           │
                                           ▼
                                  ┌─────────────────┐
                                  │ NAS/Browser Agent│
                                  │ cold start/refetch│
                                  └─────────────────┘

                   ┌─────────────────────┐
                   │ Admin / Reviewer     │
                   │ Human decision       │
                   └──────────┬──────────┘
                              │
                              ▼
                   API / Review workflow
```

---

## 3. 模块划分

### 3.1 Identity & Access

负责：

- registration
- login
- password change
- role
- account status
- token/session
- audit

角色：

- visitor
- user
- editor
- admin

### 3.2 Figure Catalog

负责：

- Figure 主数据
- aliases
- product kind
- category
- manufacturer
- series
- character
- sculptor
- release
- price
- scale/material/height
- source identity

### 3.3 Media & Image

负责：

- primary image
- gallery
- source metadata
- dimensions
- hash
- quality flag
- safe display
- candidate asset
- thumbnail/detail derivative

### 3.4 Community

负责：

- likes
- favorites
- comments
- collection states
- personal collection metadata

### 3.5 Editorial Content

负责：

- review article
- guide
- comparison
- news/update
- article ↔ Figure relation
- article ↔ Series/Manufacturer relation

### 3.6 Review Workflow

负责：

- risk item
- evidence
- current state
- decision
- reviewer
- decision time
- suppression/reopen

### 3.7 Crawler Jobs

负责：

- job create
- claim
- running
- completed/failed
- result summary
- retry/deferred
- small canary

### 3.8 Search & Discovery

负责：

- keyword
- structured filters
- relevance
- recommendations
- trending signals

---

## 4. 数据源优先级

### 图片

#### 低风险可信来源

例如：

- 官方厂商
- 明确可信 retailer
- 已验证 structured source

可以自动进入图库，但仍需基础安全校验。

#### 高风险来源

例如：

- MFC user upload
- 共享 candidate
- 不确定来源
- 疑似玩家房间
- 展示柜
- 合集图
- 宣传横幅

必须进入 review。

### 详情

#### 可信结构化来源

可以自动写入。

#### 冲突/稀疏/异常

进入 detail_review。

---

## 5. Review 数据模型建议

ReviewItem 应至少包含：

- id
- figureId
- riskType
- status
- source
- riskReason
- originalEvidence
- currentStateSnapshot
- candidateAssetId / candidateImage
- createdAt
- updatedAt
- lastAction
- reviewerId
- decisionReason
- decisionAt
- evidenceFingerprint

状态建议：

- pending
- needs_changes
- resolved
- rejected
- archived

`all` 只能作为查询参数，不能持久化。

---

## 6. Human Decision 规则

### 核心规则

人工决定高于自动规则。

### 图片数量规则

机器可因 `<3 images` 触发 review。

但人工确认一张高质量、可靠图片足够时，可以 resolved。

### Evidence Fingerprint

建议：

```text
hash(
  figureId
  + riskType
  + primaryImageId
  + sorted(imageIds)
  + candidateAssetHash
  + risk-relevant detail fields
)
```

规则：

- 同 figure + risk + fingerprint 已有人工决定 → suppress
- fingerprint 变化 → 允许 reopen/new review
- approved image 删除/失效 → 允许 reopen
- 当前状态恶化 → 允许 reopen

---

## 7. Crawler 冷启动架构

Crawler 分两个时期。

### 冷启动期

目标：

- 建基础目录
- 补主要来源
- 建图片和规格
- 发现风险

特点：

- 小批次
- 可追踪
- 高失败容忍
- review queue 较多

### 稳定运营期

Crawler 退居辅助角色。

主要触发：

- 管理员 request_refetch
- 明确缺失
- 来源更新
- 少量定期验证
- 新增商品导入

长期不应依赖“大规模自动爬取”维持内容质量。

---

## 8. Crawler 状态机

必须严格：

```text
created
→ queued
→ claimed
→ running
→ completed | failed | deferred
```

禁止状态偷换：

- created ≠ executed
- queued ≠ completed
- HTTP 200 ≠ data correct
- payload correct ≠ crawler closure

---

## 9. Candidate Asset Contract

目标：

```text
source URL
→ browser/NAS fetch
→ upload review cache
→ server validation
→ candidateAsset identity
→ review item
→ preview/lightbox
→ approve
→ official FigureImage
```

必须保证：

> reviewer 看到的 candidate = approve 的 candidate = 最终写入的 image identity

禁止：

- review candidate A
- agent 上传 B
- 审核员看到 B
- approve A

---

## 10. Article / Review Content Architecture

建议评测文章继续利用 WordPress 内容编辑能力。

API/DB 维护结构化关联：

- articleId
- figureIds
- seriesIds
- manufacturerIds
- characterIds
- articleType

Figure detail API 可返回 relatedArticles。

这样：

- WordPress 负责编辑体验和文章呈现
- Backend 负责结构化关联和社区数据
