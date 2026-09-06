/**
 * /generate model picker — card list + the media a picked card actually sends.
 *
 * The model card IS the interface: there is no separate "mode" control on
 * /generate. A Seedance base row (`frames: ['first','last']`) and its
 * `-reference-to-video` twin (`reference: true`, 9 stills + catalog-declared
 * video/audio references)
 * are two different tools with two different input shapes, so each gets its own
 * card — exactly as /boards lists them as two separate pickable rows. Previously
 * /generate hid the twins and swapped to them on the mere PRESENCE of an
 * attached asset, which made the first/last-frame path unreachable on the two
 * most-used video models.
 *
 * Pure + unit-tested: extracted out of GenerateClient so the picker contract and
 * the submit-time media contract can be asserted without rendering the screen.
 */

import { supportsAudioControl, videoMediaCaps, type ModelCaps } from './model-capabilities';
import { modelDisplayName } from './models';

/** The catalog fields a picker card needs (structural subset of ModelRow). */
export interface ModelCardSource extends ModelCaps {
  id: string;
  family: string;
  variant: string;
  displayName?: string | null;
  kind: string;
}

export interface ModelCard<T extends ModelCardSource = ModelCardSource> {
  model: T;
  /** Card headline, e.g. «Seedance 2.0 Fast · кадры». */
  name: string;
  /** Vendor sub-line, e.g. «ByteDance». */
  tag: string;
  /** Short RU note naming the input this card accepts (paired rows only). */
  note: string | null;
}

/** Vendor label per model family — the card subtitle. A model row has no vendor
 *  column, so it's derived from `family` (one obvious place to extend). Matched
 *  case-insensitively: the catalog stores some families lower-case («seedance»). */
const FAMILY_VENDOR: Record<string, string> = {
  seedance: 'ByteDance',
  seededit: 'ByteDance',
  seedream: 'ByteDance',
  veo: 'Google',
  gemini: 'Google',
  sora: 'OpenAI',
  happyhorse: 'Alibaba',
  wan: 'Alibaba',
  grok: 'xAI',
  kling: 'Kuaishou',
  flux: 'Black Forest',
};

const TWIN_SUFFIX = /-reference-to-video$/;
const REFERENCE_VARIANT_SUFFIX = /(?:^|-)reference$/;

/** The base id a `-reference-to-video` row twins with (itself when it's a base). */
function pairKey(id: string): string {
  return id.replace(TWIN_SUFFIX, '');
}

/** Paired rows share the catalogue name verbatim. Only the technical fallback
 * drops its terminal `reference` token: a human catalogue name such as
 * «Model Reference» is intentional and must remain intact. */
function pairedBaseName(model: ModelCardSource): string {
  if (model.displayName?.trim()) return modelDisplayName(model);
  if (!REFERENCE_VARIANT_SUFFIX.test(model.variant)) return modelDisplayName(model);
  return modelDisplayName({
    ...model,
    variant: model.variant.replace(REFERENCE_VARIANT_SUFFIX, ''),
  });
}

function isPairedModel(model: ModelCardSource, models: readonly ModelCardSource[]): boolean {
  return models.some(
    (candidate) =>
      candidate.id !== model.id &&
      pairKey(candidate.id) === pairKey(model.id) &&
      (TWIN_SUFFIX.test(candidate.id) || TWIN_SUFFIX.test(model.id)),
  );
}

/** One human label for every surface that names a picker model or its receipt. */
export function modelCardName(model: ModelCardSource, models: readonly ModelCardSource[]): string {
  if (!isPairedModel(model, models)) return modelDisplayName(model);
  const media = videoMediaCaps(model);
  return `${pairedBaseName(model)} · ${media.role === 'reference' ? 'референсы' : 'кадры'}`;
}

/** RU note naming the input a video card takes — the whole point of splitting
 *  the pair into two cards is that the user can read which is which. */
function mediaNote(model: ModelCardSource): string | null {
  const media = videoMediaCaps(model);
  if (media.role === 'reference') {
    const parts = [`до ${media.image} фото`];
    if (media.video > 0) parts.push('видео');
    if (media.audio > 0) parts.push('звук');
    return parts.join(' · ');
  }
  if (media.role === 'frame') {
    if (media.frames.length > 1) return 'первый и последний кадр';
    return media.frames[0] === 'last' ? 'последний кадр' : 'первый кадр';
  }
  return null;
}

