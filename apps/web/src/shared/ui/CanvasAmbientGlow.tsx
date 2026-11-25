import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { sanitizeExternalUrl } from "#shared";
import { type ResolvedTheme, useThemeStore } from "../store/theme-store.js";

export const MAIN_AMBIENT_SLOT_ID = "tv-main-ambient-slot";

interface RgbTuple {
  r: number;
  g: number;
  b: number;
}

interface ExtractedHslPair {
  primary: [number, number, number];
  secondary: [number, number, number];
}

const hslCache = new Map<string, ExtractedHslPair>();

const DEFAULT_HSL_PAIR: ExtractedHslPair = {
  primary: [350, 0.48, 0.3],
  secondary: [225, 0.36, 0.28],
};

function rgbToHsl(r255: number, g255: number, b255: number): [number, number, number] {
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d < 1e-5) {
    return [230, 0, l];
  }

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  } else if (max === g) {
    h = ((b - r) / d + 2) * 60;
  } else {
    h = ((r - g) / d + 4) * 60;
  }
  return [h, s, l];
}

function hslToRgb(hDeg: number, s: number, l: number): RgbTuple {
  const h = ((hDeg % 360) + 360) % 360;
  if (s <= 0.001) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function clampAmbientHsl([h, s, l]: [number, number, number], theme: ResolvedTheme): RgbTuple {
  if (theme === "dark") {
    // Cap lightness strictly to 25%–34% so bright/cream/white covers never wash out or turn muddy gray
    const clampedL = Math.min(0.34, Math.max(0.25, l * 0.68 + 0.09));
    const clampedS = Math.min(0.68, Math.max(s > 0.05 ? 0.24 : 0.08, s * 1.2));
    return hslToRgb(h, clampedS, clampedL);
  }
  const clampedL = Math.min(0.76, Math.max(0.6, l));
  const clampedS = Math.min(0.54, Math.max(s > 0.05 ? 0.2 : 0.06, s));
  return hslToRgb(h, clampedS, clampedL);
}

function toThumbUrl(url: string): string {
  return url.replace(/param=\d+y\d+/, "param=120y120").replace(/T002R\d+x\d+/, "T002R300x300");
}

function extractHslFromImageData(data: Uint8ClampedArray): ExtractedHslPair {
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let wSum = 0;

  let rSec = 0;
  let gSec = 0;
  let bSec = 0;
  let wSec = 0;

  const pixelCount = Math.floor(data.length / 4);
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4;
    const a = data[offset + 3] ?? 255;
    if (a < 128) continue;

    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;
    const [, s, l] = rgbToHsl(r, g, b);

    // Down-weight near-pure-white paper & near-pure-black shadows so subtle cover pigments win
    let weight = 0.2 + s * 2.4;
    if (l > 0.92 && s < 0.1) weight = 0.04;
    else if (l < 0.06) weight = 0.04;
    else if (l > 0.82 && s < 0.15) weight *= 0.25;

    const col = i % 16;
    if (col < 10) {
      rSum += r * weight;
      gSum += g * weight;
      bSum += b * weight;
      wSum += weight;
    } else {
      rSec += r * weight;
      gSec += g * weight;
      bSec += b * weight;
      wSec += weight;
    }
  }

  const primaryHsl = wSum > 0 ? rgbToHsl(rSum / wSum, gSum / wSum, bSum / wSum) : DEFAULT_HSL_PAIR.primary;
  const secondaryHsl =
    wSec > 0
      ? rgbToHsl(rSec / wSec, gSec / wSec, bSec / wSec)
      : ([primaryHsl[0] + 22, primaryHsl[1] * 0.9, primaryHsl[2]] as [number, number, number]);

  return { primary: primaryHsl, secondary: secondaryHsl };
}

/**
 * Full-bleed Apple Music canvas ambient aura.
 * Portals to `#tv-main-ambient-slot` on `<main>` (edge-to-edge from sidebar to right window border,
 * reaching up behind `< >` and theme buttons) with HSL lightness clamping + radial & bottom linear mask.
 */
export function CanvasAmbientGlow({ coverUrl }: { coverUrl?: string }) {
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const safeUrl = sanitizeExternalUrl(coverUrl);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const [hslPair, setHslPair] = useState<ExtractedHslPair>(() =>
    safeUrl ? (hslCache.get(safeUrl) ?? DEFAULT_HSL_PAIR) : DEFAULT_HSL_PAIR,
  );

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    setSlotEl(document.getElementById(MAIN_AMBIENT_SLOT_ID));
  }, []);

  useEffect(() => {
    if (!safeUrl) return;
    const cached = hslCache.get(safeUrl);
    if (cached) {
      setHslPair(cached);
      return;
    }
    if (typeof Image === "undefined" || typeof document === "undefined") return;

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";

    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 16, 16);
        const { data } = ctx.getImageData(0, 0, 16, 16);
        const extracted = extractHslFromImageData(data);
        hslCache.set(safeUrl, extracted);
        if (!cancelled) {
          setHslPair(extracted);
        }
      } catch {
        // Ignore cross-origin canvas taint if an upstream CDN ever omits ACAO
      }
    };

    img.src = toThumbUrl(safeUrl);
    return () => {
      cancelled = true;
    };
  }, [safeUrl]);

  if (!safeUrl) return null;

  const p = clampAmbientHsl(hslPair.primary, resolvedTheme);
  const s = clampAmbientHsl(hslPair.secondary, resolvedTheme);
  const primaryAlpha = resolvedTheme === "dark" ? 0.42 : 0.22;
  const midAlpha = resolvedTheme === "dark" ? 0.16 : 0.08;
  const secondaryAlpha = resolvedTheme === "dark" ? 0.2 : 0.12;

  const auraNode = (
    <div
      aria-hidden="true"
      className={
        slotEl
          ? "pointer-events-none absolute inset-0 transition-all duration-700"
          : "pointer-events-none absolute inset-x-0 -top-10 z-0 h-[580px] transition-all duration-700"
      }
      style={{
        background: [
          `radial-gradient(ellipse 80% 70% at 28% 34%, rgba(${p.r}, ${p.g}, ${p.b}, ${primaryAlpha}) 0%, rgba(${p.r}, ${p.g}, ${p.b}, ${midAlpha}) 44%, transparent 74%)`,
          `radial-gradient(ellipse 58% 50% at 64% 22%, rgba(${s.r}, ${s.g}, ${s.b}, ${secondaryAlpha}) 0%, transparent 68%)`,
        ].join(", "),
        maskImage: "linear-gradient(to bottom, black 0%, black 45%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 45%, transparent 100%)",
      }}
    />
  );

  return slotEl ? createPortal(auraNode, slotEl) : auraNode;
}
