# 内容治理与人工审核

## 1. 原则

机器负责：

- 发现风险
- 提供证据
- 建议操作
- 少量自动补全

人工负责：

- 判断内容是否可接受
- 处理模糊案例
- 解决来源冲突
- 决定是否发布

人工决定是最终兜底。

---

## 2. 图片审核

### 触发条件

包括：

- image_missing
- image_low_count
- image_low_quality
- thumbnail_only
- possible_room_photo
- possible_display_case
- possible_collection_photo
- shared_candidate
- untrusted_source
- candidate_mismatch

### 审核页面必须显示

- 当前 Figure title
- figureId
- slug
- 当前主图
- 当前图片数
- 当前图库
- candidate
- candidate 放大
- source
- dimensions
- riskType
- riskReason
- shared warning
- original evidence
- current state

### 人工动作

- approve_image
- reject_image
- keep_placeholder
- request_refetch
- keep_pending

### 允许放宽

即使 image count 少于机器阈值，只要：

- 图片内容明确相关
- 质量足够
- 来源可信或经人工确认
- 可稳定显示

人工可以 resolved。

---

## 3. 详情审核

### 触发条件

- description missing
- description too short
- sparse specs
- invalid field value
- category conflict
- manufacturer conflict
- release date conflict
- source disagreement

### UI 必须分开

#### Original Evidence

问题发现时的证据。

#### Current State

当前数据库/API 真实状态。

禁止旧 snapshot 长期冒充当前状态。

### 动作

- mark_detail_ok
- request_refetch
- keep_pending
- mark_needs_manual_edit

---

## 4. 可信来源分级

### Tier 1

官方/明确可信结构化来源。

允许：

- 自动写入
- 基础校验后发布

### Tier 2

可信 retailer。

允许：

- 自动补全
- 来源冲突时进入 review

### Tier 3

社区上传/用户图片/不确定来源。

必须：

- candidate review
- 人工视觉判断

---

## 5. 自动规则与人工规则

机器规则可以偏召回。

例如：

```text
0 < imageCount < 3
→ create image_low_count review
```

人工接受规则可以更灵活：

```text
有一张经人工确认的优质主图
→ allow resolve
```

因此必须有 suppression。

---

## 6. 人工决定抑制重复

必须满足：

同一：

- figureId
- riskType
- evidenceFingerprint

如果已有人工 resolved/rejected/keep decision：

→ 后续自动扫描不得重新生成相同审核项。

允许 reopen：

- primary image 改变
- 图片集合改变
- approved image 删除
- approved image 失效
- candidate 改变
- detail relevant fields 改变
- 人工主动 reopen

---

## 7. 旧审核队列处理

禁止粗暴清空。

只允许先 dry-run 分类：

- issue_still_exists
- already_fixed
- duplicate_review
- figure_missing
- insufficient_evidence

处理原则：

- still exists → 保留
- already fixed → archive
- duplicate → 保留最有价值的一条，其余 archive
- figure missing → archive
- insufficient evidence → 保留

任何 archive 前必须：

- before stats
- classification stats
- after stats

分类总和必须自洽。

---

## 8. Visual Review 标准

人工视觉审核至少分类为：

- normal product image
- thumbnail
- room photo
- display case
- collection photo
- promotional banner
- unrelated
- uncertain

不能只根据：

- sourceKind
- width
- height
- URL domain

推断视觉质量。

---

## 9. 审核证据要求

任何 action 的完成标准至少是：

before
→ click/action
→ API response
→ storage state
→ API readback
→ frontend/admin refreshed result

如果涉及图片：

还需：

- image endpoint
- HTTP status
- content type
- dimensions
- visual confirmation when required

如果涉及 crawler：

还需：

- queued
- running
- completed/failed
- writeback
- review state
