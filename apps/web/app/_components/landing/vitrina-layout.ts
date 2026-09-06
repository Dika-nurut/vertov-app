/** Витрина justified-row layout — the curated card set is reordered to
 * alternate image and video kinds, while geometry comes from stored previews.
 * Client-side shelves filter the same seeded inventory into curated rails. */

export type VitrinaCard = {
  slug: string;
  ratio: number;
  kind: 'image' | 'video';
  badge?: string;
};

export type VitrinaRow = { cards: VitrinaCard[]; ratioSum: number };

// Every card here must survive its own CTA: «Снять так же» has to land on a
// /generate that can actually reproduce the clip. That rules out four rows the
// wall used to carry (2026-07-27 audit):
//   · explosion-behind / neon-rain — suffix MODIFIERS, not prompts; the box
//     arrives empty. Replaced by demo-seedance-2-0-fast-* rows carrying the full
//     text-to-video prompt that really produced these loops.
//   · demo-wan-2-7-reference-to-video — its prompt opens «The reference subject…»
//     and the pack bundles no reference, so the CTA silently degrades to plain
//     text-to-video: a different generation from the one on display.
//   · demo-wan-2-7-golden-hour-recolor — «Recolor the scene…» with no scene
//     attached, same class.
// The cards stay in the landing vitrina (the /presets catalog is parked by P-4),
// where their semantics are correct.
// The near-duplicate paper-boat source also stays out — `-extend` is the longer take.
export const CARD_SLUGS = [
  'demo-veo-3-1-lite-jumbotron',
  'demo-gemini-3-1-flash-image-yearbook-90s',
  'demo-wan-2-7-drone-pullback-kie',
  'samovar-still-life',
  'demo-seedance-2-0-food-jutsu-1080p',
  'demo-seedream-5-0-pro-flag-banner',
  'demo-happyhorse-1-1-inflate',
  'piter-roof-sunset',
  'demo-gemini-omni-golden-hour-car',
  'demo-seedream-4-0-figurine',
  'demo-seedance-2-0-fast-explosion-behind',
  'demo-grok-imagine-video-paper-boat-extend',
  'horror-poster-90s',
  'demo-gpt-image-2-film-poster',
  'demo-gemini-omni-flash-jumbotron',
  'demo-gemini-3-pro-image-pet-profession',
  'demo-wan-2-7-mountain-pullback-atlas',
  'anime-portrait',
  'demo-seedance-2-0-fast-neon-rain',
  'demo-veo-3-1-fast-dolly-zoom-1080p',
  'demo-seedream-5-lite-bubbles-editorial',
  'ps1-game-screenshot',
] as const;

/**
 * Alternate image and video cards, SPREADING the surplus instead of appending
 * it. Pairing them off and concatenating the leftovers was the original sin of
 * this wall: with 13 videos to 11 images it puts the two extra videos side by
 * side at the very bottom, which is exactly the "stills on top, videos in a
 * band underneath" the row layout exists to kill.
 *
 * Walk the longer list and release the next short card once the running ratio
 * says one is due (Bresenham). Same-kind neighbours then occur only where the
 * counts make them unavoidable — |longer − shorter| − 1 of them — and they land
 * distributed through the wall rather than piled at one end. Deterministic: the
 * server and the client must produce byte-identical output.
 */
export function interleave(cards: readonly VitrinaCard[]): VitrinaCard[] {
  const images = cards.filter((card) => card.kind === 'image');
  const videos = cards.filter((card) => card.kind === 'video');
  const [longer, shorter] = images.length >= videos.length ? [images, videos] : [videos, images];
  if (shorter.length === 0) return [...longer];

  const result: VitrinaCard[] = [];
  if (longer.length === shorter.length) {
    for (let i = 0; i < longer.length; i++) result.push(longer[i]!, shorter[i]!);
    return result;
  }

  // Strictly fewer short cards than long ones, so every short card can sit in an
  // INTERNAL gap — never trailing off the end, which would waste a separator and
  // create a second same-kind pair. `gaps` of them exist; spread the short cards
  // across those evenly, at most one per gap.
  const gaps = longer.length - 1;
  let released = 0;
  for (let i = 0; i < longer.length; i++) {
    result.push(longer[i]!);
    if (i === gaps) break;
    const due = Math.min(shorter.length, Math.round(((i + 1) * shorter.length) / gaps));
    if (released < due) result.push(shorter[released++]!);
  }
  while (released < shorter.length) result.push(shorter[released++]!);
  return result;
}

