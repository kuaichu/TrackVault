import { getQqCookieMissingFieldsMessage, validateQqCookie } from "../server/qqmusic-cookie";

export function normalizeQqCookieInput(input: string) {
  return input.trim().replace(/\r?\n+/g, "; ").replace(/;\s*;/g, ";").replace(/;\s*$/g, "");
}

export function validateQqCookieInput(input: string) {
  const normalizedCookie = normalizeQqCookieInput(input);
  const { missingFields } = validateQqCookie(normalizedCookie);
  return { normalizedCookie, missingFields, message: getQqCookieMissingFieldsMessage(missingFields) };
}

export const QQ_COOKIE_EXTRACT_SCRIPT = `(() => {
  const cookie = document.cookie || "";
  const parts = Object.fromEntries(cookie.split(/;\\s*/).map((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : ["", ""];
  }).filter(([key, value]) => key && value));
  const hasUin = Boolean(parts.uin || (Number(parts.login_type) === 2 && parts.wxuin));
  const hasKey = Boolean(parts.qm_keyst || parts.qqmusic_key);
  const missing = [!hasUin && "uin/wxuin", !hasKey && "qm_keyst/qqmusic_key"].filter(Boolean);
  if (missing.length) {
    window.prompt("缺少 " + missing.join("、") + "。请打开 Application / 应用 -> Cookies 面板手动复制这些字段。", "");
    return;
  }
  const tip = "已复制 QQ 音乐 Cookie，回到 TrackVault 点“粘贴并检测”。";
  const fallback = () => window.prompt("自动复制失败，请从 Cookies 面板手动复制。", "");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(cookie).then(() => alert(tip)).catch(fallback);
    return;
  }
  fallback();
})();`;
