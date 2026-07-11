# Review Report Template

## 审核结论

`APPROVE / REQUEST CHANGES / BLOCK RELEASE`

## Scope

- commit:
- files:
- environment:
- production touched: YES/NO

## 状态表

| Area | Status | Evidence |
|---|---|---|
| Repo | | |
| Security | | |
| API contract | | |
| UI | | |
| Review workflow | | |
| Crawler | | |
| Production | | |

状态仅允许：VERIFIED / PARTIAL / FAILED / NOT TESTED / INCONSISTENT。

## 关键问题

每个问题包含：location、behavior、impact、required fix、verification method。

## Evidence

### Code
commit SHA / diff / file-line

### Runtime
command / exit code / summary

### API
endpoint / method / status / business result

### Storage
before / after

### Browser
pageerror / console errors / 401 / 429 / 5xx / request counts

## Product Route Coverage

逐项填写 `IN SCOPE`、`OUT OF SCOPE` 或状态；`OUT OF SCOPE` 不是已通过。

| Priority | Check | Status / Evidence |
|---|---|---|
| P0 | France locale strings and errors | |
| P0 | Manufacturer canonical/native/aliases; Personnage/category/Latest semantics | |
| P0 | Content entity ↔ Figure relation | |
| P1 | display_title/original_title; real breadcrumb; grouped non-empty specs | |
| P1 | Gallery sourceType/tabs/best primary/placeholder | |
| P1 | Studio content separated from community Avis | |
| P2 | Collection/Wishlist auth and idempotency | |
| P2 | Favorite compatibility, migration, or retirement evidence | |
| P2 | One editable rating/avis per user/Figure; overall + four dimensions + sample count | |
| Later | Explorer/Search, homepage, content, community (when in scope) | |

对未实施功能必须写 `NOT TESTED` 或 `OUT OF SCOPE` 并说明原因；不得用计划文档、mock 或静态元素证明上线。

## Production Writes

列出 review status changes、crawler jobs、DB writes、Redis writes、cache purge、user changes。没有则写 `NONE`。

## Crawler Applicability

`APPLICABLE / NOT APPLICABLE`：说明本次是否变更 crawler、导入、补数或写回链路。仅 `APPLICABLE` 时附 exact canary 的 job ID、状态时间线和 writeback 证据，并引用 `07_CRAWLER_CANARY_PROTOCOL.md`；`NOT APPLICABLE` 时不得把缺少 crawler canary 记为发布缺口。

## Constraints for Executor

必须明确禁止：credential changes/output、bulk delete、queue clear、batch crawler、manual DB status edit、mock as production evidence、unrelated UI rewrite。

## Final Acceptance Criteria

写可测条件，不写“修复即可”。
