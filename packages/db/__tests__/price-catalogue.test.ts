import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCostLegs, type CostLeg } from '../src/cost-legs';
import {
  buildCatalogue,
  chargeFor,
  entryKey,
  servingModelId,
  splitModelId,
  type CatalogueEntry,
} from '../src/price-catalogue';

const file = parseCostLegs(readFileSync(join(__dirname, '../seed/cost-legs.csv'), 'utf8'));
const catalogue = buildCatalogue(file);
const byKey = new Map(catalogue.map((e) => [entryKey(e), e]));

describe('the catalogue is derived from the export, not transcribed', () => {
  it('folds every leg into a configuration and loses none', () => {
    expect(catalogue.length).toBeGreaterThan(0);
    expect(catalogue.reduce((a, e) => a + e.legs.length, 0)).toBe(file.legs.length);
  });

  it('carries the rungs rev. 6 added, at the prices finance signed', () => {
    // Spot-priced deliberately: these five are the reason rev. 6 exists, and a
    // derivation that silently dropped them would still pass a count check.
    // kling 1080p is GONE in rev. 11 — the catalogue declares `resolutions: ['720p']`,
    // so that rung was priced and never sellable.
    expect(byKey.get('kling-v3-0-std|1080p|t2v|да|-|any')).toBeUndefined();
    expect(byKey.get('kling-v3-0-std|4K|t2v|да|-|any')).toBeUndefined();
    expect(byKey.get('veo-3-1|4K|t2v|да|-|any')?.credits).toBe(750);
    expect(byKey.get('veo-3-1-fast|4K|t2v|да|-|any')?.credits).toBe(365);
    expect(byKey.get('veo-3-1-lite|4K|t2v|да|-|any')?.credits).toBe(304);
  });

  it('separates modes the old key could not tell apart', () => {
    // Rev. 10 LEVELLED HappyHorse: i2v and r2v were 229/294 in rev. 9 and now sell at
    // the t2v price. Kept as an assertion rather than deleted, because the three keys
    // still have to EXIST separately — a catalogue that collapsed them would pass a
    // spot-check on the t2v number alone and lose the ability to price them apart the
    // day finance separates them again.
    expect(byKey.get('happyhorse-1-1|720p|t2v|нет|-|any')?.credits).toBe(212);
    expect(byKey.get('happyhorse-1-1|720p|i2v|нет|-|any')?.credits).toBe(212);
    expect(byKey.get('happyhorse-1-1|720p|r2v|нет|-|any')?.credits).toBe(212);

    // Where a mode still costs different money, the catalogue must carry the
    // difference — these are the rows a mode-blind price key cannot represent, and
    // the reason the axis is worth adding. Both vendors meter the input frame.
    // Kling is the counter-example now, and it is the more important one: rev. 11
    // repriced t2v from the leg that actually exists, and t2v and i2v CONVERGED on
    // 270. The mode split rev. 10 recorded for it was an artefact of a Kie leg with
    // no route behind it — a price difference between modes is only real when the
    // modes route differently.
    expect(byKey.get('kling-v3-0-std|720p|t2v|да|-|any')?.credits).toBe(270);
    expect(byKey.get('kling-v3-0-std|720p|i2v|да|-|any')?.credits).toBe(270);
    expect(byKey.get('kling-v3-0-std|720p|t2v|нет|-|any')?.credits).toBe(180);
    expect(byKey.get('kling-v3-0-std|720p|i2v|нет|-|any')?.credits).toBe(180);
    // Wan is the second convergence, and the sharper illustration of the same rule.
    // Its mode split WAS real: kie served text-to-video only, so a framed shot ran on
    // OpenRouter's 25% dearer meter. Rev. 21 closes it — not by deciding the modes
    // should cost the same, but because `wan/2-7-image-to-video` was wired and a paid
    // call proved both modes now run the same leg at the same rate. The rows stay
    // separate at equal prices: the key must keep telling the modes apart for the day
    // one of them routes somewhere else again.
    expect(byKey.get('wan-2-7|720p|t2v|нет|-|any')?.credits).toBe(163);
    expect(byKey.get('wan-2-7|720p|i2v|нет|-|any')?.credits).toBe(163);
    expect(byKey.get('wan-2-7|1080p|t2v|нет|-|any')?.credits).toBe(244);
    expect(byKey.get('wan-2-7|1080p|i2v|нет|-|any')?.credits).toBe(244);
  });

  it('charges nothing extra for a reference where the vendor meters output only', () => {
    // Rev. 8 withdrew a 55–62% r2v premium after the OpenRouter model card was
    // read against it: the token formula (h × w × duration × 24)/1024 has no
    // input term, and the provider table has exactly two rates — with audio and
    // without — at one price. A reference cannot be metered by a formula that
    // does not measure it, so r2v sells at the t2v price.
    //
    // Every rung is still checked. rev. 12 broke the rule at exactly one of them —
    // it moved 1080p t2v to 775 and left the r2v twin at 776 — and the temptation
    // was to drop 1080p out of this loop. That would retire the ruling at the only
    // rung where it is currently being violated, which is the one place it has to
    // keep speaking. Instead the loop reports EVERY divergence and the known one is
    // pinned by value, so a second divergence fails and the fix of the first fails
    // too (this list must then shrink, and this comment go with it).
    const divergences = ['480p', '720p', '1080p']
      .map((rung) => ({
        rung,
        r2v: byKey.get(`seedance-2-0|${rung}|r2v|нет|-|any`)?.credits,
        t2v: byKey.get(`seedance-2-0|${rung}|t2v|нет|-|any`)?.credits,
      }))
      .filter((row) => row.r2v !== row.t2v)
      .map((row) => `${row.rung}: r2v ${row.r2v} vs t2v ${row.t2v}`);
    expect(
      divergences,
      'the export must price r2v at its t2v twin, except where a signed reason says otherwise',
      // EMPTY since rev. 13, which accepted owner ruling 5 and re-expressed all five
      // parity rows as a REFERENCE to the t2v twin instead of an independent
      // computation. The 776-vs-775 divergence this list was written for is gone at the
      // source, not patched at our end. The assertion stays over the whole rung set: a
      // future export that recomputes rather than mirrors fails here again.
    ).toEqual([]);

    // Rev. 16 signs the same 4K Kie price for r2v and t2v. One 4K seed row serves
    // every mode; the parked reference-to-video selector carries that same value.
    expect(byKey.get('seedance-2-0|4K|r2v|нет|-|any')?.credits).toBe(2108);
    expect(byKey.get('seedance-2-0|4K|t2v|нет|-|any')?.credits).toBe(2108);
  });

  it('reads the billing basis the vendor actually uses', () => {
    const veo = byKey.get('veo-3-1|720p|t2v|да|-|any');
    expect(veo?.unitKind).toBe('clip');
    // One clip. rev. 13 briefly wrote 8 here — the clip's DURATION, written into the
    // billing-quantity field — while the cost column on the same rows still costed one
    // clip. rev. 14 derives the field from the billing basis instead, so the two columns
    // can no longer be computed from different premises.
    expect(veo?.baseUnits).toBe(1);

    const seedance = byKey.get('seedance-2-0|720p|t2v|нет|-|any');
    expect(seedance?.unitKind).toBe('second');
    expect(seedance?.baseUnits).toBe(5);

    const image = byKey.get('flux-2-pro|1K|t2i|-|-|any');
    expect(image?.unitKind).toBe('image');
    expect(image?.baseUnits).toBe(1);
  });

  it('orders legs primary-first so the router never has to guess', () => {
    for (const e of catalogue) {
      expect(e.legs[0]?.leg, entryKey(e)).toBe(1);
      expect(e.legs.map((l) => l.leg)).toEqual([...e.legs.map((l) => l.leg)].sort());
    }
  });

  it('never lets two legs of one configuration quote different prices', () => {
    // The owner's standing rule, asserted against the real file rather than a
    // fixture: a customer who was failed over must see the same number.
    for (const e of catalogue) {
      for (const leg of e.legs) expect(leg.credits, entryKey(e)).toBe(e.credits);
    }
  });
});

