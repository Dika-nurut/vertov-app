import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  modelCardName,
  modelCards,
  videoMediaLimits,
  videoMediaParams,
  videoPriceParams,
} from './generate-model-cards';
import type { ModelCardSource } from './generate-model-cards';

/**
 * /generate model-card contract (owner decision 2026-07-25).
 *
 * Seedance ships in pairs — a base row that takes first/last KEYFRAMES and a
 * `-reference-to-video` twin that takes up to 9 stills + audio (video input is
 * currently withdrawn because it is unpriced)
 * REFERENCES. They are two different tools. /boards has always listed both as
 * separate rows; /generate used to hide the twins and swap to them whenever any
 * asset was attached, which made the keyframe path unreachable on the two
 * most-used video models. Both surfaces now expose both rows, and the card the
 * user picks decides what gets sent.
 *
 * Catalog shapes below mirror packages/db/seed/models.ts.
 */

const seedance20: ModelCardSource = {
  id: 'seedance-2-0',
  family: 'seedance',
  variant: '2.0',
  kind: 'video',
  capabilities: { audio: true, frames: ['first', 'last'] },
};
const seedance20Ref: ModelCardSource = {
  id: 'seedance-2-0-reference-to-video',
  family: 'seedance',
  variant: '2.0-reference',
  kind: 'video',
  capabilities: {
    audio: true,
    reference: true,
    multi_image: true,
    maxRefs: 9,
    maxVideoRefs: 0,
    maxAudioRefs: 3,
  },
};
const seedance20Fast: ModelCardSource = {
  id: 'seedance-2-0-fast',
  family: 'seedance',
  variant: '2.0-fast',
  kind: 'video',
  capabilities: { audio: true, frames: ['first', 'last'] },
};
const seedance20FastRef: ModelCardSource = {
  id: 'seedance-2-0-fast-reference-to-video',
  family: 'seedance',
  variant: '2.0-fast-reference',
  displayName: 'Seedance Studio Reference',
  kind: 'video',
  capabilities: {
    audio: true,
    reference: true,
    multi_image: true,
    maxRefs: 9,
    maxVideoRefs: 0,
    maxAudioRefs: 3,
  },
};
const happyhorse: ModelCardSource = {
  id: 'happyhorse-1-1',
  family: 'HappyHorse',
  variant: '1.1',
  kind: 'video',
  capabilities: { frames: ['first'] },
};
const grok: ModelCardSource = {
  id: 'grok-imagine-video',
  family: 'Grok',
  variant: 'Imagine',
  kind: 'video',
  capabilities: { reference: false, frames: [] },
};
const seedream: ModelCardSource = {
  id: 'seedream-4-0',
  family: 'seedream',
  variant: '4.0',
  kind: 'image',
  capabilities: { reference: true, maxRefs: 14 },
};

// Catalog order = the API's `ORDER BY kind, id` (alphabetical within a kind).
const CATALOG = [
  seedance20,
  seedance20Fast,
  seedance20FastRef,
  seedance20Ref,
  happyhorse,
  grok,
  seedream,
];