/** Pack complete justified rows and deliberately discard the incomplete tail. */
export function packRows(
  cards: readonly VitrinaCard[],
  {
    targetHeight = 380,
    referenceWidth = 1440,
  }: { targetHeight?: number; referenceWidth?: number } = {},
): VitrinaRow[] {
  const rows: VitrinaRow[] = [];
  let rowCards: VitrinaCard[] = [];
  let ratioSum = 0;

  for (const card of cards) {
    rowCards.push(card);
    ratioSum += card.ratio;
    if (ratioSum * targetHeight >= referenceWidth) {
      rows.push({ cards: rowCards, ratioSum });
      rowCards = [];
      ratioSum = 0;
    }
  }
  return rows;
}

/** Below this many renderable cards the feed reads as a page of holes → hide the
 * whole section (same empty-marketplace guard idea as the old shelf). 22
 * designed cards; anything under ~half present isn't worth showing. */
export const MIN_CELLS = 11;

/**
 * Decide whether the section renders at all, from the renderable seeded set.
 *
 * This deliberately ignores cards that 404'd in the browser. Counting those
 * used to let a bad bucket tear the wall down mid-visit: posters that error
 * after hydration mark themselves dead one by one, and the moment the running
 * total crossed MIN_CELLS the whole `<section>` unmounted under the visitor's
 * cursor — a click landed on nothing and the landing appeared to "reload"
 * without Витрина (2026-07-26; 16 of 25 posters were missing from the bucket).
 * The guard answers "did we seed enough dimensioned cards for a feed to be
 * worth a section", which is a server-side fact; runtime breakage keeps each
 * justified tile in place.
 */
export function hasEnoughSeededCells(renderable: ReadonlySet<string>): boolean {
  return CARD_SLUGS.filter((slug) => renderable.has(slug)).length >= MIN_CELLS;
}

export type VitrinaShelf = {
  key: string;
  label: string;
  /** lime dot on the tab, mockup-approved */
  trend?: boolean;
  slugs: readonly string[];
};

// Shelf contents are merchandising decisions (handbook §5/§6 + owner-approved
// mockup 2026-08-31). «Тренды» re-merchandises existing packs onto the live Y2K/
// retro wave per the §6 ruling; camera/effect/video-demo shelves group the wall's
// existing inventory; «Товар в кадре» and «UGC» stay unlisted until Drops 1–2
// produce real presets for them (a 1-card shelf reads as a broken page).
export const SHELVES: readonly VitrinaShelf[] = [
  {
    key: 'trends',
    label: 'Тренды',
    trend: true,
    slugs: [
      'demo-gemini-3-1-flash-image-yearbook-90s', // Y2K paparazzi wave is live
      'vhs-90s',
      'levitate',
      'bullet-time',
      'anime-motion',
      'time-freeze',
      'demo-seedance-2-0-fast-explosion-behind',
    ],
  },
  {
    key: 'camera',
    label: 'Камера',
    slugs: [
      'crash-zoom',
      'dolly-in',
      'orbit-360',
      'fpv-drone',
      'handheld-doc',
      'bullet-time',
      'demo-wan-2-7-drone-pullback-kie',
      'demo-wan-2-7-mountain-pullback-atlas',
      'demo-veo-3-1-fast-dolly-zoom-1080p',
    ],
  },
  {
    key: 'effects',
    label: 'Эффекты',
    slugs: [
      'zoom-out-reveal',
      'ice-frost',
      'time-freeze',
      'levitate',
      'demo-seedance-2-0-fast-explosion-behind',
      'demo-seedance-2-0-fast-neon-rain',
    ],
  },
  {
    key: 'cinema',
    label: 'Кино',
    slugs: [
      'demo-veo-3-1-lite-jumbotron',
      'demo-gemini-omni-flash-jumbotron',
      'demo-gemini-omni-golden-hour-car',
      'demo-seedance-2-0-food-jutsu-1080p',
      'demo-happyhorse-1-1-inflate',
      'demo-grok-imagine-video-paper-boat-extend',
    ],
  },
  {
    key: 'posters',
    label: 'Постеры',
    slugs: [
      'horror-poster-90s',
      'demo-gpt-image-2-film-poster',
      'demo-seedream-5-0-pro-flag-banner',
      'logo-emblem',
      'birthday-card',
      'samovar-still-life',
    ],
  },
];

/** Tabs hidden below this: a 1–2 card shelf reads as a broken page, and the
 * slot is better spent on no tab until Drops 1–2 fill it. */
export const MIN_SHELF_CELLS = 3;

export function visibleShelves(
  shelves: readonly VitrinaShelf[],
  renderable: ReadonlySet<string>,
): { shelf: VitrinaShelf; count: number }[] {
  const visible: { shelf: VitrinaShelf; count: number }[] = [];
  for (const shelf of shelves) {
    const count = shelf.slugs.filter((slug) => renderable.has(slug)).length;
    if (count >= MIN_SHELF_CELLS) visible.push({ shelf, count });
  }
  return visible;
}
