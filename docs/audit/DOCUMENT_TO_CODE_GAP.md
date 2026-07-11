# 文档与代码间隙报告

## 检查范围

对照 `docs/00_PRODUCT_VISION.md`、`docs/01_USER_REQUIREMENTS.md`、`docs/02_SYSTEM_ARCHITECTURE.md`、`docs/05_ROADMAP_AND_PRIORITIES.md` 中描述的功能，验证代码实际实现状态。

## 差异矩阵

| # | 需求 | 文档位置 | 数据库 | 后端 API | 管理端 | 公共前端 | 测试 | 状态 |
|---|------|----------|--------|----------|--------|----------|------|------|
| 1 | Personnage 正式实体 | 00:24, 02:17, 05:13 | IMPLEMENTED (Character 模型) | IMPLEMENTED (CRUD + /:slug/figures) | IMPLEMENTED (CRUD 章节) | IMPLEMENTED (page-character.php, header.php Personnages 导航) | NOT_IMPLEMENTED | **IMPLEMENTED** |
| 2 | Personnage 导航可渐进 | 00:24 | N/A | N/A | N/A | IMPLEMENTED (导航已包含) | N/A | **IMPLEMENTED** |
| 3 | Fabricant canonical entity | 00:52, 02:19 | IMPLEMENTED (Manufacturer 模型) | IMPLEMENTED (CRUD) | IMPLEMENTED | IMPLEMENTED | NOT_IMPLEMENTED | **PARTIAL** |
| 4 | Fabricant aliases | 00:52, 02:19 | **NOT_FOUND** (无 aliases 字段) | **NOT_FOUND** | **NOT_FOUND** | N/A | NOT_IMPLEMENTED | **DOCUMENTED_BUT_NOT_IMPLEMENTED** |
| 5 | 0 商品实体隐藏 | 00:53 | PARTIAL (isDeleted 字段) | PARTIAL | NOT_FOUND | NOT_FOUND | NOT_IMPLEMENTED | **PARTIAL** |
| 6 | Category 统一命名 | 00:54 | PARTIAL (slug 唯一) | PARTIAL | IMPLEMENTED | NOT_VERIFIED | NOT_IMPLEMENTED | **PARTIAL** |
| 7 | Gallery 按来源分 Studio/Communauté/Officielles | 00:34, 01:24, 02:23 | **INCONSISTENT** (source 字段存 URL 而非分类) | **INCONSISTENT** (data.source_kind 元数据, 无枚举) | N/A | **NOT_FOUND** (按 size 分组, 非来源) | NOT_IMPLEMENTED | **DOCUMENTED_BUT_NOT_IMPLEMENTED** |
| 8 | 统一 Placeholder | 00:34, 01:25 | N/A | N/A | N/A | PARTIAL (文本 Placeholder, 非 Logo 设计) | NOT_IMPLEMENTED | **PARTIAL** |
| 9 | 规格分组 Informations générales/Caractéristiques/Sortie/Production | 00:36, 01:26 | **NOT_FOUND** (无分组字段) | **NOT_FOUND** | N/A | **NOT_FOUND** (平面规格列表) | NOT_IMPLEMENTED | **DOCUMENTED_BUT_NOT_IMPLEMENTED** |
| 10 | Studio 内容与社区 Avis 分离 | 00:36-37, 03:25 | **NOT_FOUND** (无内容模型) | **NOT_FOUND** | N/A | **NOT_FOUND** (Comments 系统 = 社区 Avis, 无 Studio 内容) | NOT_IMPLEMENTED | **DOCUMENTED_BUT_NOT_IMPLEMENTED** |
| 11 | 1 总评分 + 4 维度 | 00:40, 01:28 | **NOT_FOUND** (Rating/Avis 模型) | **NOT_FOUND** | N/A | **NOT_FOUND** (page-figure.php 无评分展示) | NOT_IMPLEMENTED | **DOCUMENTED_BUT_NOT_IMPLEMENTED** |
| 12 | Collection/Wishlist/Noter/Avis | 00:38, 01:29, 01:37-47 | PARTIAL (Favorite 模型存在, 无 Wishlist/Avis/Rating) | PARTIAL (community.ts 有 Favorite/Like) | N/A | PARTIAL (main-v27.js 有 favorite/like JS, 但页面无 Collection/Wishlist UI) | NOT_IMPLEMENTED | **PARTIAL** |
| 13 | Explorer 筛选 | 00:44-45, 01:51 | N/A | IMPLEMENTED (筛选参数) | N/A | NOT_VERIFIED | NOT_IMPLEMENTED | **PARTIAL** (后端就绪, 前端待验证) |
| 14 | Home Hero + Search + 模块 | 00:46, 05:55 | N/A | PARTIAL (list 端点通用) | N/A | PARTIAL (index.php 有 Hero/Search/分类/最新) | NOT_IMPLEMENTED | **PARTIAL** |
| 15 | Home 数据阈值 | 01:53-59, 04:29 | N/A | **NOT_FOUND** (无阈值配置) | N/A | **NOT_FOUND** (始终渲染, 无条件判断) | NOT_IMPLEMENTED | **DOCUMENTED_BUT_NOT_IMPLEMENTED** |
| 16 | Tests & Guides 内容体系 | 00:48, 05:62-69 | **NOT_FOUND** (无内容模型) | **NOT_FOUND** (无内容路由) | N/A | **NOT_FOUND** (无页面模板) | NOT_IMPLEMENTED | **DOCUMENTED_BUT_NOT_IMPLEMENTED** |
| 17 | Customisation & 3D 条件展示 | 00:48, 02:25 | **NOT_FOUND** | **NOT_FOUND** | N/A | **NOT_FOUND** | NOT_IMPLEMENTED | **DOCUMENTED_BUT_NOT_IMPLEMENTED** |
| 18 | Latest/Upcoming/Releases 语义区分 | 00:55, 05:16 | N/A | PARTIAL (admin stats 端点有区分, 公共 API 复用同一 list) | N/A | NOT_FOUND (index.php 只使用 release_date:desc) | NOT_IMPLEMENTED | **PARTIAL** |
| 19 | 关系面包屑 | 00:32, 01:23 | N/A | IMPLEMENTED (figure 响应含 series/character) | N/A | PARTIAL (page-figure.php 面包屑=Home>Figures>Category, 非 Series>Personnage>Figure) | NOT_IMPLEMENTED | **PARTIAL** |
| 20 | display_title/original_title | 00:32, 01:22 | PARTIAL (Figure 有多个 name 字段) | PARTIAL | N/A | PARTIAL (mw_display_name 按 nameEn>slug>nameJp>name 优先级) | NOT_IMPLEMENTED | **PARTIAL** |
| 21 | Figurines 导航含子分类 | 00:45 | N/A | N/A | N/A | NOT_FOUND (header.php 只有 "Figurines" 链接, 无子分类) | NOT_IMPLEMENTED | **DOCUMENTED_BUT_NOT_IMPLEMENTED** |

