# Evidence and Status Standard

## 核心原则

执行器报告是 claim，不是 evidence。Reviewer 必须独立检查实际代码、diff、运行结果、API、存储状态和浏览器行为。

## 状态定义

### VERIFIED
代码、测试、业务结果和可观察状态一致，没有关键矛盾。

### PARTIAL
只完成一部分闭环。例如 route 已实现但 UI 未验证；job queued 但未运行；DB row 有了但图片 endpoint 不可用。

### FAILED
真实验证失败，例如 404、429、pageerror、DB 未变化、job failed。

### NOT TESTED
没有真实执行证据。

### INCONSISTENT
报告、代码、API、DB、UI 或统计互相冲突。

## 禁止偷换

- local commit ≠ remote state
- HTTP 200 ≠ business correct
- created ≠ executed
- queued ≠ completed
- element exists ≠ action works
- function exists ≠ GUI closure
- API primary image ≠ visual quality passed
- sourceKind/尺寸 metadata ≠ 浏览器真实可见
- README/report ≠ source fix
- mock ≠ production evidence

## 最低证据链

### Action
`before → click/request → response → storage change → readback → refreshed UI`

### Crawler
`create → queued → claimed → running → completed/failed → writeback → review state → API/frontend`

### Image
`candidate source → fetch/cache → content-type/hash/dimensions → preview → lightbox → approve → official asset identity → public detail page`

## 报告必须区分

- code-level
- API-level
- storage-level
- browser-level
- visual-level
- production-level
