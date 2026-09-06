/**
 * Provider capability metadata (B-11). Normalizes a model's raw capabilities
 * (kind + the capabilities bag: mode/edit/websearch + max duration/resolution)
 * into user-facing labels and into "is this control available, and if not why"
 * answers — so switching models never silently drops an uploaded ref or hides a
 * control without explanation. Pure → unit-tested; Generate + Board nodes share it.
 */

export interface ModelCaps {
  id?: string;
  /** image | image-edit | video | voice */
  kind: string;
  capabilities?: Record<string, unknown> | null;
  maxDurationSeconds?: number | null;
  maxResolution?: string | null;
}

const bag = (m: ModelCaps): Record<string, unknown> =>
  (m.capabilities ?? {}) as Record<string, unknown>;

/** Video sub-mode: text | image | reference (undefined for non-video models). */
export function videoMode(m: ModelCaps): string | undefined {
  return m.kind === 'video' ? (bag(m)['mode'] as string | undefined) : undefined;
}

/** Accepts still image references (video image/reference modes, or edit models). */
export function acceptsImageRefs(m: ModelCaps): boolean {
  const mode = videoMode(m);
  if (m.kind === 'video') return mode === 'image' || mode === 'reference';
  return bag(m)['edit'] === true || m.kind === 'image-edit';
}

/** Accepts video references (only the video "reference" mode carries them). */
export function acceptsVideoRefs(m: ModelCaps): boolean {
  return videoMode(m) === 'reference';
}

/** Accepts audio references (reference-mode video that lists audio support). */
export function acceptsAudioRefs(m: ModelCaps): boolean {
  return videoMode(m) === 'reference' && bag(m)['audioRef'] === true;
}

export function supportsWebSearch(m: ModelCaps): boolean {
  return bag(m)['websearch'] === true || videoMode(m) === 'text';
}

/* ---- Capability-driven option space (S4) ----
   New OpenRouter engines declare their real option lists in `capabilities`
   (synced from the live schema). These read them back, returning `null` when a
   model doesn't declare them — callers then fall back to the legacy Seedance
   constants, so existing rows are unaffected. */

function strArr(v: unknown): string[] | null {
  return Array.isArray(v) && v.length
    ? v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : null;
}
function numArr(v: unknown): number[] | null {
  return Array.isArray(v) && v.length
    ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
    : null;
}

/** Discrete supported video durations (seconds), or null if not declared. */
export function videoDurations(m: ModelCaps): number[] | null {
  return m.kind === 'video' ? numArr(bag(m)['durations']) : null;
}

/** Supported resolution tiers ('720p','1080p',…), or null if not declared. */
export function videoResolutions(m: ModelCaps): string[] | null {
  return m.kind === 'video' ? strArr(bag(m)['resolutions']) : null;
}

/** Supported image output tiers ('1K', '2K', '4K', …), or null when the
 * provider exposes no output-size lever. Kept distinct from video because the
 * same `resolution` request field maps to provider-native `quality` on some
 * image gateways. */
export function imageResolutions(m: ModelCaps): string[] | null {
  return m.kind === 'image' || m.kind === 'image-edit' ? strArr(bag(m)['resolutions']) : null;
}

/** Supported aspect ratios ('16:9',…), or null if not declared. */
export function videoAspectRatios(m: ModelCaps): string[] | null {
  return m.kind === 'video' ? strArr(bag(m)['aspect_ratios']) : null;
}

/** Native audio generation (only offer/send `generate_audio` when true). */
export function supportsAudio(m: ModelCaps): boolean {
  return bag(m)['audio'] === true;
}

/** Whether the product may expose a user-controlled `generate_audio` toggle. */
export function supportsAudioControl(m: ModelCaps): boolean {
  return supportsAudio(m) && bag(m)['audioControl'] !== false;
}

/** Whether the engine honours a `negative_prompt` field. Diffusion image models
 *  (Seedream) do; most natural-language t2v engines ignore it, so a preset's
 *  negativePrompt is only threaded into the job when this is true (declared via
 *  `capabilities.negativePrompt` or a `passthrough` list that names it). */
export function supportsNegativePrompt(m: ModelCaps): boolean {
  const c = bag(m);
  if (c['negativePrompt'] === true) return true;
  const pass = c['passthrough'];
  return Array.isArray(pass) && pass.includes('negative_prompt');
}

/** Whether the engine accepts a last-frame anchor. An explicit empty `frames`
 *  array (Sora) means t2v-only → no first/last frame upload. Absent → legacy
 *  Seedance behavior (first+last allowed). */
export function supportsLastFrame(m: ModelCaps): boolean {
  const f = bag(m)['frames'];
  return Array.isArray(f) ? f.includes('last') : true;
}

/** Whether the engine conditions on a first-frame image (i2v). */
export function supportsFirstFrame(m: ModelCaps): boolean {
  const f = bag(m)['frames'];
  return Array.isArray(f) ? f.includes('first') : true;
}

/** What still/video/audio media a VIDEO model actually takes. */
export type VideoMediaRole = 'frame' | 'reference' | 'none';

export interface VideoMediaCaps {
  /** `frame` = keyframe anchors (i2v); `reference` = cast/style refs; `none` = t2v only. */
  role: VideoMediaRole;
  /** Max still images accepted (frame slots, or reference stills). */
  image: number;
  /** Max video references (reference models only). */
  video: number;
  /** Max audio references (reference models only). */
  audio: number;
  /** Which keyframe slots, when `role === 'frame'`. */
  frames: readonly ('first' | 'last')[];
}

