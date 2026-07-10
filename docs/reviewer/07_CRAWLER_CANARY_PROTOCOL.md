# Crawler Canary Protocol

## 定位

Crawler 主要用于冷启动和少量后续补全。禁止把大规模 crawler 运行当默认验证方法。

## 前提

确认 agent version、repo/agent contract、queue size、exact canary、真实 source ID、before state、历史 canary 冲突。

## Canary 选择

最多 1 image_missing、1 image_low_count、1 detail_missing/detail_sparse。必须是真实 pending item，有可信 source identity，不是 manual-only，不复用历史 canary，除非有明确理由。

## Payload

- image_missing: needImages=true, needDetails=false
- image_low_count: needImages=true, needDetails=false
- detail_missing/sparse: needImages=false, needDetails=true

## Job evidence

真实观察 `queued → claimed → running → completed|failed|deferred`，记录 jobId/reviewId/source/sourceId/runner/时间线/resultSummary/error。

## Before/After

图片：count、IDs、sourceKind、width、height、sha256、URL/file、endpoint、primary、review state。

详情：description、manufacturer、series、scale、material、height、specs、missing fields、review state。

## 禁止

手工改 DB、改 job status、fake completed、mock production、queued=completed、新建大量 job、batch run、queue clear。

## Agent 安全模式

队列存在历史 jobs 时，必须支持 exact `--job-id` 或 server-side allowlist claim。Canary 模式只能消费指定 job。