describe('charging', () => {
  const perSecond = byKey.get('seedance-2-0|720p|t2v|нет|-|any')!;
  const perClip = byKey.get('veo-3-1|720p|t2v|да|-|any')!;
  const perImage = byKey.get('flux-2-pro|1K|t2i|-|-|any')!;

  it('scales a per-second configuration by output seconds', () => {
    expect(chargeFor(perSecond, 5)).toBe(323);
    expect(chargeFor(perSecond, 10)).toBe(646);
    // Rounds UP: a partial second is a second we are billed for.
    expect(chargeFor(perSecond, 4)).toBe(Math.ceil((323 * 4) / 5));
  });

  it('charges a per-clip configuration one price at every duration', () => {
    // The Veo defect, pinned. Rev. 6 sells one price per clip because the vendor
    // charges one price per clip; a 4-second clip that billed 299 instead of 597
    // would run at −27% margin on a rung finance signed at +36%.
    expect(chargeFor(perClip, 4)).toBe(597);
    expect(chargeFor(perClip, 6)).toBe(597);
    expect(chargeFor(perClip, 8)).toBe(597);
  });

  it('scales a per-image configuration by image count', () => {
    expect(chargeFor(perImage, 1)).toBe(11);
    expect(chargeFor(perImage, 4)).toBe(44);
  });

  it('refuses a non-positive duration rather than charging zero', () => {
    expect(() => chargeFor(perSecond, 0)).toThrow(/units must be positive/);
    expect(() => chargeFor(perSecond, -1)).toThrow(/units must be positive/);
  });
});

