# API 清单

基础路径：`/api/v1`

后端文件：`mw-backend/src/`

## 路由总览

| 前缀 | 文件 | 路由数 | 行数 |
|------|------|--------|------|
| `/admin` | `routes/admin.ts` | 27 | 2323 |
| `/figures` | `routes/figures.ts` | 7 | 692 |
| `/figures/images` | `routes/images.ts` | 5 | 714 |
| `/auth` | `routes/auth.ts` | 5 | 307 |
| (无前缀) | `routes/community.ts` | 8 | 297 |
| `/search` | `routes/search.ts` | 1 | 303 |
| `/categories` | `routes/categories.ts` | 5 | 132 |
| `/series` | `routes/series.ts` | 6 | 133 |
| `/manufacturers` | `routes/manufacturer.ts` | 6 | 134 |
| `/sculptors` | `routes/sculptor.ts` | 6 | 135 |
| `/characters` | `routes/characters.ts` | 6 | 164 |
| (内联) | `index.ts` | 1 | 219 |
| **合计** | | **76** | |

## 认证与权限

| 路由前缀 | 认证 | 权限检查 |
|----------|------|----------|
| `/auth/*` | 部分公开 | 无 |
| `/admin/*` | Bearer JWT | `onRequest` hook |
| `/figures` GET | 公开 | 无 |
| `/figures` POST/PUT/DELETE | Bearer JWT | `onRequest` hook |
| `/community/*` | 公开/可选 | 按路由 |
| `/search` | 公开 | 无 |
| `/categories/*` | GET 公开，余需认证 | 按路由 |

## 关键路由详细

### Figures

| 方法 | 路径 | 认证 | 缓存 | 说明 |
|------|------|------|------|------|
| GET | `/` | 否 | Redis | 支持筛选、排序、分页 |
| GET | `/:slug` | 否 | Redis | 含 characters, images, revisions |
| GET | `/:slug/lineage` | 否 | Redis | 版本谱系 |
| GET | `/:slug/revisions` | 否 | 否 | 编辑历史 |
| POST | `/` | 是 | 否 | 创建 figure |
| PUT | `/:slug` | 是 | 否 | 更新 figure |
| DELETE | `/:slug` | 是 | 否 | 软删除 |

### Images

| 方法 | 路径 | 认证 | 限流 | 说明 |
|------|------|------|------|------|
| POST | `/register` | 是 | 否 | 预注册图片元数据（爬虫用） |
| POST | `/upload-processed` | 是 | 否 | 上传已处理 WebP |
| POST | `/upload` | 是 | 否 | 下载外部图片并处理 |
| GET | `/proxy` | 否 | 30/min | 图片代理（SSRF 保护） |
| GET | `/:id` | 否 | 否 | 从文件系统提供图片 |

### Search

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/` | 否 | 统一搜索 figure/series/manufacturer/sculptor/character |

### Admin (审核)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/review/items` | 列出审核项 |
| POST | `/review/items` | 创建审核项 |
| PUT | `/review/items/:id` | 更新审核项 |
| POST | `/review/items/:id/action` | 审核操作（approve/reject/keep_pending 等） |
| POST | `/review/items/:id/recheck` | 重新检查 |
| POST | `/review/items/bulk/cleanup` | 批量清理 |
| POST | `/review/items/:id/apply` | 应用审核决定 |

### Admin (爬虫)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/crawler/jobs` | 列出任务 |
| POST | `/crawler/jobs` | 创建任务 |
| POST | `/crawler/jobs/claim` | 认领任务 |
| GET | `/crawler/jobs/:id` | 任务详情 |
| PUT | `/crawler/jobs/:id` | 更新任务状态 |

### Community

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/me/space` | 用户个人空间（收藏/点赞/评论） |
| GET | `/figures/:slug/social` | 社交计数 |
| POST/DELETE | `/figures/:slug/favorite` | 收藏开关 |
| POST/DELETE | `/figures/:slug/like` | 点赞开关 |
| GET/POST | `/figures/:slug/comments` | 评论列表/创建 |

## Schema 验证

Zod schemas 用于所有路由的输入验证。

响应格式统一：`{ success: boolean, data: ..., meta?: ..., error?: { code, message?, details? } }`

## 测试覆盖

| 路由组 | 合同测试 |
|--------|----------|
| auth | NOT_IMPLEMENTED |
| figures | NOT_IMPLEMENTED |
| images | NOT_IMPLEMENTED |
| search | NOT_IMPLEMENTED |
| admin | NOT_IMPLEMENTED |
| community | NOT_IMPLEMENTED |
