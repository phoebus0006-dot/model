# BigInt Audit

## Global Fix

`BigInt.prototype.toJSON` is installed in `src/routes/admin.ts:6-10`. All BigInt values in `res.send()` calls are serialized as strings.

## Conversion Audit Results

| File:Line (before) | Expression | Context | Risk | Fix | Status |
|-------------------|-----------|---------|------|-----|--------|
| admin.ts:868 | `Number(fig.id)` | Review list response DTO | Precision loss in API response | ✅ `String(fig.id)` | RESOLVED |
| admin.ts:1149/1164 | `Number(item.figureId)` | Crawler job payload | Precision loss in Redis JSON | ✅ `String(item.figureId)` | RESOLVED |
| admin.ts:1515 | `Number(figure.id)` | Apply image processing stack | Precision loss | ✅ `String(figure.id)` | RESOLVED |
| admin.ts:1591 | `Number(savedFigure.id)` | Apply figure_import response | Precision loss in API response | ✅ `String(savedFigure.id)` | RESOLVED |
| admin.ts:1607 | `Number(figure.id)` | Apply image response (images_imported) | Precision loss in API response | ✅ `String(figure.id)` | RESOLVED |
| admin.ts:1639 | `Number(figure.id)` + `Number(existing.id)` | Apply image_review response | Precision loss in API response | ✅ `String(...)` | RESOLVED |
| admin.ts:1711 | `Number(figure.id)` | Apply image response (image_approved) | Precision loss in API response | ✅ `String(figure.id)` | RESOLVED |

**Total: 8 conversions identified and fixed. Zero remaining.**

## Verification

- `Select-String -Path "src\routes\admin.ts" -Pattern "Number\(fig|Number\(id|Number\(image|Number\(user|Number\(item"` → **No results**
- All `Number()` in admin.ts are now only Zod schema type definitions (e.g., `z.number().int()`), not runtime conversions
- Migration DTO parser uses `BigInt()` for safe conversion
- PostgresReviewStore uses `BigInt(String(input))` pattern

## Remaining Risk

- `BigInt.prototype.toJSON` is a global prototype modification — safe but implicit
- `z.number()` in schemas means the API still accepts Number input for IDs (though output is always String)
- This is acceptable for backward compatibility but should be monitored
