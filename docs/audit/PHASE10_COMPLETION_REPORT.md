# Phase 10 Completion Report

## 1. 结论

```
PARTIAL_WITH_FORWARD_PROGRESS
```

## 2. Dead scaffolding 检查

| 文件 | 生产调用方 | 测试调用方 | 结论 |
|------|-----------|-----------|------|
| `apply-lock.ts` | ❌ 仅被 `apply-service.ts` 引用 | ✅ apply-lock.test.ts | **DEAD_SCAFFOLDING** |
| `apply-errors.ts` | ❌ 仅被 `apply-service.ts` 引用 | ❌ | **DEAD_SCAFFOLDING** |
| `apply-types.ts` | ❌ 仅被 `apply-service.ts` 引用 | ❌ | **DEAD_SCAFFOLDING** |
| `apply-service.ts` | ❌ 不被任何生产代码引用 | ❌ | **DEAD_SCAFFOLDING** |
| `apply-route.ts` | ❌ (回退到 apply-handler.ts) | ❌ | **DEAD_SCAFFOLDING** |
| `image-service.ts` | ❌ 不被 images.ts 或 apply 引用 | ❌ | **DEAD_SCAFFOLDING** |

## 3. 生产调用链

当前实际调用链：

```
HTTP route → apply-handler.ts → inline Redis/Prisma/sharp (32 KB 单体)
```

目标调用链：

```
HTTP route → apply-route.ts (lock + errors) → apply-service.ts → dependencies → image-service
```

锁和错误类型已设计，但 32 KB 的 `apply-handler.ts` 需要逐步分解才能嵌入新链路。

## 4. Apply 拆分进度

| 职责 | 拆分前 | 当前 | 下一步 |
|------|--------|------|--------|
| HTTP 路由 | `apply-handler.ts` | `apply-handler.ts` | 移入 `apply-route.ts` |
| 锁 | 无 | `apply-lock.ts` | 接入路由 |
| 领域错误 | 内联 | `apply-errors.ts` | 替换内联错误 |
| 编排 | 无 | `apply-service.ts` | 从 handler 提取 |
| 图片处理 | 内联 | `image-service.ts` | 替换内联 sharp 调用 |
| 测试 | 0 | 8 (锁) + 14 (安全) | 加编排测试 |

## 5. 关键测试

| 类别 | 测试数 | 结果 |
|------|--------|------|
| 锁原子获取/释放 | 8 | ✅ |
| 图片安全 URL 校验 | 14 | ✅ |
| 全部测试 | 170 (17 files) | ✅ |

## 6. 验证结果

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `npm run test` | 0 | 170/170 ✅ |
| `npm run test:app-startup` | 0 | 4/4 ✅ |
| `npm run build` | 0 | ✅ |
| `npx tsc --noEmit` | 0 | ✅ |
| `npm run admin-js-check` | 0 | ALL PASS ✅ |

## 7. 下一步

```
Phase 11:
- v apply-route.ts 替代 apply-handler.ts，附带锁
- apply-handler.ts 中业务逻辑逐步提取到 apply-service.ts
- 共享图片层真实接入 apply 和 images API
- 前端 Figure 详情页 MVP + Home 阈值 + Explorer
- 清除所有 DEAD_SCAFFOLDING
```
