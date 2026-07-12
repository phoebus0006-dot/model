# Phase 13 前端基线审计报告

> 生成日期：2026-07-11
> 主题版本：2.7.6
> 后端：Fastify + Prisma + Redis + PostgreSQL

---

## 1. 当前入口文件

| 文件 | 行数 | 类型 | 状态 |
|------|------|------|------|
| `index.php` | 51 | 首页 | ✅ 活跃 |
| `header.php` | 73 | 公共头部 | ✅ 活跃 |
| `footer.php` | 14 | 公共页脚 | ✅ 活跃 |
| `functions.php` | 543 | 主题核心 | ✅ 活跃 |
| `page-admin.php` | 701 | 管理面板 SPA | ✅ 活跃 |
| `page-figure.php` | 383 | 手办详情 | ✅ 活跃 |
| `page-browse.php` | 169 | 浏览/搜索列表 | ✅ 活跃 |
| `page-search.php` | 119 | 搜索页 | ✅ 活跃 |
| `page-series.php` | 40 | 系列列表 | ✅ 活跃 |
| `page-series-list.php` | 78 | 系列详情 | ✅ 活跃 |
| `page-characters.php` | 47 | 角色列表 | ✅ 活跃 |
| `page-character.php` | 75 | 角色详情 | ✅ 活跃 |
| `page-manufacturers-list.php` | 79 | 制造商列表 | ✅ 活跃 |
| `page-manufacturer.php` | 83 | 制造商详情 | ✅ 活跃 |
| `page-sculptors-list.php` | 79 | 原型师列表 | ✅ 活跃 |
| `page-sculptor.php` | 78 | 原型师详情 | ✅ 活跃 |
| `page-account.php` | 115 | 账户页 | ✅ 活跃 |
| `template-parts/figure-card.php` | 78 | 手办卡片组件 | ✅ 活跃 |

## 2. 当前 Bundle

| 资源 | 路径 | 大小 | 加载方式 |
|------|------|------|----------|
| CSS 主题 | `style.css` | ~400B | `wp_enqueue_style` |
| CSS 主样式 | `assets/css/main-v27.css` | ~1031行/16KB | `wp_enqueue_style` |
| JS 主脚本 | `assets/js/main-v27.js` | ~461行/13KB | `wp_enqueue_script` (footer) |
| JS 管理面板 | `assets/js/admin.js` | ~983行/28KB | 手动 `<script>` (footer) |
| 管理面板 CSS | 内联于 `page-admin.php` | ~630行/10KB | 内联 `<style>` |

无打包器。三份独立传输（无懒加载、无代码分割）。

## 3. 重复脚本和样式

| 重复项 | 说明 | 严重性 |
|--------|------|--------|
| `main.js` vs `main-v27.js` | `main.js`（84行）是旧版，未被入队。功能在 `main-v27.js` 中重复但更完善。 | ⚠️ 中 |
| `main.css` vs `main-v27.css` | `main.css`（1021行）完整主题，未被入队。`main-v27.css` 是重新设计的版本。 | ⚠️ 中 |
| 管理面板内联 CSS | `page-admin.php` 中 ~630 行 CSS 内联，与 `main-v27.css` 的大量变量定义重复。 | ⚠️ 中 |
| CSS 变量 | 两套 CSS 都定义 `--mw-*` 变量但值不同，容易混淆。 | ⚠️ 中 |

## 4. 全局变量

| 变量 | 来源 | 行号 |
|------|------|------|
| `window.MW_I18N` | `header.php` 内联 | 10 |
| `window.API_BASE` | `page-admin.php` 内联 | 696 |
| `window.HOME_URL` | `page-admin.php` 内联 | 697 |
| `window._mwAdmin` | `admin.js` export | 960 |
| `API_BASE` (JS) | `main-v27.js` / `admin.js` | 86 / 26 |

## 5. 直接 fetch 调用

所有客户端 API 调用通过两个封装：

- `main-v27.js:123` → `apiFetch()` 封装 `fetch()` + Bearer token + JSON 解析
- `admin.js:67` → `api()` 封装 `fetch()` + 401 → 自动登出

涉及的 API 端点：

```
GET  /entities (figures, series, manufacturers, sculptors, characters, categories)
GET  /search
GET  /me/space
POST /auth/login
POST /auth/register
GET  /figures/{slug}/social
POST/DELETE /figures/{slug}/like
POST/DELETE /figures/{slug}/favorite
GET/POST /figures/{slug}/comments
```

管理端额外端点（暂不接入前端）：

```
GET/POST /admin/stats, /admin/import/status
POST /admin/cache/purge
PUT/DELETE /admin/figures, /admin/users
POST /admin/review/items/{id}/apply
```

## 6. API URL 硬编码