## 关键发现

### 已实现（IMPLEMENTED）
- Personnage/Character 实体与 CRUD——代码与文档一致
- 导航包含 Personnages——已在 header.php
- Manufacturer CRUD——完整实现

### 部分实现（PARTIAL）
- Fabricant canonicalization——实体存在但无 DB 级别名
- Gallery——图片存储有 source 字段但用于 URL, 分类在 data JSON 中非结构化
- 评分/收藏——Favorite 和 FigureLike 模型存在但无 Rating/Avis 模型
- 面包屑——后端返回关系数据但前端使用简单面包屑

### 已文档但未实现（DOCUMENTED_BUT_NOT_IMPLEMENTED）
1. **Fabricant aliases 表**——DB 无别名字段，完全靠爬虫客户端模糊匹配
2. **Gallery 来源分类**——`Photos du Studio`/`Communauté`/`Photos officielles` 分类未在前端实现，后端无枚举约束
3. **规格分组**——Informations générales/Caractéristiques/Sortie/Production 分组未在 DB 或前端实现
4. **Studio 内容与 Avis 分离**——无内容模型，现有 Comments 是唯一社区交互
5. **评分系统**——1 总评分 + 4 维度未实现
6. **Home 数据阈值**——无阈值配置或条件渲染
7. **Tests & Guides 内容体系**——未实现
8. **Customisation & 3D**——未实现
9. **Figurines 导航子分类**——未在导航中实现

### 不一致（INCONSISTENT）
- Gallery source 字段——文档写成分来源标签，代码中 source=URL，分类在 JSON 中
