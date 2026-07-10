# ModelWiki 开发路线与优先级

## Phase 0：稳定基线

目标：

- GitHub / production / NAS 版本一致
- 管理后台稳定登录
- 无白屏
- 无 429 请求风暴
- 基础安全扫描通过
- 不再有真实凭据泄露

---

## Phase 1：人工审核真正可靠

最高优先级。

完成：

- Review list 返回当前 Figure 状态
- title 不再是 "-"
- image count 显示真实值
- detail original evidence 与 current state 分开
- candidate 可稳定显示
- preview/lightbox 同一资产
- keep_pending
- decisionReason
- reviewer
- decisionAt
- action 闭环
- detail_review recheck 正确

验收标准：

管理员能在不依赖旧 snapshot 的情况下完成真实判断。

---

## Phase 2：人工决定记忆

实现：

- evidenceFingerprint
- duplicate suppression
- reopen conditions
- decision audit

目标：

人工决定不被无变化的自动扫描反复覆盖。

---

## Phase 3：前台核心产品能力

优先：

1. 搜索与筛选
2. Figure detail 质量
3. Related 去重/排己
4. 图片稳定展示
5. 用户点赞
6. 收藏
7. 评论
8. 收藏状态与个人中心

---

## Phase 4：收藏管理

实现：

- Own
- Wanted
- Ordered
- Sold
- Watch

以及：

- notes
- quantity
- purchase price
- purchase date
- channel
- visibility

---

## Phase 5：评测与编辑内容

这是稳定运营期主线之一。

实现：

- 文章类型
- Figure 关联
- Series 关联
- Manufacturer 关联
- 文章列表
- Figure 页关联评测
- 首页最新评测
- 编辑者工作流

---

## Phase 6：轻量社区增强

实现：

- 评论管理
- 最近评论
- 热门点赞
- 热门收藏
- 可选评分
- 用户公开收藏页
- 用户贡献记录

---

## Phase 7：Crawler 辅助运营

Crawler 从主线退居辅助。

只用于：

- 新增商品导入
- 明确缺失补全
- 管理员 request_refetch
- 小规模来源更新
- 数据验证

要求：

- 小样本 canary
- job 状态真实
- 失败可追踪
- 不覆盖人工确认数据
- 不确定内容进入 review

---

## 当前明确不应优先做

- 扩大 crawler 并发
- 大规模 MFC 抓取
- 大规模自动 archive
- 重做整个管理后台 UI
- 复杂 AI 图像模型替代人工审核
- 复杂推荐算法
- 大规模微服务拆分
- 为未来扩展过度设计

先把：

> 资料可信 + 人工审核可靠 + 收藏可用 + 内容可持续发布

做好。