| 位置 | 行号 | URL | 风险 |
|------|------|-----|------|
| `functions.php` | 4 | `http://api:3000/api/v1` | 🔴 Docker 内部主机名硬编码 |
| `main-v27.js` | 86 | `/api/v1` | 🟡 相对路径，不可配置 |
| `page-admin.php` | 46-48 | Docker 回退逻辑 | 🟡 生产环境不适用 |

## 7. DOM 内联业务逻辑

| 位置 | 行号 | 模式 | 风险 |
|------|------|------|------|
| `page-browse.php` | 114 | `onchange="..."` | 🟡 违反 CSP no-unsafe-eval |
| `admin.js` | 多处 | `onclick="window._mwAdmin.*"` | 🟡 内联事件处理器 |
| `page-admin.php` | 全文件 | 内联 JS 模板字符串 | 🟡 SPA 渲染不可测试 |

## 8. 错误处理

| 层 | 覆盖范围 | 缺陷 |
|----|----------|------|
| PHP `mw_api_get()` | ✅ `is_wp_error()` 检查 | ✅ 最多记录 3 次 |
| JS `apiFetch()` | ✅ 非 2xx 抛出 | ⚠️ 静默失败 4 处：371,385,402,431 |
| JS `admin.js` | ✅ 401 自动登出 | ⚠️ `.catch(function(){}).then(...)` 非标准 |
| 用户可见 | ✅ `addAlert('error',...)` | ⚠️ 非管理页面无 toast 组件 |

## 9. loading/empty 状态

| 页面 | loading | empty | error |
|------|---------|-------|-------|
| 首页 | ❌ 无骨架 | ✅ 'No figures found.' | ❌ 静默失败 |
| 浏览 | ❌ 无骨架 | ✅ 'No figures found...' | ❌ 静默失败 |
| 搜索 | ❌ 无骨架 | ✅ 'No results found.' | ❌ 静默失败 |
| 详情 | ❌ 无骨架 | ✅ 'No image available' | ❌ 静默失败 |
| 账户空间 | ❌ 白屏等待 | ✅ 'Nothing here yet.' | ⚠️ `.catch(clearSession)` |
| 评论 | ❌ 无骨架 | ✅ 'No comments yet.' | ⚠️ 静默失败 |
| 管理面板 | ✅ `renderSpinner()` | ✅ 各表有 empty 文本 | ✅ `addAlert` 显示 |

## 10. 移动端布局

| 特性 | 状态 |
|------|------|
| Viewport meta | ✅ `width=device-width, initial-scale=1.0` |
| 汉堡菜单 | ✅ `<768px` 显示，JS 切换 |
| 响应式断点 | ✅ 480px, 640px, 768px, 1024px |
| 小屏 ` < 360px` | ❌ 无专用断点 |
| 语言切换器 | ✅ 始终内联 |
| 筛选器 | ✅ 桌面侧边栏，移动端浮动按钮 |

## 11. 可访问性

| 领域 | 状态 |
|------|------|
| 语义 HTML | ✅ `<nav>`, `<main>`, `<article>`, `<section>`, `<footer>` |
| 跳过链接 | ✅ `href="#main-content"` + `:focus` 可见 |
| ARIA 标签 | ✅ 导航、面包屑、分页、灯箱、标签页 |
| 焦点管理 | ❌ 灯箱/菜单打开时无焦点捕获 |
| 颜色对比度 | ✅ 浅/深色主题均良好 |
| 图片 alt | ✅ 卡片/主图有 alt，装饰图 `alt=""` |
| `aria-expanded` | ❌ 移动端菜单按钮缺少 |
| CSP nonce | ✅ 内联脚本使用 nonce |

## 12. Phase 13 状态 (2026-07-12 更新)

> ⚠️ **EMERGENCY RECOVERY IN PROGRESS**
>
> Phase 13 前端工作已暂停。所有前端改动已回滚至 Phase 12 基线 (commit a4c9d82)。
> 专注前台恢复、后台统一、旧审核队列下线。

### 回滚内容
- 移除 `api-client.js`（统一 API client 原型）
- 移除 `feature-flags.js`（特性开关原型）
- 还原 `index.php` 至无骨架屏版本
- 还原 `page-browse.php` 至 PHP 渲染版本
- 还原 `main-v27.css` 至 Phase 12 版本
- 删除 `frontend-api-client.test.ts`（36 个测试，因文件不存在而全部失效）

### 当前状态
- **Phase 13 frontend** = NOT IMPLEMENTED
- **Admin review replacement** = NOT IMPLEMENTED (见 `EMERGENCY_UI_AND_ADMIN_RECOVERY`)
- **Live deployment** = REGRESSED (需要生产环境验收)

### 恢复后优先级
- [ ] 前台经生产环境验证正常
- [ ] 唯一后台入口 (page-admin.php + admin.js)
- [ ] 旧审核队列下线 + 新状态机 UI
- [ ] 真实审核闭环完成
- [ ] 线上截图齐全
- [ ] 再评估是否继续 Phase 13
