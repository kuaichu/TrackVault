import type { TransferTrack } from "#shared";

export type VersionTag = "instrumental" | "live" | "remix" | "acoustic" | "cover";

const PUNCTUATION_RE = /[\s·・._\-—–:：'"!！?？,，()（）[\]【】]/g;

function cleanMatchChars(source: string): string {
  return source.replace(PUNCTUATION_RE, "").trim();
}

export function normalizeMatchText(value: string | undefined): string {
  const base = (value ?? "").toLocaleLowerCase().normalize("NFKC");
  const withoutBrackets = base.replace(/[（(][^）)]*[）)]|[\[【][^\]】]*[\]】]/g, "");

  // If stripping parentheticals/brackets leaves an empty string (e.g. "(Intro)"),
  // keep the inner text so distinct parenthesized titles never collide as "".
  const stripped = cleanMatchChars(withoutBrackets);
  return stripped || cleanMatchChars(base);
}

/**
 * Version-preserving normalization used for deduplication when tracks lack a platform ID
 * so "Song" and "Song (Live)" remain distinct recordings.
 */
export function normalizeVersionPreservingText(value: string | undefined): string {
  const base = (value ?? "").toLocaleLowerCase().normalize("NFKC");
  return cleanMatchChars(base);
}

/**
 * Builds a transfer deduplication key that prioritizes platform track IDs first,
 * and preserves version qualifiers (e.g. Live / Remix / Acoustic) when IDs are absent.
 */
export function buildTransferDedupKey(track: TransferTrack): string {
  const trackId = track.sourceTrackId?.trim();
  if (trackId) {
    return `${track.source}:${trackId}`;
  }
  const titleKey = normalizeVersionPreservingText(track.title);
  const artistKey = track.artists
    .map((a) => normalizeMatchText(a))
    .filter(Boolean)
    .sort()
    .join(",");
  return `meta:${titleKey}::${artistKey}`;
}

export function extractVersionTags(rawTitle: string | undefined): Set<VersionTag> {
  const tags = new Set<VersionTag>();
  if (!rawTitle) return tags;
  const normalized = rawTitle.toLocaleLowerCase().normalize("NFKC");

  // Inspect bracketed/parenthesized annotations and trailing "- qualifier" suffixes
  const segments: string[] = [];
  for (const m of normalized.matchAll(/[（(]([^）)]+)[）)]|[\[【]([^\]】]+)[\]】]/g)) {
    const seg = (m[1] ?? m[2] ?? "").trim();
    if (seg) segments.push(seg);
  }
  const dashSuffix = normalized.match(/\s+[-—–]\s+([^()（）[\]【】]{2,30})$/);
  if (dashSuffix?.[1]) {
    segments.push(dashSuffix[1].trim());
  }

  for (const seg of segments) {
    if (
      /\b(?:instrumental|karaoke|off\s*vocal|inst\.?|backing\s*track)\b|伴奏|纯音乐|消音|卡拉ok/i.test(seg)
    ) {
      tags.add("instrumental");
    }
    if (/\b(?:live|concert)\b|现场|演唱会/i.test(seg)) {
      tags.add("live");
    }
    if (/\b(?:remix|dj|mashup|club\s*mix|radio\s*edit)\b|混音/i.test(seg)) {
      tags.add("remix");
    }
    if (/\b(?:acoustic|unplugged)\b|不插电|吉他版|钢琴版/i.test(seg)) {
      tags.add("acoustic");
    }
    if (/\bcover\b|翻唱/i.test(seg)) {
      tags.add("cover");
    }
  }

  return tags;
}

/**
 * Expands an artist string into canonical exact-match aliases (outer name + parenthesized alias),
 * without allowing arbitrary substring prefix collisions like "张杰" vs "张杰伦" or "Mark" vs "Mark Ronson".
 */
export function expandArtistAliases(raw: string): string[] {
  const base = raw.toLocaleLowerCase().normalize("NFKC").trim();
  if (!base) return [];

  const aliases = new Set<string>();
  const whole = cleanMatchChars(base);
  if (whole) aliases.add(whole);

  const outer = cleanMatchChars(base.replace(/[（(][^）)]*[）)]|[\[【][^\]】]*[\]】]/g, ""));
  if (outer) aliases.add(outer);

  for (const m of base.matchAll(/[（(]([^）)]+)[）)]|[\[【]([^\]】]+)[\]】]/g)) {
    const inner = cleanMatchChars(m[1] ?? m[2] ?? "");
    if (inner.length >= 2) {
      aliases.add(inner);
    }
  }

  return [...aliases];
}

export function hasArtistOverlap(
  sourceArtists: readonly string[],
  targetArtists: readonly string[],
): boolean {
  if (sourceArtists.length === 0 || targetArtists.length === 0) {
    return false;
  }

  const targetAliases = new Set<string>();
  for (const raw of targetArtists) {
    for (const alias of expandArtistAliases(raw)) {
      targetAliases.add(alias);
    }
  }

  if (targetAliases.size === 0) return false;

  for (const raw of sourceArtists) {
    for (const alias of expandArtistAliases(raw)) {
      if (targetAliases.has(alias)) {
        return true;
      }
    }
  }

  return false;
}

export function buildCanonicalArtistKey(rawArtists: readonly string[]): string {
  const set = new Set<string>();
  for (const raw of rawArtists) {
    for (const alias of expandArtistAliases(raw)) {
      set.add(alias);
    }
  }
  return [...set].sort().join("|");
}

export interface PreNormalizedTrack {
  readonly track: TransferTrack;
  readonly title: string;
  readonly rawArtists: readonly string[];
  readonly artistAliases: readonly string[];
  readonly canonicalArtistKey: string;
  readonly versionTags: Set<VersionTag>;
  readonly versionKey: string;
  readonly canonicalTrackKey: string;
}

export function preNormalizeTrack(track: TransferTrack): PreNormalizedTrack {
  const title = normalizeMatchText(track.title);
  const versionTags = extractVersionTags(track.title);
  const versionKey = [...versionTags].sort().join(",");
  const aliasSet = new Set<string>();
  for (const raw of track.artists) {
    for (const alias of expandArtistAliases(raw)) {
      aliasSet.add(alias);
    }
  }
  const artistAliases = [...aliasSet].sort();
  const canonicalArtistKey = artistAliases.join("|");
  const canonicalTrackKey = [
    canonicalArtistKey,
    versionKey,
    normalizeVersionPreservingText(track.title),
    normalizeMatchText(track.album),
    String(track.durationSeconds ?? ""),
    track.source,
    track.sourceTrackId ?? "",
  ].join("\0");

  return {
    track,
    title,
    rawArtists: track.artists,
    artistAliases,
    canonicalArtistKey,
    versionTags,
    versionKey,
    canonicalTrackKey,
  };
}

export function hasCompatibleVersion(a: PreNormalizedTrack, b: PreNormalizedTrack): boolean {
  return a.versionTags.has("instrumental") === b.versionTags.has("instrumental");
}

export function hasIdenticalVersionTags(a: PreNormalizedTrack, b: PreNormalizedTrack): boolean {
  return a.versionKey === b.versionKey;
}

export function compareCanonicalIndex(
  aIdx: number,
  bIdx: number,
  norm: readonly PreNormalizedTrack[],
): number {
  const keyA = norm[aIdx]?.canonicalTrackKey ?? "";
  const keyB = norm[bIdx]?.canonicalTrackKey ?? "";
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  return aIdx - bIdx;
}
