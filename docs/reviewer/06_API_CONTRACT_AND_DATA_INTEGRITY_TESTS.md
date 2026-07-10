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

## Community integrity

Like/Favorite idempotency；collection state/visibility/quantity/price validation；comments login required、own edit/delete、admin moderation、rate limit、output escaping。
