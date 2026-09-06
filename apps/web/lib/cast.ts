/**
 * Cast object kinds → shot-reference assembly for the previz loop
 * (S2). Pure so it's unit-testable: the board collects the cast nodes wired
 * into a shot (plus loose image refs) and this module turns them into the
 * gateway-agnostic `imageUrls` / `videoUrls` arrays.
 *
 * Conventions encoded here (per the previz spec's grounding facts):
 * - No per-reference ROLES exist through our gateways — disambiguation is
 *   by ORDER + PROMPT: subject (персонаж) stills lead, then location stills,
 *   then loose refs; the prompt names the cast members.
 * - Wire caps: ≤9 stills; ≤3 reference videos (AtlasCloud-only path).
 */
import { REFERENCE_CAPS } from './gateway-routing';
import type { SceneObjectKind } from '@seed/shared/scene-objects';

export type CastKind = 'character' | 'location' | 'product';

/**
 * Display vocabulary for cast nodes. Russian inflects, so each form is spelled
 * out rather than derived: `${LABEL.toLowerCase()}` inside «Имя …» yields the
 * nominative «Имя человек», which is not a sentence.
 */
export const CAST_NODE_LABEL = 'Объект';
/** «На борде пока нет ОБЪЕКТОВ» — genitive plural of CAST_NODE_LABEL. */
export const CAST_NODE_LABEL_GENITIVE_PLURAL = 'объектов';
export const CAST_KIND_LABEL: Record<CastKind, string> = {
  character: 'Человек',
  location: 'Место',
  product: 'Товар',
};
export const SCENE_OBJECT_KIND_LABEL: Record<SceneObjectKind, string> = {
  person: 'чел',
  place: 'место',
  thing: 'вещь',
};
/** «Имя ЧЕЛОВЕКА», «вид ТОВАРА» — genitive singular, lower case. */
export const CAST_KIND_LABEL_GENITIVE: Record<CastKind, string> = {
  character: 'человека',
  location: 'места',
  product: 'товара',
};

export interface CastLike {
  castKind: CastKind;
  name: string;
  imageUrls: string[];
  /** Optional motion reference (Локация ambience / camera move). */
  videoUrl?: string | undefined;
}

/** One wired reference source, in edge order. `video` = a loose motion ref
 * (video media node) — rides as videoUrls, AtlasCloud-only path (S3). */
export type RefSource =
  | { kind: 'cast'; cast: CastLike }
  | { kind: 'image'; url: string }
  | { kind: 'video'; url: string };

export interface ShotRefBundle {
  imageUrls: string[];
  videoUrls: string[];
}

export interface ShotRefLimits {
  images: number;
  videos: number;
}

const isUrl = (u: unknown): u is string => typeof u === 'string' && u.length > 0;

/**
 * Assemble a shot's reference arrays from its wired sources.
 * Characters first (subject leads), then locations, then loose images —
 * stable within each group by wire order; de-duplicated; capped 9/3.
 */
export function assembleShotRefs(
  sources: RefSource[],
  limits: ShotRefLimits = REFERENCE_CAPS,
): ShotRefBundle {
  const chars: string[] = [];
  const locs: string[] = [];
  const loose: string[] = [];
  const videos: string[] = [];
  for (const s of sources) {
    if (s.kind === 'image') {
      if (isUrl(s.url)) loose.push(s.url);
      continue;
    }
    if (s.kind === 'video') {
      if (isUrl(s.url)) videos.push(s.url);
      continue;
    }
    const into = s.cast.castKind !== 'location' ? chars : locs;
    into.push(...s.cast.imageUrls.filter(isUrl));
    if (isUrl(s.cast.videoUrl)) videos.push(s.cast.videoUrl);
  }
  const imageUrls = [...new Set([...chars, ...locs, ...loose])].slice(0, limits.images);
  const videoUrls = [...new Set(videos)].slice(0, limits.videos);
  return { imageUrls, videoUrls };
}

/**
 * Prompt prefix naming the cast (the only disambiguation channel we have).
 * Character, product, and location clauses are ordered for prompt grounding.
 * Empty when no named cast is wired.
 */
export function castPromptPrefix(casts: CastLike[]): string {
  const chars = casts.filter((c) => c.castKind === 'character' && c.name.trim());
  const products = casts.filter((c) => c.castKind === 'product' && c.name.trim());
  const locs = casts.filter((c) => c.castKind === 'location' && c.name.trim());
  const parts: string[] = [];
  if (chars.length) {
    const names = chars.map((c) => c.name.trim()).join(', ');
    parts.push(
      chars.length === 1
        ? `Персонаж ${names} — как на референсных кадрах.`
        : `Персонажи ${names} — как на референсных кадрах.`,
    );
  }
  if (products.length) {
    const names = products.map((c) => c.name.trim()).join(', ');
    // Model-facing text, so the wording is spelled out here rather than pulled
    // from the UI label constants — the two are free to diverge.
    parts.push(
      products.length === 1
        ? `Товар ${names} — как на референсных кадрах.`
        : `Товары ${names} — как на референсных кадрах.`,
    );
  }
  if (locs.length) {
    parts.push(`Локация: ${locs.map((c) => c.name.trim()).join(', ')}.`);
  }
  return parts.join(' ');
}

/** A cast node is usable as a reference only when it has at least one still. */
export function castIsReady(c: CastLike): boolean {
  return c.imageUrls.some(isUrl);
}

/** A cast node on the board, by node id. */
export interface CastNodeRef {
  id: string;
  cast: CastLike;
}

/**
 * Auto-wire the scene cast into freshly planned shots (Режиссёр, S3):
 * every READY cast member connects into every shot's reference slots,
 * characters and products first (subject leads, mirroring assembleShotRefs), capped by
 * the shot's slot count. Returns plain edge descriptors.
 */
export function planCastWiring(
  casts: CastNodeRef[],
  shotIds: string[],
  slotCap: number,
): { source: string; target: string; targetHandle: string }[] {
  const ready = casts.filter((c) => castIsReady(c.cast));
  const ordered = [
    ...ready.filter((c) => c.cast.castKind !== 'location'),
    ...ready.filter((c) => c.cast.castKind === 'location'),
  ].slice(0, Math.max(0, slotCap));
  const edges: { source: string; target: string; targetHandle: string }[] = [];
  for (const shotId of shotIds) {
    ordered.forEach((c, i) => {
      edges.push({ source: c.id, target: shotId, targetHandle: `images[${i}]` });
    });
  }
  return edges;
}
