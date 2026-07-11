# API Contract and Data Integrity Tests

## Contract Matrix

每次对账生成：consumer / endpoint / method / repo / production / auth / status。覆盖 guanli、theme admin.js、public frontend、NAS agent、Hermes/worker。

## Review API

测试 list pagination、status/risk/type filters、meta.total、update schema、persistent status 禁止 `all`、notes/riskReason 长度、payload size/shape、action auth、recheck、idempotency。

## Review list enrichment

建议服务端批量返回 current Figure state，并验证无 N+1：title、slug、imageCount、primaryImage、descriptionLength、validSpecCount、missingFields。

## detail_review recheck

- missing description: current empty → still problem；current filled → eligible resolved
- sparse specs: below threshold → still problem；adequate → eligible resolved
- conflict: 无确定规则时保持人工审核
- figure missing → FIGURE_NOT_FOUND

## image review

机器阈值和人工接受标准分离。人工 resolved 后 unchanged evidence 不应重新创建 review。

## Dedup

测试 source/source_id、JAN、title+manufacturer+release 辅助、image hash、image source URL、review evidence fingerprint。

## P0 catalog, relations and locale integrity

- Figure contract 区分 `display_title` 与 `original_title`/full_name；迁移、导入、更新和读取都不应覆盖另一字段。
- Manufacturer contract 覆盖 `canonical_name`、`native_name`、`aliases`、slug 和 canonical ID；alias 归一化必须可追踪，重复合并不能破坏 Figure 关系或产生无解释的 0 产品实体。
- Series、Personnage、Category、Figure relation 使用实体 ID/关系表而非仅名称字符串；详情 breadcrumb、筛选和 API readback 互相一致。
- Latest contract 明确定义排序字段和范围，并测试同日、空日期、未来日期和分页稳定性；API 文案或字段不能把 added/released/upcoming 混为一谈。
- France locale API 返回的用户可见枚举、验证信息和错误信息需有完整 fallback 规则；无翻译键、英法混用、原始 key 泄露均为失败。
- 内容实体（Test、Unboxing、Comparatif、Guide）到 Figure 的关联具备 referential integrity、删除/下线行为和权限测试；没有关联时不得返回为相关内容。

## P1 detail and gallery contract

- detail response 返回或可确定地派生真实 breadcrumb 关系；禁止后端以标题词法猜测 Personnage/Serie。
- specifications 有稳定分组映射：Informations generales、Caracteristiques、Sortie、Production；值为空、null、unknown 时不生成可渲染空字段。
- image response 的 `sourceType` 是受控枚举，和来源 Tab/标签、asset URL、审核来源一致；primary image 选择按已记录的“最佳可用”规则，缺图返回明确 placeholder state。
- Studio editorial relation 与 community avis/rating 是独立 contract、独立计数和授权域；Studio 内容不能写入 avis 聚合，Avis 不能被作为 Studio 内容返回。

## P2 collection, wishlist, rating and avis integrity

- Collection/Wishlist 的 create/delete/toggle 使用明确幂等语义；重试、并发和双提交不能重复创建，且跨用户对象 ID 必须 403/404，不泄露私有数据。
- Favorite 兼容期必须定义 read/write 映射、迁移批次、回滚和最终清退条件；测试迁移前、迁移中、迁移后读写，避免 Favorite 与 Wishlist 双向漂移。
- rating/avis 数据模型对 `(user_id, figure_id)` 施加唯一性；create、edit/upsert、delete 和并发写入后的 readback 均只保留一条用户记录。
- 每条 avis 校验 overall score 与四维 score 的范围、必填/可选规则、文字内容、所有权、审核和转义；编辑必须更新原记录而非新增。
- 聚合 contract 返回总平均分、四维聚合和 `sampleCount`；用 0、1、多用户、编辑和删除样本核对分母，禁止只返回 4.6 而没有样本数。

## Community integrity

Like（若保留）只作为内容/Avis helpful 等已定义动作，不与 Figure 收藏语义混淆；Collection state/visibility/quantity/price validation；Avis login required、own edit/delete、admin moderation、rate limit、output escaping。
