import { AppError } from "../../../domain/errors.js";
import type { ProviderAuthContext } from "../../../domain/ports/music-provider.js";
import type { KugouEdition } from "./kugou-crypto.js";

export interface KugouCookieMap {
  userid: string;
  token: string;
  kg_edition: KugouEdition;
  vip_type?: string;
  vip_token?: string;
  dfid?: string;
  t1?: string;
}

const ESSENTIAL_KUGOU_KEYS = [
  "userid",
  "token",
  "kg_edition",
  "vip_type",
  "vip_token",
  "dfid",
  "t1",
] as const;

export function extractEssentialKugouCookie(rawCookie: string): Partial<KugouCookieMap> {
  const trimmed = rawCookie.trim();
  if (!trimmed) return {};

  const map: Record<string, string> = {};

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      for (const [k, v] of Object.entries(json)) {
        if (v !== undefined && v !== null && String(v).trim() !== "") {
          map[k.trim().toLowerCase()] = String(v).trim();
        }
      }
    } catch {
      // Fall through to key=value parsing
    }
  }

  if (Object.keys(map).length === 0) {
    const pairs = trimmed.split(/[;&\r\n]+/);
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = pair.slice(0, eqIdx).trim().toLowerCase();
      let val = pair.slice(eqIdx + 1).trim();
      try {
        val = decodeURIComponent(val);
      } catch {
        // Keep raw value if malformed percent encoding
      }
      if (key && val) {
        map[key] = val;
      }
    }
  }

  const rawUid = (map.userid ?? map.kugouid ?? map.uid ?? "").replace(/\D/g, "");
  const userid = rawUid && rawUid !== "0" ? rawUid : undefined;
  const token = (map.token ?? map.clienttoken ?? "").trim() || undefined;

  let edition: KugouEdition | undefined;
  const rawEdition = (map.kg_edition ?? map.edition ?? map.platform ?? "").toLowerCase();
  const rawAppid = map.appid ?? "";
  if (rawEdition === "standard" || rawEdition === "std" || rawAppid === "1005") {
    edition = "standard";
  } else if (rawEdition === "lite" || rawEdition === "concept" || rawAppid === "3116") {
    edition = "lite";
  }

  return {
    ...(userid ? { userid } : {}),
    ...(token ? { token } : {}),
    ...(edition ? { kg_edition: edition } : {}),
    ...(map.vip_type ? { vip_type: map.vip_type } : {}),
    ...(map.vip_token ? { vip_token: map.vip_token } : {}),
    ...(map.dfid && map.dfid !== "-" ? { dfid: map.dfid } : {}),
    ...(map.t1 ? { t1: map.t1 } : {}),
  };
}

export function serializeKugouCookie(cookie: Partial<KugouCookieMap>): string {
  const parts: string[] = [];
  for (const key of ESSENTIAL_KUGOU_KEYS) {
    const val = cookie[key];
    if (val !== undefined && String(val).trim() !== "") {
      parts.push(`${key}=${String(val).trim()}`);
    }
  }
  return parts.join("; ");
}

export function parseKugouAuthCookie(auth: ProviderAuthContext): KugouCookieMap | null {
  if (!auth.cookie?.trim()) return null;
  const parsed = extractEssentialKugouCookie(auth.cookie);
  if (!parsed.userid || !parsed.token) return null;
  return {
    userid: parsed.userid,
    token: parsed.token,
    kg_edition: parsed.kg_edition ?? "lite",
    ...(parsed.vip_type ? { vip_type: parsed.vip_type } : {}),
    ...(parsed.vip_token ? { vip_token: parsed.vip_token } : {}),
    ...(parsed.dfid ? { dfid: parsed.dfid } : {}),
    ...(parsed.t1 ? { t1: parsed.t1 } : {}),
  };
}

export function requireKugouAuthCookie(auth: ProviderAuthContext): KugouCookieMap {
  const parsed = parseKugouAuthCookie(auth);
  if (!parsed) {
    throw new AppError(
      "CREDENTIAL_REQUIRED",
      "请先在「账号绑定」中绑定酷狗音乐账号（扫码或粘贴含 userid 与 token 的 Cookie）。",
    );
  }
  return parsed;
}
