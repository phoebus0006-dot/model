#!/bin/bash
# 在服务器上准备patch所需文件
set -e

# 1. 创建 SSRF_GUARD 代码片段文件
cat > /tmp/ssrf_guard.ts << 'TSEOF'
// ===== 安全：URL校验，防止SSRF =====
const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1",
  "169.254.169.254",
  "metadata.google.internal",
]);

function isPrivateIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p))) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 127) return true;
    if (parts[0] >= 224) return true;
  }
  return false;
}

function validateImageUrl(imageUrl: string): { ok: boolean; reason?: string } {
  try {
    const u = new URL(imageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: "Only http(s) URLs are allowed" };
    }
    const host = u.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: "Blocked host" };
    if (isPrivateIp(host)) return { ok: false, reason: "Private/internal IP blocked" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: "Invalid URL: " + (e?.message || "") };
  }
}

// ===== 安全：janCode/sha256 格式校验，防止路径遍历 =====
function validateJanCode(janCode: string): boolean {
  if (!janCode || typeof janCode !== "string") return false;
  if (/[\\/]/.test(janCode)) return false;
  if (janCode.includes("..")) return false;
  if (janCode.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(janCode) || janCode === "no-jancode";
}

function validateSha256(sha256: string): boolean {
  if (!sha256 || typeof sha256 !== "string") return false;
  return /^[a-f0-9]{64}$/i.test(sha256);
}

function safeBigInt(value: string): bigint | null {
  try {
    if (!/^-?\d+$/.test(value)) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}

TSEOF

echo "=== /tmp/ssrf_guard.ts created ==="
wc -l /tmp/ssrf_guard.ts
