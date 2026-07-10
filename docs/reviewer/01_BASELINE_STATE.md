# Baseline State Snapshot

> Snapshot date: 2026-07-10。该文件是历史基线，新 Reviewer 必须重新验证易变状态。

## Repository

最近基线：远程主要分支为 `main`；产品与架构基线已进入 `docs/`。曾进行凭据清理和历史处理。禁止在后续报告复述任何旧密码、hash、token、secret。

## Local worktree

最近已知本地曾有 `mw-backend/package.json` 未提交修改，内容涉及 typecheck/admin JS check。状态：`REVIEW REQUIRED`。禁止自动 reset/restore/clean，必须先审 diff。

## Production guanli

生产 artifact 与 repo source SHA 不同，生产版本为 minified/bundled 形式。SHA 不同本身不能证明业务不一致，但缺少完整可复现 provenance。状态：`PROVENANCE NOT VERIFIED`。

## Backend contract

最近报告显示 review list/update/action/recheck/apply、image-proxy、cache-candidate、crawler job APIs 基本存在。未来必须重新核查 repo 与 production，不继承结论。

## NAS agent

最近已知 repo agent 与 NAS deployed agent 不一致，NAS 上为较旧版本。状态：`INCONSISTENT`。不要直接同步并启动，因为队列里存在 queued jobs。

## Crawler closure

最近真实状态是 canary job 停留 queued，NAS agent 未 pickup。状态：`NOT TESTED`。queued 不能算 closure。

## Review queue

旧 dry-run 曾错误地把 `0 images`、`0 description` 归入 `insufficient_evidence`。正确原则：对 image_missing，0 image 是直接问题证据；对 missing_description，空 description 是直接问题证据。

## Candidate/image flow

历史问题：MFC 直链 Cloudflare/CORP、302 fallback 不等于浏览器可见、proxy 曾产生请求风暴、preview/lightbox/cache identity 尚需统一。

## Security open items

重点复查：cache purge 是否存在 FLUSHDB/FLUSHALL；review cache signing 是否独立 secret 且 fail closed；外部图片 SSRF 防护；processed image hash/format/path 校验；生产凭据轮换真实状态。

## UI 历史事故

曾发生 JS syntax error 白屏和图片代理请求风暴。因此任何 UI 改动至少要 node syntax check、Playwright smoke、network count、pageerror/401/429/5xx 检查。
