import { describe, expect, it } from 'vitest';
import {
  CARD_SLUGS,
  MIN_CELLS,
  MIN_SHELF_CELLS,
  SHELVES,
  hasEnoughSeededCells,
  interleave,
  packRows,
  type VitrinaCard,
  visibleShelves,
} from './vitrina-layout';

const ALL_SLUGS = [...CARD_SLUGS];
const allSeeded = () => new Set(ALL_SLUGS);

const REAL_CARDS: VitrinaCard[] = [
  { slug: 'demo-veo-3-1-lite-jumbotron', ratio: 1400 / 788, kind: 'video' },
  { slug: 'demo-gemini-3-1-flash-image-yearbook-90s', ratio: 1045 / 1400, kind: 'image' },
  { slug: 'demo-wan-2-7-drone-pullback-kie', ratio: 1400 / 788, kind: 'video' },
  { slug: 'samovar-still-life', ratio: 1, kind: 'image' },
  { slug: 'demo-seedance-2-0-food-jutsu-1080p', ratio: 1400 / 788, kind: 'video' },
  { slug: 'demo-seedream-5-0-pro-flag-banner', ratio: 778 / 1400, kind: 'image' },
  { slug: 'demo-happyhorse-1-1-inflate', ratio: 1400 / 788, kind: 'video' },
  { slug: 'piter-roof-sunset', ratio: 1, kind: 'image' },
  { slug: 'demo-gemini-omni-golden-hour-car', ratio: 1400 / 788, kind: 'video' },
  { slug: 'demo-seedream-4-0-figurine', ratio: 1050 / 1400, kind: 'image' },
  { slug: 'demo-seedance-2-0-fast-explosion-behind', ratio: 1, kind: 'video' },
  { slug: 'demo-grok-imagine-video-paper-boat-extend', ratio: 752 / 416, kind: 'video' },
  { slug: 'horror-poster-90s', ratio: 1, kind: 'image' },
  { slug: 'demo-gpt-image-2-film-poster', ratio: 1400 / 933, kind: 'image' },
  { slug: 'demo-gemini-omni-flash-jumbotron', ratio: 1400 / 788, kind: 'video' },
  { slug: 'demo-gemini-3-pro-image-pet-profession', ratio: 1045 / 1400, kind: 'image' },
  { slug: 'demo-wan-2-7-mountain-pullback-atlas', ratio: 1280 / 720, kind: 'video' },
  { slug: 'anime-portrait', ratio: 1, kind: 'image' },
  { slug: 'demo-seedance-2-0-fast-neon-rain', ratio: 1, kind: 'video' },
  { slug: 'demo-veo-3-1-fast-dolly-zoom-1080p', ratio: 1400 / 788, kind: 'video' },
  { slug: 'demo-seedream-5-lite-bubbles-editorial', ratio: 1050 / 1400, kind: 'image' },
  { slug: 'ps1-game-screenshot', ratio: 1, kind: 'image' },
];

// REAL_CARDS mirrors the shipped wall so the packing invariants are asserted
// against the real ratios, not a toy set — which only means anything while the
// two stay in step. They drifted twice on 2026-07-27 alone.
describe('the test fixture tracks the shipped card set', () => {
  it('covers exactly CARD_SLUGS', () => {
    expect(REAL_CARDS.map((card) => card.slug).sort()).toEqual([...CARD_SLUGS].sort());
  });
});