/**
 * The ONE answer to "what media does this video model accept" on /generate.
 *
 * Deliberately mirrors the board port derivation in
 * `packages/shared/src/board-contract.ts` (`resolveBoardModelContract`, the
 * frames/reference branch): declared `frames` win over `reference`, an explicit
 * empty `frames: []` means text-to-video only, and a legacy row with neither
 * keeps the historical first+last behaviour. Boards and Generate must agree on
 * this or the same model grows different inputs on the two surfaces.
 */
export function videoMediaCaps(m: ModelCaps): VideoMediaCaps {
  const c = bag(m);
  const raw = c['frames'];
  const declared = Array.isArray(raw)
    ? raw.filter((v): v is 'first' | 'last' => v === 'first' || v === 'last')
    : null;
  if (declared !== null) {
    return {
      role: declared.length > 0 ? 'frame' : 'none',
      image: declared.length,
      video: 0,
      audio: 0,
      frames: declared,
    };
  }
  if (c['reference'] === true || /reference/i.test(m.id ?? '')) {
    return {
      role: 'reference',
      image: positiveInt(c['maxRefs']) ?? 9,
      video: positiveInt(c['maxVideoRefs']) ?? 3,
      audio: positiveInt(c['maxAudioRefs']) ?? 3,
      frames: [],
    };
  }
  // Legacy Seedance rows predate explicit `frames` metadata but the adapters
  // have always accepted first+last frames (same fallback board-contract uses).
  return { role: 'frame', image: 2, video: 0, audio: 0, frames: ['first', 'last'] };
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Snap a requested duration to the largest supported value not exceeding it,
 *  falling back to the smallest when below the floor. Mirrors the adapter so
 *  the UI cost (charged per snapped second) matches the delivered clip. */
export function snapDuration(requested: number, supported: number[]): number {
  const sorted = [...supported].sort((a, b) => a - b);
  const atOrBelow = sorted.filter((d) => d <= requested);
  return atOrBelow.length ? atOrBelow[atOrBelow.length - 1]! : sorted[0]!;
}

/** User-facing capability labels (the chip row). */
export function capabilityLabels(m: ModelCaps): string[] {
  const out: string[] = [];
  if (m.kind === 'video') {
    const mode = videoMode(m);
    out.push(
      mode === 'image'
        ? 'Изображение → видео'
        : mode === 'reference'
          ? 'Видео по референсам'
          : 'Текст → видео',
    );
    if (acceptsVideoRefs(m)) out.push('Видео-референс');
    if (acceptsAudioRefs(m)) out.push('Аудио-референс');
    if (m.maxDurationSeconds) out.push(`До ${m.maxDurationSeconds}с`);
  } else {
    out.push(
      m.kind === 'image-edit' || bag(m)['edit'] === true ? 'Редактирование' : 'Текст → кадр',
    );
  }
  if (acceptsImageRefs(m)) out.push('Реф-изображения');
  if (supportsWebSearch(m)) out.push('Веб-поиск');
  if (m.maxResolution) out.push(m.maxResolution);
  return out;
}

export interface DroppedRefs {
  images: number;
  videos: number;
  audios: number;
}

/**
 * When switching TO `next`, which already-uploaded refs will it NOT use?
 * Returns a user-facing explanation per dropped kind (empty = nothing dropped),
 * so the client can warn instead of silently discarding them.
 */
export function refsDroppedOnSwitch(next: ModelCaps, refs: DroppedRefs): string[] {
  const msgs: string[] = [];
  if (refs.images > 0 && !acceptsImageRefs(next)) {
    msgs.push('Эта модель не использует реф-изображения.');
  }
  if (refs.videos > 0 && !acceptsVideoRefs(next)) {
    msgs.push('Эта модель не принимает видео-референсы.');
  }
  if (refs.audios > 0 && !acceptsAudioRefs(next)) {
    msgs.push('Эта модель не принимает аудио-референсы.');
  }
  return msgs;
}

/** Why a control is disabled (null = available). For the disabled-control hint. */
export function controlDisabledReason(
  m: ModelCaps,
  control: 'imageRef' | 'videoRef' | 'audioRef' | 'webSearch' | 'edit',
): string | null {
  switch (control) {
    case 'imageRef':
      return acceptsImageRefs(m) ? null : 'Недоступно для этой модели.';
    case 'videoRef':
      return acceptsVideoRefs(m) ? null : 'Нужна модель с режимом «по референсам».';
    case 'audioRef':
      return acceptsAudioRefs(m) ? null : 'Нужна модель с поддержкой аудио-референса.';
    case 'webSearch':
      return supportsWebSearch(m) ? null : 'Модель не поддерживает веб-поиск.';
    case 'edit':
      return bag(m)['edit'] === true || m.kind === 'image-edit'
        ? null
        : 'Нужна модель с редактированием.';
  }
}

/** Standardised (non-localised) capability sign badges for a model card, read
 * straight from the model's capabilities — so a newly-wired model shows the
 * right signs with zero hand-maintenance. Each sign describes THIS row only:
 * a base model no longer borrows the REF sign from its reference twin, because
 * the twin is now its own pickable card. */
export function capabilitySigns(m: ModelCaps): string[] {
  const c = bag(m);
  const out: string[] = [];
  if (c['audio'] === true) out.push('AUDIO');
  if (m.kind === 'video') {
    const media = videoMediaCaps(m);
    if (media.role === 'reference') out.push('REF');
    else if (media.role === 'frame') {
      out.push(
        media.frames.length > 1 ? 'FIRST/LAST' : media.frames[0] === 'last' ? 'LAST' : 'FIRST',
      );
    }
  } else if (c['reference'] === true || c['edit'] === true) {
    out.push('REF');
  }
  return out;
}
