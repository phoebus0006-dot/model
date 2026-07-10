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

## Production Writes

列出 review status changes、crawler jobs、DB writes、Redis writes、cache purge、user changes。没有则写 `NONE`。

## Constraints for Executor

必须明确禁止：credential changes/output、bulk delete、queue clear、batch crawler、manual DB status edit、mock as production evidence、unrelated UI rewrite。

## Final Acceptance Criteria

写可测条件，不写“修复即可”。
