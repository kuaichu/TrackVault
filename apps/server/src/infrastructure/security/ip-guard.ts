import net from "node:net";

export function stripIpBrackets(raw: string): string {
  return raw.trim().replace(/^\[|\]$/g, "");
}

function parseIpv4ToUint32(ip: string): number | null {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function isPrivateOrReservedIpv4Uint32(val: number): boolean {
  const a = (val >>> 24) & 0xff;
  const b = (val >>> 16) & 0xff;
  const c = (val >>> 8) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // Link-local / cloud metadata 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24
  if (a >= 224) return true; // Multicast & reserved 224/4, 240/4
  return false;
}

function parseIpv6ToGroups(raw: string): number[] | null {
  const clean = stripIpBrackets(raw).split("%")[0]?.toLowerCase() ?? "";
  if (!net.isIPv6(clean)) return null;

  let work = clean;
  const lastColon = work.lastIndexOf(":");
  if (lastColon >= 0 && work.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4ToUint32(work.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    work = `${work.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = work.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;

  const full = [...left, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...right];
  if (full.length !== 8) return null;

  const groups = full.map((g) => Number.parseInt(g, 16));
  if (groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return groups;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = stripIpBrackets(ip).toLowerCase();
  const ipv4 = parseIpv4ToUint32(normalized);
  if (ipv4 !== null) {
    return isPrivateOrReservedIpv4Uint32(ipv4);
  }

  const g = parseIpv6ToGroups(normalized);
  if (!g) {
    return true;
  }

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const lower32 = ((g6 << 16) | g7) >>> 0;

  // ::/128 unspecified & ::1/128 loopback
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    if (g6 === 0 && (g7 === 0 || g7 === 1)) return true;
    // Deprecated IPv4-compatible ::/96
    return isPrivateOrReservedIpv4Uint32(lower32);
  }
  // IPv4-mapped ::ffff:0:0/96 (both dotted and fully expanded hex forms)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateOrReservedIpv4Uint32(lower32);
  }
  // IPv4-translated ::ffff:0:0:0/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isPrivateOrReservedIpv4Uint32(lower32);
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateOrReservedIpv4Uint32(lower32);
  }
  // NAT64 local-use prefix 64:ff9b:1::/48
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) {
    return true;
  }
  // Discard prefix 100::/64
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return true;
  }
  // Documentation 2001:db8::/32
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return true;
  }
  // 6to4 2002::/16 (check embedded IPv4 in bits 16..47)
  if (g0 === 0x2002) {
    const embeddedV4 = ((g1 << 16) | g2) >>> 0;
    return isPrivateOrReservedIpv4Uint32(embeddedV4);
  }
  // Unique Local Addresses fc00::/7
  if ((g0 & 0xfe00) === 0xfc00) {
    return true;
  }
  // Link-local fe80::/10 & deprecated site-local fec0::/10
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) {
    return true;
  }
  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}