describe('modelCards: the twins are their own cards', () => {
  it('lists every video row, twins included — one card per catalog row', () => {
    const ids = modelCards(CATALOG, 'video').map((c) => c.model.id);

    expect(ids).toContain('seedance-2-0');
    expect(ids).toContain('seedance-2-0-reference-to-video');
    expect(ids).toContain('seedance-2-0-fast');
    expect(ids).toContain('seedance-2-0-fast-reference-to-video');
    expect(ids).toHaveLength(6); // 4 seedance + happyhorse + grok, no image rows
  });

  it('labels the pair by INPUT, not by a technical variant suffix', () => {
    const byId = new Map(modelCards(CATALOG, 'video').map((c) => [c.model.id, c]));

    expect(byId.get('seedance-2-0')!.name).toBe('Seedance 2.0 · кадры');
    expect(byId.get('seedance-2-0')!.note).toBe('первый и последний кадр');
    expect(byId.get('seedance-2-0-reference-to-video')!.name).toBe('Seedance 2.0 · референсы');
    expect(byId.get('seedance-2-0-reference-to-video')!.note).toBe('до 9 фото · звук');

    expect(byId.get('seedance-2-0-fast')!.name).toBe('Seedance 2.0 Fast · кадры');
    expect(byId.get('seedance-2-0-fast-reference-to-video')!.name).toBe(
      'Seedance Studio Reference · референсы',
    );
  });

  it('keeps the plain catalog label on rows that have no twin to disambiguate', () => {
    const byId = new Map(modelCards(CATALOG, 'video').map((c) => [c.model.id, c]));

    expect(byId.get('happyhorse-1-1')!.name).toBe('HappyHorse 1.1');
    expect(byId.get('happyhorse-1-1')!.note).toBeNull();
    expect(byId.get('grok-imagine-video')!.name).toBe('Grok Imagine');
  });

  it('puts each twin directly after its base so the pair reads as one choice', () => {
    const ids = modelCards(CATALOG, 'video').map((c) => c.model.id);

    expect(ids.slice(0, 4)).toEqual([
      'seedance-2-0',
      'seedance-2-0-reference-to-video',
      'seedance-2-0-fast',
      'seedance-2-0-fast-reference-to-video',
    ]);
  });

  it('resolves the vendor tag even though the catalog stores «seedance» lower-case', () => {
    const card = modelCards(CATALOG, 'video').find((c) => c.model.id === 'seedance-2-0')!;
    expect(card.tag).toBe('ByteDance');
  });

  it('image mode lists only image rows', () => {
    expect(modelCards(CATALOG, 'image').map((c) => c.model.id)).toEqual(['seedream-4-0']);
  });
});

describe('modelCardName: paired catalogue labels', () => {
  it('keeps catalogue wording and trims only a terminal technical reference token', () => {
    const models: ModelCardSource[] = [
      {
        id: 'named-base',
        family: 'Studio',
        variant: 'v1',
        displayName: 'Named Model',
        kind: 'video',
        capabilities: { frames: ['first'] },
      },
      {
        id: 'named-base-reference-to-video',
        family: 'Studio',
        variant: 'v1-reference',
        displayName: 'Named Model',
        kind: 'video',
        capabilities: { reference: true },
      },
      {
        id: 'fallback-base',
        family: 'Studio',
        variant: 'v2',
        kind: 'video',
        capabilities: { frames: ['first'] },
      },
      {
        id: 'fallback-base-reference-to-video',
        family: 'Studio',
        variant: 'v2-reference',
        kind: 'video',
        capabilities: { reference: true },
      },
      {
        id: 'word-base',
        family: 'Studio',
        variant: 'v3',
        kind: 'video',
        capabilities: { frames: ['first'] },
      },
      {
        id: 'word-base-reference-to-video',
        family: 'Studio',
        variant: 'reference',
        displayName: 'Model Reference',
        kind: 'video',
        capabilities: { reference: true },
      },
      {
        id: 'preference-base',
        family: 'Studio',
        variant: 'v4',
        kind: 'video',
        capabilities: { frames: ['first'] },
      },
      {
        id: 'preference-base-reference-to-video',
        family: 'Studio',
        variant: 'Preference',
        kind: 'video',
        capabilities: { reference: true },
      },
      {
        id: 'unpaired',
        family: 'Studio',
        variant: 'v5-reference',
        displayName: 'Unpaired Reference',
        kind: 'video',
        capabilities: { reference: true },
      },
    ];

    expect(modelCardName(models[1]!, models)).toBe('Named Model · референсы');
    expect(modelCardName(models[3]!, models)).toBe('Studio V2 · референсы');
    expect(modelCardName(models[5]!, models)).toBe('Model Reference · референсы');
    expect(modelCardName(models[7]!, models)).toBe('Studio Preference · референсы');
    expect(modelCardName(models[8]!, models)).toBe('Unpaired Reference');
  });
});

