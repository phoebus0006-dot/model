#!/usr/bin/env python3
"""
images.ts 安全修复脚本
- 添加 SSRF 防护函数
- 添加路径遍历防护
- 修复 BigInt 异常处理
- /proxy 端点增加 rate limit + URL校验
"""
import base64

FILE = "/home/ubuntu/modelwiki/docker/api/src/routes/images.ts"

# SSRF 防护代码（作为单独文件，避免字符串嵌套问题）
SSRF_GUARD = base64.b64decode("""
Ly8gPT09PT0g5aWX6LS15L2c55qEOlVST+eIhuWOh+WVj+aOpVx1MDBhLy8gIyMj
IyMjIOacrOacjeWKqOeIhuWOh1x1MDBhY29uc3QgQUxMT1dFRF9JTUFHRV9IT1NU
UyA9IG5ldyBTZXQoW1x1MDBhICAibWVkaWEubWZjc3RhdGljLmNvbSIsICJzdGF0
aWMubWZjc3RhdGljLmNvbSIsXHUwMGEgICJ3d3cuYW1pYW1pLmNvbSIsICJpbWcu
YW1pYW1pLmNvbSIsXHUwMGEgICJ3d3cuaGxqLmNvbSIsICJtZWRpYS5obGouY29t
IixcdTAwYSAgInd3dy5ob2JieXNlYXJjaC5qcCIsICJpbWFnZS5ob2JieXNlYXJj
aC5qcCIsXHUwMGEgICJ3d3cuZ29vZHNtaWxlLmluZm8iLCAiaW1hZ2VzLmdvb2Rz
bWlsZWNvbXBhbnkuY29tIixcdTAwYSAgInd3dy5hbHRlci1jbHViLmpwIiwgInd3
dy5rb3RvYnVraXlhLmNvLmpwIixcdTAwYSAgInd3dy5hbHBoYW1heC5qcCIsICJ3
d3cud2F2ZS1kcmVhbS5jb20iLFx1MDBhICAid3d3Lm1vYmlwLmpwIiwgImZpZ3Vy
ZXMuY29tIixcdTAwYV0pO1x1MDBhXHUwMGFjb25zdCBCTE9DS0VEX0hPU1RTID0g
bmV3IFNldChbXHUwMGEgICJsb2NhbGhvc3QiLCAiMTI3LjAuMC4xIiwgIjAuMC4w
LjAiLCAiOjoxIixcdTAwYSAgIjE2OS4yNTQuMTY5LjI1NCIsXHUwMGEgICJtZXRh
ZGF0YS5nb29nbGUuaW50ZXJuYWwiLFx1MDBhXSk7XHUwMGFcdTAwYWFmdW5jdGlv
biBpc1ByaXZhdGVJcChpcDogc3RyaW5nKTogYm9vbGVhbiB7XHUwMGEgIGNvbnN0
IHBhcnRzID0gaXAuc3BsaXQoIi4iKS5tYXAoTnVtYmVyKTtcdTAwYSAgaWYgKHBh
cnRzLmxlbmd0aCA9PT0gNCAmJiBwYXJ0cy5ldmVyeShwID0+ICFpc05hTihwKSkp
IHtcdTAwYSAgICBpZiAocGFydHNbMF0gPT09IDEwKSByZXR1cm4gdHJ1ZTtcdTAw
YSAgICBpZiAocGFydHNbMF0gPT09IDE3MiAmJiBwYXJ0c1sxXSA+PSAxNiAmJiBw
YXJ0c1sxXSA8PSAzMSkgcmV0dXJuIHRydWU7XHUwMGEgICAgaWYgKHBhcnRzWzBd
ID09PSAxOTIgJiYgcGFydHNbMV0gPT09IDE2OCkgcmV0dXJuIHRydWU7XHUwMGEg
ICAgaWYgKHBhcnRzWzBdID09PSAxMDAgJiYgcGFydHNbMV0gPj0gNjQgJiYgcGFy
dHNbMV0gPD0gMTI3KSByZXR1cm4gdHJ1ZTtcdTAwYSAgICBpZiAocGFydHNbMF0g
PT09IDApIHJldHVybiB0cnVlO1x1MDBhICAgIGlmIChwYXJ0c1swXSA9PT0gMTI3
KSByZXR1cm4gdHJ1ZTtcdTAwYSAgICBpZiAocGFydHNbMF0gPj0gMjI0KSByZXR1
cm4gdHJ1ZTtcdTAwYSAgIH1cdTAwYSAgcmV0dXJuIGZhbHNlO1x1MDBhfVx1MDBh
XHUwMGFmdW5jdGlvbiB2YWxpZGF0ZUltYWdlVXJsKGltYWdlVXJsOiBzdHJpbmcp
OiB7IG9rOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfSB7XHUwMGEgIHRyeSB7
XHUwMGEgICAgY29uc3QgdSA9IG5ldyBVUkwoaW1hZ2VVcmwpO1x1MDBhICAgIGlm
ICh1LnByb3RvY29sICE9PSAiaHR0cDoiICYmIHUucHJvdG9jb2wgIT09ICJodHRw
czoiKSB7XHUwMGEgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogIk9u
bHkgaHR0cChzKSBVUkxzIGFyZSBhbGxvd2VkIiB9O1x1MDBhICAgIH1cdTAwYSAg
ICBjb25zdCBob3N0ID0gdS5ob3N0bmFtZS50b0xvd2VyQ2FzZSgpO1x1MDBhICAg
IGlmIChCTE9DS0VEX0hPU1RTLmhhcyhob3N0KSkgcmV0dXJuIHsgb2s6IGZhbHNl
LCByZWFzb246ICJCbG9ja2VkIGhvc3QiIH07XHUwMGEgICAgaWYgKGlzUHJpdmF0
ZUlwKGhvc3QpKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogIlByaXZhdGUv
aW50ZXJuYWwgSVAgYmxvY2tlZCIgfTtcdTAwYSAgICByZXR1cm4geyBvazogdHJ1
ZSB9O1x1MDBhICB9IGNhdGNoIChlOiBhbnkpIHtcdTAwYSAgICByZXR1cm4geyBv
azogZmFsc2UsIHJlYXNvbjogIkludmFsaWQgVVJMOiAiICsgKGU/Lm1lc3NhZ2Ug
fHwgIiIpIH07XHUwMGEgIH1cdTAwYX1cdTAwYVx1MDBhLy8gIyMjIyDnpL7lj5gc
5a+55L2c55qEOmphbkNvZGUvc2hhMjU2IOexu+We5+WMlumHh+x1MDBhZnVuY3Rp
b24gdmFsaWRhdGVKYW5Db2RlKGphbkNvZGU6IHN0cmluZyk6IGJvb2xlYW4ge1x1
MDBhICBpZiAoIWphbkNvZGUgfHwgdHlwZW9mIGphbkNvZGUgIT09ICJzdHJpbmci
KSByZXR1cm4gZmFsc2U7XHUwMGEgIGlmICgvW1xcXFwvXS8udGVzdChqYW5Db2Rl
KSkgcmV0dXJuIGZhbHNlO1x1MDBhICBpZiAoamFuQ29kZS5pbmNsdWRlcygiLi4i
KSkgcmV0dXJuIGZhbHNlO1x1MDBhICBpZiAoamFuQ29kZS5sZW5ndGggPiA2NCkg
cmV0dXJuIGZhbHNlO1x1MDBhICByZXR1cm4gL15bQS1aYS16MC05XystXSskLy50
ZXN0KGphbkNvZGUpIHx8IGphbkNvZGUgPT09ICJuby1qYW5jb2RlIjtcdTAwYX1c
dTAwYVx1MDBhZnVuY3Rpb24gdmFsaWRhdGVTaGEyNTYoc2hhMjU2OiBzdHJpbmcp
OiBib29sZWFuIHtcdTAwYSAgaWYgKCFzaGEyNTYgfHwgdHlwZW9mIHNoYTI1NiAh
PT0gInN0cmluZyIpIHJldHVybiBmYWxzZTtcdTAwYSAgcmV0dXJuIC9eW2EtZjAt
OV17NjR9JC9pLnRlc3Qoc2hhMjU2KTtcdTAwYX1cdTAwYVx1MDBhZnVuY3Rpb24g
c2FmZUJpZ0ludCh2YWx1ZTogc3RyaW5nKTogYmlnaW50IHwgbnVsbCB7XHUwMGEg
IHRyeSB7XHUwMGEgICAgaWYgKCEvXi1cXGQrJC8udGVzdCh2YWx1ZSkpIHJldHVy
biBudWxsO1x1MDBhICAgIHJldHVybiBCaWdpbnQodmFsdWUpO1x1MDBhICB9IGNh
dGNoIHtcdTAwYSAgICByZXR1cm4gbnVsbDtcdTAwYSB9XHUwMGEgfVx1MDBhXHUw
MGE=""").decode("utf-8")

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

