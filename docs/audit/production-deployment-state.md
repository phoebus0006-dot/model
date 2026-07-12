# 生产部署状态审计

> 生成日期：2026-07-12
> 审计者：自动（recovery/live-ui-admin 分支创建时）

## ⚠️ 限制

无法直接连接 NAS/生产服务器进行只读检查。以下信息基于 Git 历史分析。

## 1. 仓库状态

| 项目 | 值 |
|------|-----|
| Git 根目录 | `D:\model wiki` |
| 当前分支 | `recovery/live-ui-admin` |
| 最近提交 | `7f5c1a8` |
| 上游分支 | `origin/review/phase12-r4` (已推送 SHA `0320454`) |
| 脏工作树 | 否（已提交全部改动） |

## 2. Git 历史（modelwiki-theme 文件）

| 提交 | 日期 | 影响 |
|------|------|------|
| `32c1f1f` Initial commit | 初始 | 原始 WordPress 主题基线 |
| `a4c9d82` Phase 12/12R | Phase 12 | 字符页面、functions.php、header、index 微调 |
| `0320454` Lane-F+G+J | Phase 13 (已回滚) | api-client.js、feature-flags.js、index.php 重写、page-browse.php 重写 |
| `a988d29` recovery: restore frontend | 恢复 | **已回滚至 a4c9d82 状态** |

## 3. 前台文件 SHA256（已恢复到 a4c9d82 状态）

| 文件 | 来自提交 |
|------|---------|
| `index.php` | a4c9d82 (Phase 12) |
| `header.php` | a4c9d82 (Phase 12) |
| `footer.php` | 32c1f1f (Initial) |
| `functions.php` | a4c9d82 (Phase 12) |
| `main-v27.css` | a4c9d82 (Phase 12) |
| `main-v27.js` | 32c1f1f (Initial) |
| `page-figure.php` | a4c9d82 (Phase 12) |
| `page-browse.php` | a4c9d82 (Phase 12) |
| `page-search.php` | a4c9d82 (Phase 12) |

## 4. 后台入口分析

| 入口 | 状态 | 操作 |
|------|------|------|
| `modelwiki-theme/page-admin.php + admin.js` | ✅ 规范入口 | 保留，已修复状态机调用 |
| `guanli_index.php` | 🔀 301 → /admin/ | 已重定向 |

## 5. 审核队列状态

| 系统 | 状态 | 说明 |
|------|------|------|
| Redis 审核存储 | ✅ 存续 | `review:item:*` 键仍在 Redis |
| 旧 UI 审核队列 (guanli_index.php) | 🔀 已重定向 | 301 到 /admin/ |
| 新 UI 审核队列 (admin.js) | ✅ 已更新 | 使用 POST /action 状态机端点 |
| 后台审核详情 | ✅ 已添加 | modal 视图含候选数据、图片、事件历史 |

## 6. 鉴定

| 问题 | 回答 |
|------|------|
| 线上部署来自哪个 commit？ | **未知** — 需要 NAS 执行 `git rev-parse HEAD` |
| 是否来自脏工作树？ | **未知** — 需要 NAS 执行 `git status --short` |
| 是否从 review branch 手动复制？ | **可能** — 之前前台修改在 `review/phase12-r4` 分支 |
| 是否存在未提交前端文件？ | **未知** — 需要 NAS 检查 |
| WordPress 实际激活的主题目录名？ | **应为 `modelwiki-theme`** |
| 后台实际访问 URL？ | **推测为 `/guanli/` 或 `/admin/`** — 需要 NAS 检查 |