describe('videoMediaParams: the picked card decides what is sent', () => {
  it('the base card sends keyframes, capped at the slots it declares', () => {
    const params = videoMediaParams(seedance20, {
      images: ['a.png', 'b.png', 'c.png'],
      videos: [],
      audios: [],
    });

    expect(params).toEqual({ imageUrls: ['a.png', 'b.png'] });
  });

  it('a first-frame-only engine takes exactly one keyframe', () => {
    const params = videoMediaParams(happyhorse, {
      images: ['a.png', 'b.png'],
      videos: [],
      audios: [],
    });

    expect(params).toEqual({ imageUrls: ['a.png'] });
  });

  it('the twin card sends its sellable typed references, not keyframes', () => {
    const params = videoMediaParams(seedance20Ref, {
      images: ['1.png', '2.png', '3.png'],
      videos: ['clip.mp4'],
      audios: ['vo.mp3'],
    });

    expect(params).toEqual({
      imageUrls: ['1.png', '2.png', '3.png'],
      audioUrls: ['vo.mp3'],
    });
  });

  it('a text-to-video-only engine sends no media at all', () => {
    const params = videoMediaParams(grok, { images: ['a.png'], videos: [], audios: [] });

    expect(params).toEqual({});
  });

  it('sends nothing when nothing is attached — media stays optional on frame models', () => {
    expect(videoMediaParams(seedance20, { images: [], videos: [], audios: [] })).toEqual({});
  });
});

describe('the model pick is authoritative — attaching media never re-picks it', () => {
  /* The regression this guards is the one that hid first/last frame: an effect
   * that watched `hasReference` (any attached image/video/audio) and called
   * setModelId to swap between a base row and its reference twin. Attachment is
   * an INPUT to the picked model, never a reason to change it. There's no DOM in
   * this suite (vitest runs `environment: 'node'`), so this is asserted against
   * the source: no effect may both read the media state and set the model. */
  const src = readFileSync(join(__dirname, '..', 'app', 'generate', 'GenerateClient.tsx'), 'utf8');
  const lines = src.split('\n');

  it('has no effect that changes the model in response to attached media', () => {
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      const deps = /^\s*\}, \[(.*)\]\);\s*$/.exec(line);
      if (!deps || !/imageUrls|videoUrls|audioUrls|hasReference/.test(deps[1]!)) return;
      // Walk back to the effect this dependency array closes.
      const start = lines.slice(0, i).findLastIndex((l) => /useEffect\(/.test(l));
      if (start < 0) return;
      const body = lines.slice(start, i).join('\n');
      if (/setModelId\(/.test(body)) offenders.push(`line ${start + 1}: ${lines[start]!.trim()}`);
    });

    expect(offenders).toEqual([]);
  });

  it('no longer reaches for the reference twin by id suffix', () => {
    // Prose may still explain the decision; code may not act on the suffix.
    const code = lines.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

    expect(code.filter((l) => l.includes('reference-to-video'))).toEqual([]);
  });
});

describe('videoMediaLimits: the drop zone is bounded by the model', () => {
  it('a keyframe model offers only its frame slots', () => {
    expect(videoMediaLimits(seedance20)).toEqual({ image: 2, video: 0, audio: 0 });
    expect(videoMediaLimits(happyhorse)).toEqual({ image: 1, video: 0, audio: 0 });
  });

  it('a reference model offers its declared reference capacity', () => {
    expect(videoMediaLimits(seedance20FastRef)).toEqual({ image: 9, video: 0, audio: 3 });
  });

  it('a text-to-video engine offers no slots', () => {
    expect(videoMediaLimits(grok)).toEqual({ image: 0, video: 0, audio: 0 });
  });
});

/**
 * Goal invariant 4 — estimate == charge. The /generate estimate and the /generate
 * submit must derive every media field from the SAME gate. Video input is
 * already a price dimension, and reference/frame count is the next one.
 *
 * The bug (pricing-audit-paths-2026-07-27 finding B3): the estimate sent
 * `videoUrls` whenever any existed in component state while submit sent them only
 * for a reference-mode card. Media is deliberately not wiped on a model switch,
 * so the stale-media case below quoted FLAT and charged PARAMETRIC.
 */
