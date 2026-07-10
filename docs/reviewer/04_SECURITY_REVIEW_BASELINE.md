# Security Review Baseline

## Credential safety

扫描 current branch、remote heads、tags、env examples、shell scripts、CI、compose、fixtures、logs。发现真实 secret 后：清理公开 refs、轮换真实凭据、验证旧凭据失效。报告中禁止复述 secret。

## Authentication

检查 password hash、login rate limit、disabled user、password reset/change、JWT/session expiration、token invalidation、role enforcement。建议 tokenVersion/credentialsChangedAt 或安全 session 方案。

## SSRF

必须覆盖：127.0.0.1、localhost、10/8、172.16/12、192.168/16、169.254/16、metadata IP、::1、fc00::/7、fe80::/10、IPv4-mapped IPv6、DNS→private、redirect→private、redirect loop、max redirects、DNS rebinding。业务场景优先 allowlist。

## File/Image safety

要求 decoded size limit、真实格式检测、格式白名单、server-side normalize/re-encode、server-side sha256、client hash mismatch reject、safe path、containment、temp write、atomic rename、DB/file partial failure recovery。

## Review cache signing

必须独立 signing secret；production missing secret fail closed；禁止 fallback；exp 为整数且未来时间并限制 max TTL；HMAC 绑定 reviewId/file/expiry；timingSafeEqual；path containment。

## Redis safety

普通管理后台禁止 FLUSHDB/FLUSHALL。cache purge 只能 namespace allowlist + SCAN + UNLINK/DEL。保护 review、crawler、session、rate-limit keys。

## XSS/content

检查 comments/article rich text/admin innerHTML/source text injection/URL schemes。不要为局部修复随意放宽 CSP。

## Audit logging

高风险操作记录 actor/action/target/time/before-after summary/request id。日志禁止 password/token/cookie/Authorization/secret。
