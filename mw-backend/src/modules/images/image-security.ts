import dns from "dns";

const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1",
  "metadata.google.internal", "169.254.169.254",
  "100.100.100.200", "metadata.internal",
]);

function isPrivateIP(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 0) return true;
  return false;
}

async function resolveAndValidateHost(host: string): Promise<{ ok: boolean; reason?: string; address?: string }> {
  try {
    const addresses = await dns.promises.resolve4(host);
    for (const addr of addresses) {
      if (BLOCKED_HOSTS.has(addr)) return { ok: false, reason: `Blocked IP: ${addr}` };
      if (isPrivateIP(addr)) return { ok: false, reason: `Private IP not allowed: ${addr}` };
    }
    return { ok: true, address: addresses[0] };
  } catch {
    try {
      const addrs = await dns.promises.resolve6(host);
      return { ok: true, address: addrs[0] };
    } catch {
      return { ok: false, reason: "DNS resolution failed" };
    }
  }
}

export async function validateImageUrl(imageUrl: string): Promise<{ ok: boolean; reason?: string; resolvedAddress?: string }> {
  try {
    const u = new URL(imageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "Only http(s) URLs are allowed" };
    const host = u.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: "Blocked host" };
    const resolved = await resolveAndValidateHost(host);
    if (!resolved.ok) return { ok: false, reason: resolved.reason || "Host validation failed" };
    return { ok: true, resolvedAddress: resolved.address };
  } catch (e: any) {
    return { ok: false, reason: "Invalid URL: " + (e?.message || "") };
  }
}