/**
 * Picker cards for a mode, catalog order, with each `-reference-to-video` twin
 * pulled up to sit right after its base so the pair reads as one choice of two.
 *
 * A row that has a twin (either side of the pair) gets the disambiguating
 * «· кадры» / «· референсы» headline plus the input note; every other row keeps
 * its plain catalog label, because there is nothing to tell it apart from.
 */
export function modelCards<T extends ModelCardSource>(
  models: T[],
  mode: 'video' | 'image',
): ModelCard<T>[] {
  const inMode = models.filter((m) => (mode === 'video' ? m.kind === 'video' : m.kind === 'image'));
  const cards = inMode.map((model) => {
    const isPaired = isPairedModel(model, inMode);
    return {
      model,
      name: modelCardName(model, inMode),
      tag: FAMILY_VENDOR[model.family.toLowerCase()] ?? model.family,
      note: isPaired ? mediaNote(model) : null,
    };
  });

  // Keep a twin adjacent to its base — catalog order is alphabetical by id, so
  // «…-fast-reference-to-video» would otherwise land between the two bases.
  const out: ModelCard<T>[] = [];
  for (const card of cards) {
    if (TWIN_SUFFIX.test(card.model.id) && cards.some((c) => c.model.id === pairKey(card.model.id)))
      continue;
    out.push(card);
    const twin = cards.find(
      (c) => c.model.id !== card.model.id && pairKey(c.model.id) === card.model.id,
    );
    if (twin) out.push(twin);
  }
  return out;
}

/** Video reference/frame slots the drop zone may fill for the picked model. */
export function videoMediaLimits(model: ModelCardSource): {
  image: number;
  video: number;
  audio: number;
} {
  const media = videoMediaCaps(model);
  return { image: media.image, video: media.video, audio: media.audio };
}

/**
 * The PRICE-relevant slice of a video job's params — what `/v1/jobs/estimate`
 * must send so its quote equals what `/v1/jobs` will reserve.
 */
export function videoPriceParams(
  model: ModelCardSource,
  input: {
    durationSeconds: number;
    resolution: string;
    generateAudio: boolean;
    refs: { images: string[]; videos: string[]; audios: string[] };
  },
): Record<string, unknown> {
  // Derived from the SAME `videoMediaParams` the submit body uses, so the two
  // payloads cannot disagree about `videoUrls` — which is a price dimension:
  // `priceSelectorFromParams` sets `videoInput` from it and the resolver then
  // routes the job to the deliberate flat carve-out instead of the ladder.
  //
  // The bug this closes (paths audit B3, goal invariant 4): /generate's estimate
  // sent `videoUrls` whenever ANY existed in component state, while submit sent
  // them only for a reference-mode card. Media is deliberately not wiped on a
  // model switch, so attaching a video reference and then switching to a
  // non-r2v model (veo, kling, wan, grok, happyhorse, omni — all
  // `reference: false`) quoted the FLAT rate and charged the PARAMETRIC one:
  // two different numbers for one click.
  const media = videoMediaParams(model, input.refs);
  // `generate_audio` is a PRICE dimension only when the catalogue exposes a real
  // user control. A fixed-audio model (audio:true, audioControl:false) still emits
  // sound, but its provider ignores the flag and the product must not present a
  // fake toggle. Kling has both active states, so omitting this field from the
  // quote would still make estimate and submit disagree.
  const audioCapable = supportsAudioControl(model);
  return {
    duration_seconds: input.durationSeconds,
    resolution: input.resolution,
    generate_audio: audioCapable ? input.generateAudio : false,
    ...media,
  };
}

/**
 * The media slice of a video job's params for the picked model — the submit-time
 * half of the card contract. A frame model gets its keyframes (capped at the
 * slots it declares); a reference model gets typed reference arrays (capped at
 * its declared maxima); a text-to-video-only model gets nothing.
 */
export function videoMediaParams(
  model: ModelCardSource,
  refs: { images: string[]; videos: string[]; audios: string[] },
): Record<string, string[]> {
  const media = videoMediaCaps(model);
  if (media.role === 'frame') {
    const images = refs.images.slice(0, media.image);
    return images.length ? { imageUrls: images } : {};
  }
  if (media.role === 'reference') {
    const images = refs.images.slice(0, media.image);
    const videos = refs.videos.slice(0, media.video);
    const audios = refs.audios.slice(0, media.audio);
    return {
      ...(images.length ? { imageUrls: images } : {}),
      ...(videos.length ? { videoUrls: videos } : {}),
      ...(audios.length ? { audioUrls: audios } : {}),
    };
  }
  return {};
}