# 验证文件未被修改过
if "validateImageUrl" in content:
    print("ERROR: file already patched, skipping")
    exit(1)

# 1. 在 downloadImage 之前插入 SSRF guard
marker = "export async function downloadImage(imageUrl: string): Promise<DownloadResult> {"
if marker not in content:
    print("ERROR: cannot find downloadImage marker")
    exit(1)
content = content.replace(marker, SSRF_GUARD + "\n" + marker)

# 2. downloadImage 内部添加 URL 校验
old_download = 'export async function downloadImage(imageUrl: string): Promise<DownloadResult> {\n  return new Promise<DownloadResult>((resolve, reject) => {\n    const proto = imageUrl.startsWith("https") ? https : http;'
new_download = '''export async function downloadImage(imageUrl: string): Promise<DownloadResult> {
  const urlCheck = validateImageUrl(imageUrl);
  if (!urlCheck.ok) {
    return Promise.reject(new Error("URL validation failed: " + (urlCheck.reason || "blocked")));
  }
  return new Promise<DownloadResult>((resolve, reject) => {
    const proto = imageUrl.startsWith("https") ? https : http;'''
if old_download not in content:
    print("ERROR: cannot find downloadImage body marker")
    exit(1)
content = content.replace(old_download, new_download)

# 3. getImageFilePath 添加校验
old_path = '''function getImageFilePath(janCode: string, sha256: string, size: ImageSize): string {
  return path.join(getImageDir(janCode), `${sha256}_${size}.webp`);
}'''
new_path = '''function getImageFilePath(janCode: string, sha256: string, size: ImageSize): string {
  if (!validateJanCode(janCode)) throw new Error("Invalid janCode");
  if (!validateSha256(sha256)) throw new Error("Invalid sha256");
  return path.join(getImageDir(janCode), `${sha256}_${size}.webp`);
}'''
if old_path not in content:
    print("ERROR: cannot find getImageFilePath marker")
    exit(1)