describe('model id ↔ (model, mode)', () => {
  it('splits the suffixes our picker carries as separate rows', () => {
    expect(splitModelId('seedance-2-0-reference-to-video')).toEqual({
      modelId: 'seedance-2-0',
      mode: 'r2v',
    });
    expect(splitModelId('seedance-2-0-fast-reference-to-video')).toEqual({
      modelId: 'seedance-2-0-fast',
      mode: 'r2v',
    });
    expect(splitModelId('seedance-2-0')).toEqual({ modelId: 'seedance-2-0', mode: null });
  });

  it('resolves every split id back to a model finance prices', () => {
    const priced = new Set(catalogue.map((e) => e.modelId));
    for (const id of ['seedance-2-0-reference-to-video', 'seedance-2-0-fast-reference-to-video']) {
      expect(priced.has(splitModelId(id).modelId), id).toBe(true);
    }
  });
});

describe('the folder refuses ambiguity instead of picking a winner', () => {
  const leg = (over: Partial<CostLeg>): CostLeg => ({
    modelId: 'm',
    rung: '720p',
    mode: 't2v',
    audio: false,
    quality: null,
    leg: 1,
    role: 'primary',
    relay: 'Kie',
    upstream: 'X',
    providerSku: 'sku',
    channel: 'прямой',
    fxMultiplier: 1.1839,
    basis: 'за секунду',
    usdPerUnit: 0.1,
    landedRubPerUnit: 100.6315,
    costRubDisplay: 10,
    costKnown: true,
    confidence: 'HIGH',
    credits: 100,
    margin: 0.25,
    ladderDepth: 1,
    source: 'test',
    capturedOn: '2026-08-03',
    quantity: 5,
    aspect: 'any',
    refsMin: 0,
    refsMax: 0,
    bandPricing: 'плоская',
    perImageSurchargeUsd: 0,
    rowKey: 'm|720p|t2v|нет|-|any|нога1',
    routeRisk: null,
    defaultRung: '720p',
    areaMp: null,
    ...over,
  });
  const wrap = (legs: CostLeg[]) => ({ legs, excluded: [], declared: file.declared });

  it('rejects two legs quoting different prices', () => {
    expect(() => buildCatalogue(wrap([leg({}), leg({ leg: 2, credits: 90 })]))).toThrow(
      /legs disagree on price/,
    );
  });

  it('rejects two legs priced over different quantities', () => {
    expect(() => buildCatalogue(wrap([leg({}), leg({ leg: 2, quantity: 6 })]))).toThrow(
      /legs disagree on quantity/,
    );
  });

  it('rejects two legs on different billing bases', () => {
    expect(() => buildCatalogue(wrap([leg({}), leg({ leg: 2, basis: 'за клип' })]))).toThrow(
      /legs disagree on billing basis/,
    );
  });

  it('rejects a configuration served only by a reserve leg', () => {
    expect(() => buildCatalogue(wrap([leg({ leg: 2 })]))).toThrow(/no primary leg/);
  });
});

