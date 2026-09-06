import { REFERENCE_CAPS } from './gateway-routing';
import { CAST_KIND_LABEL, type CastKind } from './cast';

export type RefMentionKind = 'image' | 'video';

export interface RefMention {
  token: `@${RefMentionKind}${number}`;
  kind: RefMentionKind;
  url: string;
  label: string;
}

export interface ImageMentionInText {
  token: `@image${number}`;
  mention: RefMention | undefined;
}

export interface MentionCastSource {
  kind: 'cast';
  castKind: CastKind;
  name?: string | undefined;
  imageUrls: string[];
  videoUrl?: string | undefined;
}

export type MentionSource =
  | MentionCastSource
  | { kind: 'image'; url: string; label?: string | undefined }
  | { kind: 'video'; url: string; label?: string | undefined };

const isUrl = (u: unknown): u is string => typeof u === 'string' && u.length > 0;

function basename(url: string): string {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? url);
  } catch {
    return url.split('/').filter(Boolean).pop() ?? url;
  }
}

function pushUnique<T extends { url: string }>(arr: T[], seen: Set<string>, item: T): void {
  if (!isUrl(item.url) || seen.has(item.url)) return;
  seen.add(item.url);
  arr.push(item);
}

/**
 * Build the prompt mention registry for one generate node. Ordering mirrors the
 * actual previz ref assembly: character stills first, then location stills,
 * then loose images; videos are numbered separately as motion refs.
 */
export function buildRefMentions(sources: MentionSource[]): RefMention[] {
  const characterImages: { url: string; label: string }[] = [];
  const locationImages: { url: string; label: string }[] = [];
  const looseImages: { url: string; label: string }[] = [];
  const videos: { url: string; label: string }[] = [];
  const seenImages = new Set<string>();
  const seenVideos = new Set<string>();

  for (const source of sources) {
    if (source.kind === 'image') {
      pushUnique(looseImages, seenImages, {
        url: source.url,
        label: source.label ?? basename(source.url),
      });
      continue;
    }
    if (source.kind === 'video') {
      pushUnique(videos, seenVideos, {
        url: source.url,
        label: source.label ?? basename(source.url),
      });
      continue;
    }

    const target = source.castKind !== 'location' ? characterImages : locationImages;
    const name = source.name?.trim();
    const kindLabel = CAST_KIND_LABEL[source.castKind];
    for (const [i, url] of source.imageUrls.filter(isUrl).entries()) {
      pushUnique(target, seenImages, {
        url,
        label: `${name || kindLabel} · кадр ${i + 1}`,
      });
    }
    if (isUrl(source.videoUrl)) {
      pushUnique(videos, seenVideos, {
        url: source.videoUrl,
        label: `${name || kindLabel} · движение`,
      });
    }
  }

  const images = [...characterImages, ...locationImages, ...looseImages].slice(
    0,
    REFERENCE_CAPS.images,
  );
  return [
    ...images.map(
      (item, i): RefMention => ({
        token: `@image${i + 1}`,
        kind: 'image',
        url: item.url,
        label: item.label,
      }),
    ),
    ...videos.slice(0, REFERENCE_CAPS.videos).map(
      (item, i): RefMention => ({
        token: `@video${i + 1}`,
        kind: 'video',
        url: item.url,
        label: item.label,
      }),
    ),
  ];
}

/** Image reference tokens actually used by a prompt, in first-use order. */
export function imageMentionsInText(text: string, mentions: RefMention[]): ImageMentionInText[] {
  const byToken = new Map(
    mentions
      .filter((mention) => mention.kind === 'image')
      .map((mention) => [mention.token, mention]),
  );
  const seen = new Set<string>();
  const result: ImageMentionInText[] = [];
  for (const match of text.matchAll(/@image\d+\b/gi)) {
    const token = match[0].toLowerCase() as `@image${number}`;
    if (seen.has(token)) continue;
    seen.add(token);
    result.push({ token, mention: byToken.get(token) });
  }
  return result;
}

export function mentionQueryBeforeCursor(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const m = /(^|\s)(@[\w-]*)$/.exec(before);
  if (!m) return null;
  const raw = m[2] ?? '';
  return { start: cursor - raw.length, query: raw.slice(1).toLowerCase() };
}

export function insertMentionToken(
  text: string,
  start: number,
  end: number,
  token: string,
): { text: string; cursor: number } {
  const suffix = text.slice(end).startsWith(' ') ? '' : ' ';
  const next = `${text.slice(0, start)}${token}${suffix}${text.slice(end)}`;
  return { text: next, cursor: start + token.length + suffix.length };
}