content = content.replace(old_path, new_path)

# 4. /:id 端点 BigInt 异常处理
old_id = '''  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const id = BigInt(req.params.id);

    const image = await app.prisma.figureImage.findUnique({
      where: { id },'''
new_id = '''  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const id = safeBigInt(req.params.id);
    if (id === null) {
      return reply.status(400).send({ success: false, error: { code: "INVALID_ID", message: "Invalid image ID" } });
    }

    const image = await app.prisma.figureImage.findUnique({
      where: { id },'''
if old_id not in content:
    print("ERROR: cannot find /:id marker")
    exit(1)
content = content.replace(old_id, new_id)

# 5. /proxy 端点增加 rate limit + URL校验
old_proxy = '''  app.get<{ Querystring: z.infer<typeof proxyQuerySchema> }>("/proxy", async (req, reply) => {
    const { url } = proxyQuerySchema.parse(req.query);

    try {
      const result = await downloadImage(url);'''
new_proxy = '''  app.get<{ Querystring: z.infer<typeof proxyQuerySchema> }>("/proxy", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req: any, reply: any) => {
    const { url } = proxyQuerySchema.parse(req.query);

    const urlCheck = validateImageUrl(url);
    if (!urlCheck.ok) {
      return reply.status(422).send({
        success: false,
        error: { code: "URL_BLOCKED", message: urlCheck.reason || "URL not allowed" }
      });
    }

    try {
      const result = await downloadImage(url);'''
if old_proxy not in content:
    print("ERROR: cannot find /proxy marker")
    exit(1)
content = content.replace(old_proxy, new_proxy)

# 写入修复后的文件
with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("=== images.ts patched successfully ===")
print("Changes:")
print("  1. Added SSRF guard functions (validateImageUrl, isPrivateIp, BLOCKED_HOSTS)")
print("  2. Added path traversal protection (validateJanCode, validateSha256)")
print("  3. Added safeBigInt helper")
print("  4. downloadImage now validates URL before download")
print("  5. getImageFilePath now validates janCode and sha256")
print("  6. /:id endpoint uses safeBigInt with 400 error")
print("  7. /proxy endpoint has rate limit (30/min) and URL validation")
