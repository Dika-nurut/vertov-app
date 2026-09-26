/** The four owner-approved product loops (2026-09-26): one silent 16:9 MP4 per tool,
 *  authored in Remotion (`mockups/landing-motion/`) from real Vertov output and
 *  shipped from `public/landing/loops/` with a poster frame. The landing's
 *  FeatureTabs and the signed-in HomeBoard both read this list, so a tool's loop,
 *  label and destination are defined once. */
export type ProductLoopKey = 'generate' | 'scenario' | 'boards' | 'studio';

export interface ProductLoop {
  key: ProductLoopKey;
  /** Tab / tile label, as the tool is named in the main nav. */
  label: string;
  href: string;
  /** VP9 first (smaller, plays in every Chromium build), H.264 MP4 as the fallback. */
  webm: string;
  src: string;
  poster: string;
}

const loop = (key: ProductLoopKey, label: string, href: string): ProductLoop => ({
  key,
  label,
  href,
  webm: `/landing/loops/${key}.webm`,
  src: `/landing/loops/${key}.mp4`,
  poster: `/landing/loops/${key}.webp`,
});

export const PRODUCT_LOOPS: readonly ProductLoop[] = [
  loop('generate', 'Генерация', '/generate'),
  loop('scenario', 'Сценарий', '/scenario'),
  loop('boards', 'Борды', '/boards'),
  loop('studio', 'Студия', '/studio/projects'),
];

export function productLoop(key: ProductLoopKey): ProductLoop {
  return PRODUCT_LOOPS.find((l) => l.key === key)!;
}
