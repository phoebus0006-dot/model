# Production Change Safety Protocol

## 变更顺序

`read-only diagnosis → local change → unit/integration tests → reviewer diff review → local/staging smoke → production canary → verify → limited rollout → verify → full rollout`

## 数据修复

必须 backup/snapshot、dry-run、affected count、sample、rollback plan、canary subset、after stats。禁止 blind bulk UPDATE、DELETE queue、手工 DB 状态模拟流程。

## Cache

明确区分 cache、review state、crawler jobs、session、rate limit。管理后台清缓存只能清 cache namespace。

## Deployment provenance

部署应能回答 source commit SHA、build command、tool/version、artifact SHA、deploy time、running version。Minified artifact 与 source SHA 不同不等于不一致，但必须可追踪。

## Production UI

未经批准不要改稳定 login/layout/navigation/action availability。UI 改动必须 syntax check、Playwright smoke、network check、rollback artifact。

## Secrets

执行器不得输出；Reviewer 不复述；修改需授权；已泄露需轮换；轮换后验证旧值失效。

## Emergency Stop

出现 401 storm、429 storm、5xx increase、white screen、review count 异常、crawler unexpected claim、DB row unexpected delta、image write spike、source state unknown，立即停止扩大变更。
