# ModelWiki 后端安全审计报告

## 严重高危漏洞（需立即修复）

### H1: SSRF漏洞 - images.ts /proxy 端点完全公开

**位置**: `/home/ubuntu/modelwiki/docker/api/src/routes/images.ts` 第2960行
```typescript
app.get<{ Querystring: z.infer<typeof proxyQuerySchema> }>("/proxy", async (req, reply) => {
  const { url } = proxyQuerySchema.parse(req.query);
  const result = await downloadImage(url);  // 直接下载任意URL！
  ...
});
```

**风险**:
- 任何匿名用户可调用 `/api/v1/figures/images/proxy?url=http://169.254.169.254/latest/meta-data/` 探测云元数据API
- 可扫描内网：`?url=http://192.168.1.1/admin`
- 可访问本机其他服务：`?url=http://localhost:3000/api/v1/admin/users`
- 可触发内部认证服务响应

### H5: BigInt 异常暴露 500 错误

**位置**: images.ts 第2988行, admin.ts 多处
```typescript
const id = BigInt(req.params.id);  // 非数字字符串会抛异常
```

**风险**: 错误请求导致500 INTERNAL_ERROR，可能泄露堆栈信息

### H6: 后端密码强度校验缺失

**位置**: auth.ts changePassword (第473行), admin.ts resetPassword (第1964行)
```typescript
const schema = z.object({ newPassword: z.string().min(8) });  // 只校验8位
```

**风险**: 可通过API直接设置弱密码（如`password`、`12345678`），绕过前端校验

### M1: 评论存储型XSS

**位置**: community.ts POST /figures/:slug/comments (第2426行)
```typescript
const { body } = commentSchema.parse(req.body);  // 只校验长度
const comment = await prisma.figureComment.create({
  data: { userId: user.id, figureId: figure.id, body },  // 原文存储
});
```

**风险**: 若任何前端模板用innerHTML渲染评论，触发XSS

### M2/M4: Mass Assignment & IDOR

**位置**: admin.ts review apply (第1449行)
```typescript
const { categoryIds, sculptorIds, characterIds, images, localized, releases, releaseDate, ...figureData } = figurePayload;
// figureData 直接 spread 到 prisma.figure.create/update
```

**风险**: 攻击者构造figurePayload时可注入 `isDeleted: true`, `id: <任意>`, `createdAt: <任意时间>` 等字段

### M8: 路径遍历漏洞

**位置**: images.ts getImageFilePath (第2546行)
```typescript
function getImageFilePath(janCode: string, sha256: string, size: ImageSize): string {
  return path.join(ASSETS_PATH, "figures", janCode, `${sha256}_${size}.webp`);
}
```

**风险**: 若janCode传入 `../../../etc/passwd`，可写到任意路径

### 其他问题

- **H7**: 缺乏editor/viewer权限细分，所有写操作都要求admin
- **H8**: admin可自我降级或降级最后一个admin
- **H9**: displayName查询未做大小写归一化
- **M3**: 缓存键膨胀（每个query组合一个key）
- **M4**: review apply 缺乏所有权校验
- **L1**: helmet CSP对API意义不大
- **L4**: 缺乏审计日志

## 修复方案

见 `apply_security_fixes.sh` 脚本
