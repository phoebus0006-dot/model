#!/usr/bin/env python3
"""应用 images.ts 安全修复"""
import sys

FILE = "/home/ubuntu/modelwiki/docker/api/src/routes/images.ts"
GUARD_FILE = "/tmp/ssrf_guard.ts"

with open(GUARD_FILE, "r", encoding="utf-8") as f:
    SSRF_GUARD = f.read()

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

if "validateImageUrl" in content:
    print("ERROR: file already patched")
    sys.exit(1)

# 1. 在 downloadImage 之前插入 SSRF guard
marker = "export async function downloadImage(imageUrl: string): Promise<DownloadResult> {"
if marker not in content:
    print("ERROR: cannot find downloadImage marker")
    sys.exit(1)
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
    sys.exit(1)
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
    sys.exit(1)
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
    sys.exit(1)
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
    sys.exit(1)
content = content.replace(old_proxy, new_proxy)

# 写入修复后的文件
with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("=== images.ts patched successfully ===")
