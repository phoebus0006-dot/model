# UI Interaction Test Baseline

## 原则

UI 测试验证真实交互，不验证字符串存在。`keepPending` 字符串存在不代表 keep_pending 可用。

除管理端 smoke 外，产品 UI 的优先验证顺序为 `P0 数据/法语`、`P1 详情页`、`P2 Collection/Wishlist/Avis`。Explorer/Search、首页、内容和社区深化在相应 scope 到来时增加测试；不得因路线图文字而宣称已经上线。

## Admin login smoke

`open login → fill env-backed credentials → login → dashboard visible`，并记录 pageerror、console error、401、429、5xx。禁止输出凭据。

## Review list

验证 pending/all/rejected/riskType filter；page 1/page 2；filter change resets page 1；total 与 API meta.total 一致。

## Review card 必需信息

Figure title、figureId/slug、riskType、riskReason、original evidence、current state、image count、primary image、candidate、source、dimensions、shared warning。禁止长期 title='-'、count='...'、旧 snapshot 冒充 current state。

## Candidate visual test

验证 thumbnail、preview、lightbox 可见；preview/lightbox 同资产；没有 broken direct URL；不能把 302 当成功；content-type=image/*；dimensions 与 metadata 一致；无 proxy request storm。记录 proxy requests、重复 URL 次数、429、failed resources。

## keep_pending

`open review → click keep pending → modal → reason → submit → API → status remains pending → decisionReason/reviewer/time saved → reload persists → no crawler job`

## approve_image

`before → approve → storage write → API readback → endpoint → refreshed admin → public detail verification`

## request_refetch

`click → exactly one job → double-click no duplicate → payload correct → review linked to job`

## Render stability

检查全局 render、alert 是否重建图片 DOM、blob URL 生命周期、重复 listener、stale request abort、inflight dedup、double-click disabled。

## P0 data and France locale

在 France locale 下逐页检查 Header、Footer、搜索、Browse/Explorer、filters、sort、详情、规格、账户、登录注册、密码校验、错误状态及邮件激活相关可见字符串。切换路由、空状态、加载失败和表单校验也必须检查；禁止只检查首屏或静态翻译文件。

验证 Manufacturer 显示 canonical_name 的规则、native_name 的展示位置和 alias 搜索命中；Personnage、分类和 Latest 页面/卡片的名称与实际查询语义一致。Latest 必须能从 UI 追溯到明确的排序含义，不能把“最近录入”“已发售”“未来发售”混用。

## P1 Figure detail

`open detail → inspect relations → inspect gallery → inspect specifications → inspect Studio/Avis boundary`：

- H1 使用 `display_title`，完整 `original_title`/full_name 不丢失且以次级信息可访问。
- breadcrumb 由真实关系生成；缺失关系时如实降级，不可用标题字符串拼出虚假 Series 或 Personnage。
- 规格按 Informations generales、Caracteristiques、Sortie、Production 分组；空值字段和空行均不可见。
- Gallery 显示每图 `sourceType`；Studio、Communauté、Photos officielles 等来源 Tab/标签与资产一致；主图为当下最佳可用图片；无图显示统一 placeholder，而不是 broken image。
- Studio 内容卡片（Test/Unboxing/Comparatif/Guide）与社区 Avis 分区显示；Studio 编辑内容不计入 Avis 列表或社区评分。
- Figure 相关内容入口只展示已建立关系的内容实体，点击后到正确内容页。

## P2 Collection, Wishlist and Avis

以两个普通账号和一个无登录会话验证：

- `Je la possede`/Collection 与 Wishlist 可添加、移除、刷新后保持；快速双击或重试不产生重复记录。
- 未登录引导到认证；账号 A 不能通过 UI 或修改 URL 读取/编辑账号 B 的私有 Collection、Wishlist 或 Avis。
- Favorite 旧入口/旧数据遵循已声明的兼容、迁移或清退策略；不能在新旧入口之间产生不可解释的状态分叉。
- `Noter/Ecrire un avis → submit → reload → edit → reload` 保持同一条记录。重复创建必须转为更新或得到明确冲突，不可出现同用户同 Figure 多条 avis。
- 详情显示总分、四个维度和样本数；样本数随首评、编辑、删除正确变化，0 样本不得显示伪造平均分。

## 生产默认 smoke 为只读

只做 login/dashboard/list/filter/pagination/reload/image/lightbox。未经批准不做 approve/reject/request_refetch/keep_pending/cache purge/user modification。
