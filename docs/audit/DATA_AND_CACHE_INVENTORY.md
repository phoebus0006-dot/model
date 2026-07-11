# 数据与缓存清单

## Prisma 模型（20 个）

| # | 模型 | 表名 | 关键字段 | 唯一约束 | 关系 |
|---|------|------|----------|----------|------|
| 1 | Figure | figures | id(BigInt), slug, name, nameJp, nameEn, scale, material, priceJpy, releaseDate, heightMm, janCode, seriesId, manufacturerId, activeRevisionId, mfcId, isDeleted | slug, janCode, activeRevisionId | Series, Manufacturer, Revision, FigureImage, FigureCategory, FigureCharacter, FigureSculptor, Favorite, FigureLike, FigureComment |
| 2 | FigureLocalized | figure_localized | figureId, language, title, origin, character, description | (figureId, language) | Figure |
| 3 | FigureRelease | figure_releases | figureId, edition, releaseDate, priceJpy, isRerelease | 无 | Figure |
| 4 | Series | series | id(BigInt), slug, name, nameJp, nameEn, mediaType | slug | Figure[], Character[] |
| 5 | Character | characters | id(BigInt), slug, name, nameJp, nameEn, seriesId | slug | Series, FigureCharacter[] |
| 6 | Manufacturer | manufacturers | id(BigInt), slug, name, nameJp, nameEn, country | slug | Figure[] |
| 7 | Sculptor | sculptors | id(BigInt), slug, name, nameJp, nameEn, alias[] | slug | FigureSculptor[] |
| 8 | Category | categories | id(BigInt), slug, name, parentId, sortOrder | slug | FigureCategory[] |
| 9 | Revision | revisions | figureId, contentMd, summaryMd, keyPoints[], versionNumber | (figureId, versionNumber) | Figure |
| 10 | FigureImage | figure_images | id(BigInt), figureId, url, sha256, size, source, data(Json?), isNsfw | (figureId, sha256, size) | Figure |
| 11 | FigureCategory | figure_categories | figureId, categoryId | (figureId, categoryId) | Figure, Category |
| 12 | FigureSculptor | figure_sculptors | figureId, sculptorId, role, isPrimary | (figureId, sculptorId) | Figure, Sculptor |
| 13 | FigureCharacter | figure_characters | figureId, characterId, isFeatured | (figureId, characterId) | Figure, Character |
| 14 | User | users | id(BigInt), email, passwordHash, displayName, role, googleSub, wechatOpenid | email, googleSub, wechatOpenid | Favorite[], FigureLike[], FigureComment[] |
| 15 | FavoriteGroup | favorite_groups | userId, name, sortOrder | 无 | User, Favorite |
| 16 | Favorite | favorites | userId, figureId, notes, groupId | (userId, figureId) | User, Figure, FavoriteGroup |
| 17 | FigureLike | figure_likes | userId, figureId | (userId, figureId) | User, Figure |
| 18 | FigureComment | figure_comments | userId, figureId, body, isDeleted | 无 | User, Figure |
| 19 | EntityMapping | entity_mappings | entityType, entityId, source, sourceId, sourceName | (entityType, source, sourceId) | 无 |
| 20 | RedirectMap | redirect_maps | fromPath, toPath, statusCode | fromPath | 无 |

## JSON/自由文本字段

| 模型 | 字段 | 类型 | 风险 |
|------|------|------|------|
| Sculptor | alias | String[] | 适合别名 |
| Sculptor | styleTags | String[] | 适合风格标签 |
| Revision | keyPoints | String[] | 适合关键点 |
| FigureImage | data | Json? | 存储 source_kind, image_low_quality 等元数据 |

## 缺失索引/约束

| 问题 | 说明 |
|------|------|
| Manufacturer 缺少 aliases 字段 | 无 DB 级别别名支持，归并靠爬虫客户端模糊匹配 |
| FigureComment 缺少索引 | 在 isDeleted, figureId 上无索引，在大表上可能慢 |
| FigureImage.data 无模式约束 | JSONB 字段无预期结构验证 |
| Revision.activeRevisionId 唯一约束 | 设计上保证每 figure 一个活跃版本，但更新需事务保护 |

## Redis 键模式

### ~~Redis KEYS 调用~~（Phase 2+3 已全部清理）

全部 12 个 `app.redis.keys()` 调用已于 Phase 2+3 替换为 `scanKeys()`（SCAN + 批量 UNLINK）。

### 缓存策略

| 缓存类型 | TTL | 失效方式 |
|----------|-----|----------|
| figure detail | 未显式设置 | SCAN figures:detail:* 后 UNLINK |
| figure list | 未显式设置 | SCAN figures:list:* 后 UNLINK |
| entity list | 未显式设置 | SCAN entities:list:* 后 UNLINK |
| cache purge | N/A | POST /admin/cache/purge 走 SCAN 或 allowlist |

### 缓存问题

| 问题 | 影响 |
|------|------|
| TTL 不明确 | 缓存可能无限增长 |
| 缺乏缓存版本控制 | 部署后旧缓存可能提供过期数据 |
| 无缓存监控 | 命中率/大小不可见 |

## 数据库与 Redis 事实来源

| 数据类型 | 事实来源 | Redis 角色 |
|----------|----------|------------|
| Figure 主数据 | PostgreSQL | 只读缓存 |
| 审核条目/状态/决定/审计历史 | **Redis**（⚠️ 错误审计结论修正） | 唯一存储 — PostgreSQL 无对应实体 |
| 用户会话 | PostgreSQL(JWT) | 无 |
| 限流 | Redis | 唯一存储 |
| Crawler job 队列 | Redis | 任务协调 |
| AIGC 任务队列 | Redis | 临时任务 |

**主要风险（修正）：** 审核数据仅存 Redis，PostgreSQL 中无审核实体表。
Redis 宕机或数据丢失将导致：
- 所有待审条目丢失
- 所有人工决定丢失
- 所有审计历史（notes 字段）丢失
- 无法重建管理员审核决策

## 未知的无限增长

| 集合 | 风险 |
|------|------|
| Redis 缓存键 | 无 TTL 或 LRU 驱逐策略，可能无限增长 |
| FigureComment | 无软删除清理策略 |
| ReviewItem | 无自动归档策略 |