describe('the shape of what we sell', () => {
  it('agrees with finance about what one configuration IS', () => {
    // This replaces a check that could not fail. The old one asserted the entries were
    // unique — but they come from a Map keyed on exactly those fields, so uniqueness was
    // guaranteed by construction and the test restated the Map. The real question is
    // whether OUR key and FINANCE's key describe the same partition of the file; if they
    // disagree, two rows they consider distinct collapse into one of ours, or the
    // reverse, and the price that survives is whichever was parsed last.
    const byTheirs = new Map<string, string>();
    for (const leg of file.legs) {
      const ours = `${entryKey(leg)}|нога${leg.leg}`;
      const seen = byTheirs.get(leg.rowKey);
      expect(seen ?? ours, `finance row key ${leg.rowKey} means two things to us`).toBe(ours);
      byTheirs.set(leg.rowKey, ours);
    }
    expect(byTheirs.size).toBe(file.legs.length);
  });

  it('never prices a dearer rung below a cheaper one within a model and mode', () => {
    // Parametric pricing's whole promise. Checked per (model, mode, audio) so a
    // mode that costs more everywhere cannot mask an inverted ladder inside one.
    // One ordering serving both ladders: a model is either video (480p→4K) or
    // image (1K→4K), never both, and 4K is the top of each.
    const RUNGS = ['480p', '720p', '1080p', '1K', '2K', '3K', '4K'];
    const groups = new Map<string, CatalogueEntry[]>();
    for (const e of catalogue) {
      if (!RUNGS.includes(e.rung)) continue;
      const g = `${e.modelId}|${e.mode}|${e.audio}`;
      groups.set(g, [...(groups.get(g) ?? []), e]);
    }
    const inversions: string[] = [];
    for (const [g, entries] of groups) {
      const ordered = [...entries].sort((a, b) => RUNGS.indexOf(a.rung) - RUNGS.indexOf(b.rung));
      for (let i = 1; i < ordered.length; i += 1) {
        const lo = ordered[i - 1]!;
        const hi = ordered[i]!;
        if (hi.credits < lo.credits) {
          inversions.push(`${g}: ${hi.rung}=${hi.credits} < ${lo.rung}=${lo.credits}`);
        }
      }
    }
    expect(inversions).toEqual([]);
  });
});

describe('which catalogue entry serves a configuration', () => {
  // The owner's 2026-08-04 ruling: separate entries in the picker (so /boards can
  // read reference slots off the selected model), one price behind them.
  const known = new Set([
    'seedance-2-0',
    'seedance-2-0-reference-to-video',
    'seedream-5-0-pro',
    'happyhorse-1-1',
  ]);

  it('routes a mode with its own picker entry to that entry', () => {
    expect(servingModelId({ modelId: 'seedance-2-0', mode: 'r2v' }, known)).toBe(
      'seedance-2-0-reference-to-video',
    );
  });

  it('routes a request-shape mode back to the base model', () => {
    // refs-2-10 is a request shape — how many references are attached — not a
    // second seedream in the picker.
    expect(servingModelId({ modelId: 'seedream-5-0-pro', mode: 'refs-2-10' }, known)).toBe(
      'seedream-5-0-pro',
    );
  });

  it('REFUSES a mode whose picker entry does not exist, instead of aliasing the base', () => {
    // The dangerous version returned the base model here. HappyHorse 1.1 has no
    // `-image-to-video` entry, so its i2v price (229) would have been attached to the
    // plain model — whose adapters silently drop the reference. The customer pays the
    // reference price and receives a plain generation. Returning null makes a gap
    // visible as a gap, which is the only state that can be fixed.
    expect(servingModelId({ modelId: 'happyhorse-1-1', mode: 'i2v' }, known)).toBeNull();
    expect(servingModelId({ modelId: 'happyhorse-1-1', mode: 'video-edit' }, known)).toBeNull();
  });

  it('returns null rather than inventing a model we do not carry', () => {
    expect(servingModelId({ modelId: 'wan-2-7', mode: 't2v' }, known)).toBeNull();
  });

  it('round-trips with splitModelId for every suffixed entry', () => {
    for (const id of ['seedance-2-0-reference-to-video']) {
      const { modelId, mode } = splitModelId(id);
      expect(servingModelId({ modelId, mode: mode! }, known)).toBe(id);
    }
  });
});

