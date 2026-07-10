# Known Risks and Open Questions

## P0 / High Priority

### Source provenance
生产 guanli artifact 与 repo source SHA 不同，build/minify/deploy chain 是否可复现待确认。状态：`NOT VERIFIED`。

### NAS agent drift
repo agent 与 NAS agent 不一致。状态：`INCONSISTENT`。不要直接同步启动，先支持 exact canary claim。

### Crawler closure
queued jobs 尚未证明执行和 writeback。状态：`NOT TESTED`。

### Cache purge safety
确认后台 cache purge 不会 FLUSHDB/FLUSHALL，也不会碰 review/crawler/session/rate-limit keys。状态：`REVIEW REQUIRED`。

### Review cache signing
独立 secret、no fallback、TTL、timing-safe compare、path safety。状态：`REVIEW REQUIRED`。

### SSRF
DNS resolution、IPv6、redirect validation、rebinding。状态：`REVIEW REQUIRED`。

### Candidate asset identity
必须证明 `review candidate = preview = lightbox = approved asset = official FigureImage`。状态：`REVIEW REQUIRED`。

## P1

### Human decision memory
需要 evidence fingerprint、suppression、reopen rule。

### request_refetch concurrency
需要 per-review lock、atomic job/review linking、double-click protection。

### Review current state
确认 current Figure data、original evidence、current state 分离，避免 stale snapshot 误导审核员。

## 产品扩展问题

### Collection model
后续明确 one Figure one state、group 与 status 是否共存、quantity 语义、公开默认值。

### Review article model
明确 WordPress article 是否为 canonical content source、backend relation table、article taxonomy、editor workflow。

### Search architecture
是否引入专用搜索引擎应根据真实数据规模决定，不提前过度设计。
