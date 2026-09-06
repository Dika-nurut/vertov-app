/**
 * Cinema vocabulary — camera / lens / focal-length / aperture → cinematography
 * phrase dictionaries, adapted from the Open-Generative-AI CinemaStudio lookup
 * tables (`CinemaStudio.jsx:8-105`) and re-authored for our preset engine.
 *
 * See research/archive/open-generative-ai-integration-plan-2026-07.md §A. This is the
 * single source for the A1 curated «Кино» presets (composed in preset-packs.ts
 * via {@link composeCinemaTemplate}) and the reference for a future A2 advanced
 * «Камера» dropdown panel (owner-mock-gated).
 *
 * Convention (house rule): prompt text is authored in ENGLISH (the model reads
 * English best); the `ru` field is the RU label surfaced in the UI dropdowns.
 */

export interface CinemaTerm {
  /** RU label for the UI (the A2 dropdowns / preset title hints). */
  ru: string;
  /** English cinematography phrase folded into the prompt. */
  phrase: string;
}

/** Camera / film format → look. */
export const CINEMA_CAMERAS = {
  '70mm': { ru: '70мм', phrase: 'shot on a grand-format 70mm film camera, epic wide gauge' },
  imax: { ru: 'IMAX', phrase: 'shot on a large-format IMAX camera, immense clarity' },
  '35mm': { ru: '35мм', phrase: 'shot on 35mm motion picture film, classic cinema texture' },
  '16mm': { ru: '16мм', phrase: 'shot on grainy 16mm film, organic vintage grain' },
  digital: {
    ru: 'Цифра',
    phrase: 'shot on a modern full-frame digital cinema camera, clean pristine image',
  },
  super8: { ru: 'Super 8', phrase: 'shot on a vintage Super 8 film camera, nostalgic soft grain' },
} satisfies Record<string, CinemaTerm>;

/** Lens character. */
export const CINEMA_LENSES = {
  anamorphic: {
    ru: 'Анаморфный',
    phrase: 'anamorphic lens with oval bokeh and subtle horizontal flares',
  },
  spherical: { ru: 'Сферический', phrase: 'clean spherical prime lens, neutral rendering' },
  macro: { ru: 'Макро', phrase: 'macro lens with extreme close focus and fine detail' },
  tiltShift: {
    ru: 'Тилт-шифт',
    phrase: 'tilt-shift lens with a thin, selective plane of focus',
  },
  wide: { ru: 'Широкоугольный', phrase: 'wide-angle lens with deep, immersive perspective' },
} satisfies Record<string, CinemaTerm>;

/** Focal length → framing/compression. */
export const CINEMA_FOCAL = {
  '18mm': { ru: '18 мм', phrase: '18mm ultra-wide framing, expansive environment' },
  '35mm': { ru: '35 мм', phrase: '35mm natural cinematic perspective' },
  '50mm': { ru: '50 мм', phrase: '50mm standard framing, true-to-eye proportions' },
  '85mm': { ru: '85 мм', phrase: '85mm portrait compression, flattering subject separation' },
  '135mm': { ru: '135 мм', phrase: '135mm telephoto compression, isolated subject' },
} satisfies Record<string, CinemaTerm>;

/** Aperture → depth of field. */
export const CINEMA_APERTURE = {
  'f1.4': { ru: 'f/1.4', phrase: 'aperture f/1.4, very shallow depth of field, creamy bokeh' },
  'f2.8': { ru: 'f/2.8', phrase: 'aperture f/2.8, shallow depth of field, soft background' },
  f4: { ru: 'f/4', phrase: 'aperture f/4, balanced depth of field' },
  f8: { ru: 'f/8', phrase: 'aperture f/8, deep focus, everything sharp' },
} satisfies Record<string, CinemaTerm>;

export type CameraKey = keyof typeof CINEMA_CAMERAS;
export type LensKey = keyof typeof CINEMA_LENSES;
export type FocalKey = keyof typeof CINEMA_FOCAL;
export type ApertureKey = keyof typeof CINEMA_APERTURE;

/** A common cinematic finishing clause shared by every cinema preset. */
export const CINEMA_FINISH =
  'cinematic lighting, natural color science, high dynamic range, ultra-detailed';

/**
 * Compose a slots-mode `{subject}` template from the four cinema axes. The
 * user's own prompt drops into `{subject}` at submit time (single-slot
 * convenience of mergePresetPrompt); the rest is the fixed technique scaffold.
 */
export function composeCinemaTemplate(parts: {
  camera: CameraKey;
  lens: LensKey;
  focal: FocalKey;
  aperture: ApertureKey;
}): string {
  return [
    '{subject}',
    CINEMA_CAMERAS[parts.camera].phrase,
    `using ${CINEMA_LENSES[parts.lens].phrase} at ${CINEMA_FOCAL[parts.focal].phrase}`,
    CINEMA_APERTURE[parts.aperture].phrase,
    CINEMA_FINISH,
  ].join(', ');
}

/** Negative prompt shared by cinema presets (Seedream honours negative_prompt). */
export const CINEMA_NEGATIVE =
  'blurry, low quality, distortion, bad composition, oversaturated, deformed, watermark, text';