/**
 * An acknowledgement clears a money gate, so it must not quietly widen.
 *
 * Grok's is the last one standing: rev. 13 measured the gpt-image-2 rates and rev. 15
 * split route risk out of confidence, and both РИСК acknowledgements died with them —
 * which is the shape a healthy one has, a note that stops being needed. What remains
 * covers the two i2v rungs whose rate is still a hypothesis. Keyed on the model id alone
 * it would adopt every Grok rung added afterwards, including one unverified for an
 * entirely different and unread reason.
 */
describe('an acknowledgement covers only what it was written against', () => {
  const grok = (over: Partial<CostLeg>): CostLeg => ({
    modelId: 'grok-imagine-video',
    rung: '720p',
    mode: 'i2v',
    audio: false,
    quality: null,
    leg: 1,
    role: 'primary',
    relay: 'Kie',
    upstream: 'xAI',
    providerSku: 'sku',
    channel: 'прямой',
    fxMultiplier: 1.1839,
    basis: 'за секунду',
    usdPerUnit: 0.02,
    landedRubPerUnit: 100.6315,
    costRubDisplay: 2.01,
    costKnown: true,
    confidence: 'HYPOTHESIS',
    credits: 40,
    margin: 0.55,
    ladderDepth: 1,
    source: 'test',
    capturedOn: '2026-08-10',
    quantity: 5,
    aspect: 'any',
    refsMin: 0,
    refsMax: 0,
    bandPricing: 'плоская',
    perImageSurchargeUsd: 0,
    routeRisk: null,
    defaultRung: '480p',
    areaMp: null,
    rowKey: 'grok-imagine-video|720p|i2v|нет|-|any|нога1',
    ...over,
  });
  const at = new Date('2026-08-12T00:00:00Z');
  const build = (legs: CostLeg[]) =>
    buildCatalogue({ legs, excluded: [], declared: file.declared }, at)[0]!;

  it('accepts the ГИПОТЕЗА leg on a configuration it names', () => {
    const entry = build([grok({})]);
    expect(entry.blockers).toEqual([]);
    expect(entry.acknowledged.join(' ')).toContain('ГИПОТЕЗА');
  });

  it('blocks the same ГИПОТЕЗА on a configuration it does not name', () => {
    // The t2v pair is HIGH on the kie price list and is deliberately outside this
    // acknowledgement; a t2v rung arriving unverified is a new fact, not a covered one.
    const entry = build([
      grok({ mode: 't2v', rowKey: 'grok-imagine-video|720p|t2v|нет|-|any|нога1' }),
    ]);
    expect(entry.acknowledged).toEqual([]);
    expect(entry.blockers.join(' ')).toContain('ГИПОТЕЗА');
  });

  it('expires rather than renewing by default', () => {
    const entry = buildCatalogue(
      { legs: [grok({})], excluded: [], declared: file.declared },
      new Date('2026-10-01T00:00:00Z'),
    )[0]!;
    expect(entry.acknowledged).toEqual([]);
    expect(entry.blockers.join(' ')).toContain('ГИПОТЕЗА');
  });
});
