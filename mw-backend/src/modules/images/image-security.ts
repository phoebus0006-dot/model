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

export function isPrivateIPv6(ip: string): boolean {
  if (ip === "::1" || ip === "[::1]") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true;
  if (ip.startsWith("::ffff:")) {
    const mapped4 = ip.replace(/^::ffff:/, "");
    return isPrivateIP(mapped4);
  }
  if (ip.startsWith("::ffff:0:")) {
    const mapped4 = ip.replace(/^::ffff:0:/, "");
    return isPrivateIP(mapped4);
  }
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
      for (const addr of addrs) {
        if (BLOCKED_HOSTS.has(addr)) return { ok: false, reason: `Blocked IPv6: ${addr}` };
        if (isPrivateIPv6(addr)) return { ok: false, reason: `Private IPv6 not allowed: ${addr}` };
      }
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

    if (host === "::1" || host === "[::1]") return { ok: false, reason: "Blocked IPv6 loopback" };

    const resolved = await resolveAndValidateHost(host);
    if (!resolved.ok) return { ok: false, reason: resolved.reason || "Host validation failed" };

    if (resolved.address) {
      const ipv6 = resolved.address.includes(":");
      if (ipv6 && isPrivateIPv6(resolved.address)) return { ok: false, reason: `Private IPv6 not allowed: ${resolved.address}` };
    }

    return { ok: true, resolvedAddress: resolved.address };
  } catch (e: any) {
    return { ok: false, reason: "Invalid URL: " + (e?.message || "") };
  }
}