describe('videoPriceParams: the quote and the charge see the same media', () => {
  const refs = { images: ['a.png'], videos: ['ref.mp4'], audios: ['a.mp3'] };
  const at = (model: ModelCardSource, generateAudio = true) =>
    videoPriceParams(model, { durationSeconds: 8, resolution: '1080p', generateAudio, refs });

  it('carries frame images even though they were previously stripped', () => {
    const quoted = at(seedance20);
    const submitted = videoMediaParams(seedance20, refs);

    expect(quoted).toEqual({
      duration_seconds: 8,
      resolution: '1080p',
      generate_audio: true,
      ...submitted,
    });
    expect(quoted['imageUrls']).toEqual(['a.png']);
  });

  it('carries reference images while preserving the model media gate', () => {
    const quoted = at(seedance20Ref);
    const submitted = videoMediaParams(seedance20Ref, refs);

    expect(quoted).toEqual({
      duration_seconds: 8,
      resolution: '1080p',
      generate_audio: true,
      ...submitted,
    });
    expect(quoted['imageUrls']).toEqual(['a.png']);
    expect(quoted['videoUrls']).toBeUndefined();
  });

  it('preserves exact media parity after a model switch', () => {
    // Attach a video reference on «Seedance 2.0 · референсы», then switch to Veo
    // (or kling/wan/grok/happyhorse/omni — every one is `reference: false`). The
    // attachment survives the switch by design; the quote must not.
    for (const model of [happyhorse, grok, seedance20]) {
      expect(at(model), model.id).toEqual({
        duration_seconds: 8,
        resolution: '1080p',
        generate_audio: (model.capabilities ?? {})['audio'] === true,
        ...videoMediaParams(model, refs),
      });
    }
  });

  it('agrees with the submit payload by construction, not by coincidence', () => {
    // Same gate, same inputs → every media key in the estimate IS the submit
    // media, which is what makes future reference pricing safe.
    for (const model of [
      seedance20,
      seedance20Fast,
      seedance20Ref,
      seedance20FastRef,
      happyhorse,
      grok,
    ]) {
      const submitted = videoMediaParams(model, refs);
      const quoted = at(model);
      expect(quoted, model.id).toEqual({
        duration_seconds: 8,
        resolution: '1080p',
        generate_audio: (model.capabilities ?? {})['audio'] === true,
        ...submitted,
      });
    }
  });

  /**
   * The audio lever is a PRICE dimension, and kling-v3-0-std is the one live model with
   * BOTH audio states seeded active (720p: 270 cr with sound, 180 without). The estimate
   * used to omit `generate_audio` entirely; `priceSelectorFromParams` reads an absent
   * field as `true`, so the badge always quoted the loud price while the submit sent the
   * user's real choice — and quote binding then refused the job as `quote_stale`. Every
   * silent Kling generation from /generate was unreachable.
   */
  it('sends the audio choice for a model that sells sound separately', () => {
    const kling: ModelCardSource = {
      id: 'kling-v3-0-std',
      family: 'kling',
      variant: 'v3-0-std',
      kind: 'video',
      capabilities: { audio: true },
    };
    const quiet = videoPriceParams(kling, {
      durationSeconds: 5,
      resolution: '720p',
      generateAudio: false,
      refs: { images: [], videos: [], audios: [] },
    });
    expect(quiet['generate_audio']).toBe(false);
    expect(at(kling, true)['generate_audio']).toBe(true);
  });

  it('pins the audio field to false for a model with no audio lever', () => {
    // Mirrors the submit's `audioCapable ? genAudio : false`: the two payloads have to
    // agree on the literal, not merely on the price the resolver derives from it.
    expect(at(happyhorse, true)['generate_audio']).toBe(false);
  });

  it('does not expose a toggle for fixed-audio output', () => {
    const fixedAudio: ModelCardSource = {
      id: 'gemini-omni-flash',
      family: 'gemini',
      variant: 'omni',
      kind: 'video',
      capabilities: { audio: true, audioControl: false },
    };
    expect(
      videoPriceParams(fixedAudio, {
        durationSeconds: 8,
        resolution: '720p',
        generateAudio: true,
        refs: { images: [], videos: [], audios: [] },
      }),
    ).toMatchObject({ generate_audio: false });
  });
});