describe('packRows', () => {
  it('returns only rows wide enough for the target justified geometry', () => {
    for (const row of packRows(interleave(REAL_CARDS))) {
      expect(row.ratioSum * 380).toBeGreaterThanOrEqual(1440);
    }
  });

  it('drops the trailing partial row and drops exactly its tail cards', () => {
    const input: VitrinaCard[] = [
      { slug: 'a', ratio: 2, kind: 'image' },
      { slug: 'b', ratio: 2, kind: 'video' },
      { slug: 'c', ratio: 1, kind: 'image' },
    ];
    const rows = packRows(input);
    expect(rows.flatMap((row) => row.cards.map((card) => card.slug))).toEqual(['a', 'b']);
  });

  it('packs the same cards into deeply equal rows every time', () => {
    expect(packRows(interleave(REAL_CARDS))).toEqual(packRows(interleave(REAL_CARDS)));
  });

  // The real set is 13 videos to 11 images, so perfect alternation is
  // arithmetically impossible: 13 videos need 12 separators and only 11 exist.
  // What matters is that the ONE unavoidable same-kind pair is somewhere in the
  // middle rather than piled at an end — a run at the bottom is precisely the
  // "stills on top, videos underneath" complaint this layout replaced.
  it('leaves only the arithmetically unavoidable same-kind neighbours, and not at either end', () => {
    const cards = interleave(REAL_CARDS);
    const images = REAL_CARDS.filter((card) => card.kind === 'image').length;
    const videos = REAL_CARDS.filter((card) => card.kind === 'video').length;
    const unavoidable = Math.max(0, Math.abs(videos - images) - 1);

    const repeats: number[] = [];
    for (let i = 1; i < cards.length; i++) {
      if (cards[i]!.kind === cards[i - 1]!.kind) repeats.push(i);
    }
    expect(repeats).toHaveLength(unavoidable);
    for (const at of repeats) {
      expect(at).toBeGreaterThan(2);
      expect(at).toBeLessThan(cards.length - 2);
    }
  });

  it('appends nothing when one kind is missing entirely', () => {
    const onlyVideos = REAL_CARDS.filter((card) => card.kind === 'video');
    expect(interleave(onlyVideos)).toEqual(onlyVideos);
    expect(interleave([])).toEqual([]);
  });

  it('spreads a large surplus instead of trailing it', () => {
    const many: VitrinaCard[] = [
      ...Array.from({ length: 9 }, (_, i) => ({
        slug: `v${i}`,
        ratio: 1.78,
        kind: 'video' as const,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({ slug: `i${i}`, ratio: 1, kind: 'image' as const })),
    ];
    const kinds = interleave(many).map((card) => card.kind);
    // the three images land inside the run, never bunched at one end
    const positions = kinds.flatMap((kind, i) => (kind === 'image' ? [i] : []));
    expect(positions).toHaveLength(3);
    expect(positions[0]).toBeGreaterThan(0);
    expect(positions[2]).toBeLessThan(kinds.length - 1);
  });

  it('returns at least five rows from the real card set without duplicate cards', () => {
    const cards = packRows(interleave(REAL_CARDS)).flatMap((row) => row.cards);
    expect(packRows(interleave(REAL_CARDS)).length).toBeGreaterThanOrEqual(5);
    expect(new Set(cards.map((card) => card.slug)).size).toBe(cards.length);
  });
});

describe('hasEnoughSeededCells', () => {
  it('shows the section when the full designed set is seeded', () => {
    expect(hasEnoughSeededCells(allSeeded())).toBe(true);
  });

  it('hides the section when the catalog seeds too few designed cards', () => {
    expect(hasEnoughSeededCells(new Set(ALL_SLUGS.slice(0, MIN_CELLS - 1)))).toBe(false);
  });

  it('hides the section when seeded packs lack usable preview dimensions', () => {
    const seededPacks = allSeeded();
    const cardsWithDimensions = new Set(ALL_SLUGS.slice(0, MIN_CELLS - 1));
    expect(seededPacks.size).toBe(ALL_SLUGS.length);
    expect(hasEnoughSeededCells(cardsWithDimensions)).toBe(false);
  });

  it('shows the section at exactly MIN_CELLS', () => {
    expect(hasEnoughSeededCells(new Set(ALL_SLUGS.slice(0, MIN_CELLS)))).toBe(true);
  });

  it('ignores slugs that are not part of the designed wall', () => {
    expect(hasEnoughSeededCells(new Set([...ALL_SLUGS.slice(0, 3), 'a', 'b', 'c', 'd']))).toBe(
      false,
    );
  });
});

describe('SHELVES', () => {
  it('keeps shelf keys and per-shelf slugs unique, with trends first', () => {
    expect(new Set(SHELVES.map((shelf) => shelf.key)).size).toBe(SHELVES.length);
    for (const shelf of SHELVES) {
      expect(new Set(shelf.slugs).size).toBe(shelf.slugs.length);
    }
    expect(SHELVES[0]).toMatchObject({ key: 'trends', trend: true });
  });

  it('does not re-derive the implicit Все shelf', () => {
    expect(SHELVES.map(({ slugs }) => [...slugs].sort())).not.toContainEqual(
      [...CARD_SLUGS].sort(),
    );
  });
});

describe('visibleShelves', () => {
  it('hides a shelf with fewer than MIN_SHELF_CELLS renderable cards', () => {
    const shelf = SHELVES[0]!;
    expect(visibleShelves([shelf], new Set(shelf.slugs.slice(0, MIN_SHELF_CELLS - 1)))).toEqual([]);
  });

  it('counts only renderable slugs and preserves shelf order', () => {
    const trends = SHELVES[0]!;
    const camera = SHELVES[1]!;
    const renderable = new Set([
      ...trends.slugs.slice(0, 3),
      ...camera.slugs.slice(0, 3),
      'unlisted',
    ]);

    expect(
      visibleShelves(SHELVES, renderable).map(({ shelf, count }) => [shelf.key, count]),
    ).toEqual([
      ['trends', 3],
      ['camera', 3],
    ]);
  });
});
