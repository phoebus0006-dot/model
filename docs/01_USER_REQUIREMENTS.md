# ModelWiki 用户需求

## 1. 用户角色

### 游客

可以：

- 浏览公开内容
- 搜索
- 使用筛选
- 查看详情、图集、规格、相关推荐
- 查看点赞数、收藏数、评论数
- 阅读评测文章

不能：

- 点赞
- 收藏
- 评论
- 修改内容

### 注册用户

除游客能力外，还可以：

- 登录、退出
- 修改自己的密码
- 点赞/取消点赞
- 收藏/取消收藏
- 评论
- 编辑/删除自己的评论
- 管理收藏状态和分组
- 记录个人收藏信息
- 管理公开/私密设置

### 编辑者

可以：

- 修改手办资料
- 编辑描述
- 维护分类、系列、角色、厂商、原型师关系
- 发布和编辑评测文章
- 处理授权范围内的内容审核

### 管理员

拥有：

- 用户管理
- 内容管理
- 审核管理
- 评论管理
- crawler job 观察与小样本触发
- 缓存管理
- 系统审计查看

管理员账号和权限操作必须受到严格审计。

---

## 2. 前台访客需求

### 2.1 首页

首页应至少包含：

- 最新收录
- 热门收藏
- 热门点赞
- 最近评论
- 最新评测/文章
- 分类入口
- 厂商/系列推荐

首页内容展示优先级应考虑“可安全展示的图片”，避免首屏大量 No Image。

### 2.2 列表和筛选

支持：

- Figure 列表
- Merch 列表
- 分类筛选
- 厂商筛选
- 系列筛选
- 角色筛选
- 原型师筛选
- 发售年份筛选
- 排序：
  - 最新收录
  - 发售日期
  - 收藏数
  - 点赞数
  - 评论数

### 2.3 搜索

至少支持：

- title
- alias
- character
- manufacturer
- series
- JAN
- MFC ID
- source ID
- keyword

搜索结果要允许进一步筛选。

### 2.4 Figure 详情页

至少展示：

- 标题
- 多语言名/别名
- 主图
- 图集
- 厂商
- 系列
- 角色
- 原型师
- 分类
- product kind
- 材质
- 比例
- 高度
- 发售日期
- 价格
- JAN
- 来源链接
- 描述
- 规格
- Like 数
- Favorite 数
- 评论数
- 用户收藏状态入口
- 评论区
- 相关推荐
- 相关评测文章

### 2.5 图片体验

必须满足：

- 主图相关
- 不允许低质量缩略图长期作为唯一主图
- 图片可放大
- 图集顺序合理
- 404 图片有安全 fallback
- 玩家房间、展示柜、合集图等不能未经审核成为主图

### 2.6 相关推荐

相关推荐应：

- 排除当前 Figure 自身
- 按 figureId 去重
- 支持同角色
- 同系列
- 同厂商
- 相似分类

---

## 3. 注册用户需求

### 3.1 收藏状态

支持：

- Own / 已拥有
- Wanted / 想要
- Ordered / 已预订
- Sold / 已出售
- Watch / 关注

### 3.2 收藏记录字段

每条用户收藏记录支持：

- status
- note
- quantity
- purchasePrice
- purchaseDate
- purchaseChannel
- visibility

### 3.3 用户中心

至少包含：

- 我的收藏
- 我的点赞
- 我的评论
- 我的收藏分组
- 账号设置

后续可增加：

- 收藏统计
- 总估值
- 月度入手记录
- 再版提醒
- 价格提醒

---

## 4. 社区互动需求

### 点赞

- 登录用户可点赞/取消点赞
- 前台展示数量
- 同一用户对同一 Figure 不得重复点赞

### 收藏

- 登录用户可收藏/取消收藏
- 收藏状态与个人收藏记录关联
- 前台展示收藏人数

### 评论

要求：

- 登录后才能评论
- 支持编辑自己的评论
- 支持删除自己的评论
- 管理员可删除/隐藏违规评论
- 防刷和频率限制
- 记录创建和修改时间

后续可增加：

- 用户评分
- 热门收藏榜
- 最近评论
- 用户贡献记录

---

## 5. 评测与内容发布需求

这是 ModelWiki 稳定期的重要主线。

### 文章类型

包括但不限于：

- 单品评测
- 开箱
- 做工/涂装分析
- 可动性分析
- 性价比分析
- 同系列横向对比
- 新旧版对比
- 系列盘点
- 购买建议
- 再版信息
- 收藏心得

### 文章与 Figure 的关系

评测文章应能关联：

- 一个 Figure
- 多个 Figure
- 一个系列
- 一个厂商
- 一个角色

Figure 详情页应能展示关联评测。

### 编辑体验

编辑者需要：

- 草稿
- 预览
- 发布
- 更新
- 封面图
- 图集
- Figure 关联
- SEO 基础字段
- 多语言扩展接口（后续）

---

## 6. 管理后台需求

### 仪表盘

显示：

- Figure 总数
- 图片总数
- 用户数
- 评论数
- pending review
- needs_changes review
- crawler queued/running/failed
- 图片覆盖率
- detail 完整率

### Figure 管理

支持：

- 搜索
- 编辑
- 查看 title
- slug/id
- category
- manufacturer
- series
- characters
- image count
- detail missing state
- pending review state
- 跳转前台
- 跳转对应审核项

### 分类主数据管理

支持：

- category
- manufacturer
- series
- character
- sculptor

### Review 管理

图片审核需要：

- 当前主图
- 当前图片数
- candidate
- candidate 放大
- current vs candidate 对比
- source
- dimensions
- riskType
- riskReason
- sharedCandidateWarning
- original evidence
- current state

动作：

- approve
- reject
- keep_placeholder
- request_refetch
- keep_pending / uncertain

详情审核需要：

- 当前 description
- 当前 specs
- missing fields
- conflict fields
- original evidence
- current state
- suggested action

动作：

- mark_detail_ok
- request_refetch
- keep_pending
- mark_needs_manual_edit

### 用户管理

支持：

- 查看用户
- 禁用/启用
- 修改角色
- 删除测试账号
- 重置密码流程

涉及密码的操作必须避免管理员看到明文密码。

### 评论管理

支持：

- 列表
- 搜索
- 删除
- 隐藏
- 查看关联 Figure 和用户

---

## 7. 验收原则

任何 UI 功能不能以“按钮存在”为完成标准。

至少验证：

操作前状态
→ 实际点击
→ API 返回
→ 状态变化
→ 页面刷新后的结果
