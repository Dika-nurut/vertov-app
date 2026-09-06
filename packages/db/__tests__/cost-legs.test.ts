import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  configKey,
  executableIdentity,
  parseCostLegs,
  reconcileLeg,
  type CostLeg,
} from '../src/cost-legs';
import { creditFloorRub } from '../src/price-breakeven';
import { seedSubscriptionTiers } from '../seed/subscription-catalog';
import { PRICE_POINT_SEED } from '../seed/price-points';
import { ourPointFor } from './fixtures/price-row-mapping';

/**
 * Legs we carry no ACTIVE price point for. Each is deliberate and named — a silent skip
 * is how an uncosted leg reaches production looking checked.
 * Reasons are grouped inline: inactive routes, absent serving models, or a price
 * dimension the current DB key cannot represent.
 */
const UNMATCHED_LEGS: readonly string[] = [
  // Owner ruling 2026-08-26: the temporary Flux 1K 2–8-reference premium is retired.
  // Its historical signed legs remain in the export, but the selector now falls back
  // to the plain signed 1K row and is deliberately not sold from the band row.
  'flux-2-pro|1K|refs-2-8|audio=null',
  // With-video configurations. Our with-video rows are parked inactive (no trusted
  // media-duration source exists yet), so there is nothing to reconcile — and the
  // plain row must NOT stand in for them: happyhorse-1-0's video-edit price is 487
  // against a 284 plain rung.
  'happyhorse-1-0|1080p|video-edit|audio=false',
  'happyhorse-1-0|720p|video-edit|audio=false',
  // Rungs priced but deliberately not on sale: seedance 4K (owner ruling 3, kie probe
  // unresolved) and Veo 4K (the `/veo/get-4k-video` second step is not wired).
  'seedance-2-0|4K|r2v|audio=false',
  'seedance-2-0|4K|t2v|audio=false',
  'veo-3-1|4K|t2v|audio=true',
  'veo-3-1-fast|4K|t2v|audio=true',
  'veo-3-1-lite|4K|t2v|audio=true',
  // Seedream 4.5's 1K rung: kie's route exposes no 1K quality tier, so the row is
  // retained for drift mapping and cannot be sold.
  'seedream-4-5|1K|i2i|audio=null',
  'seedream-4-5|1K|t2i|audio=null',
];

// The list held 33 legs before the price key carried a mode and a band. Twenty-four
// left it in one change, and not one was excused — they became REPRESENTABLE, so they
// are now reconciled against finance's own numbers:
//
//   * every i2v leg (seedance, veo, happyhorse, kling, grok) reconciles against the
//     plain row. That is the honest check that finance really did price i2v AT the
//     t2v number on those models — Wan is where it did not, and Wan has its own row.
//   * both Seedream Pro 2–10 bands and Flux's 2–8 band reconcile against the band rows
//     that replaced the per-item stand-in.
//
// What is left is nine legs we do not sell, each for a stated reason. Rev. 19's new
// Flux 2K refs leg was briefly a tenth gap before its own active price point was added;
// keeping that leg out of this list is deliberate because it should be priced.
//
// Rev. 12 added six reserve legs and did NOT move this list, which is the point worth
// recording: every new leg sat on a configuration we already priced, so each one landed
// on an existing active price point rather than creating a new gap. Rev. 19 follows that
// rule for Flux by adding the missing 2K refs point; `seedance-2-0|4K|r2v` stays listed
// for the reason it was always listed — the 4K rung is priced and not sold.

const CSV = readFileSync(join(__dirname, '../seed/cost-legs.csv'), 'utf8');
const file = parseCostLegs(CSV);

function splitCsvForTest(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
}

function quoteCsvForTest(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function refreshLegsDigest(lines: readonly string[]): string {
  const headerIndex = lines.findIndex((line) => splitCsvForTest(line).includes('model_id'));
  let blockEnd = headerIndex + 1;
  while (
    blockEnd < lines.length &&
    lines[blockEnd]!.trim() !== '' &&
    !lines[blockEnd]!.startsWith('#')
  ) {
    blockEnd += 1;
  }
  return createHash('sha256')
    .update(lines.slice(headerIndex, blockEnd).join('\n'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

describe('cost-legs.csv — the contract parses and self-checks', () => {
  it('parses every leg and both blocks', () => {
    // Rev. 22 is a 140-row export: the two Wan reserve rows plus eight explicitly
    // costed Gemini/GPT fallback rows (every mode and quality). The source metadata and
    // digest make any unintended count change visible.
    expect(file.legs).toHaveLength(140);
    expect(file.excluded.length).toBeGreaterThan(0);
  });

  it('the declared row count, credit sum and margin sum all hold', () => {
    // These three exist so a silently deleted row cannot look like a row that never
    // existed — which would take a configuration off sale with no error anywhere.
    expect(file.declared.rows).toBe(140);
    expect(file.legs.reduce((a, l) => a + l.credits, 0)).toBe(file.declared.credits);
    // The margin sum was in this test's NAME and not in its body — the parser checks it
    // at module load, so corruption still failed somewhere, but this test did not prove
    // what it said. A test whose name overstates it is worse than one that says less.
    expect(Number(file.legs.reduce((a, l) => a + l.margin, 0).toFixed(6))).toBe(
      file.declared.margin,
    );
  });

  it('quotes every reference band at the price finance signed for it', () => {
    // This test used to SIZE the gap: a two-reference job quoted 11 against a signed
    // 13, and 17 and 32 against 24 and 38, because the four-column key had no way to
    // say «this is the 2+ configuration» and the job fell through to the plain row.
    // The band closed it, so the assertion inverts — from «still an under-quote» to
    // «exactly the signed number, at both ends of the band».
    const bands = file.legs.filter((leg) => (leg.refsMin ?? 0) > 0);
    expect(bands.length, 'the export must carry the reference bands').toBeGreaterThan(0);

    for (const band of bands) {
      // The retired Flux 1K band is intentionally absent from UNMATCHED_LEGS: its
      // historical legs reconcile against the plain signed 1K row, while the premium
      // selector itself stays inactive. Check the active bands below.
      if (
        band.modelId === 'flux-2-pro' &&
        (band.quality ?? band.rung) === '1K' &&
        (band.refsMin ?? 0) === 2
      ) {
        const fallback = PRICE_POINT_SEED.find(
          (r) =>
            r.modelId === band.modelId &&
            r.resolution === '1K' &&
            r.isActive &&
            r.refsMin === 0 &&
            r.refsMax === null,
        );
        expect(fallback?.baseCredits).toBe(11);
        continue;
      }
      const resolution = band.quality ?? band.rung;
      const row = PRICE_POINT_SEED.find(
        (r) =>
          r.modelId === band.modelId &&
          r.resolution === resolution &&
          r.isActive &&
          r.refsMin === band.refsMin,
      );
      expect(
        row,
        `${band.modelId} ${resolution} ${band.mode} must have its own active price point`,
      ).toBeTruthy();
      expect(row!.baseCredits, `${band.modelId} ${band.mode} band price`).toBe(band.credits);
      expect(row!.refsMax, `${band.modelId} ${band.mode} band ceiling`).toBe(band.refsMax);
      // A banded row is flat for its whole band. A per-item term on top would charge
      // the surcharge the band already covers a second time.
      expect(row!.perItem, `${band.modelId} ${band.mode} must be flat for its band`).toBeNull();

      const plain = PRICE_POINT_SEED.find(
        (r) =>
          r.modelId === band.modelId &&
          r.resolution === resolution &&
          r.isActive &&
          r.refsMin === 0,
      );
      expect(plain, `${band.modelId} ${resolution} lost its 0–1 row`).toBeTruthy();
      // Rev. 19 signs Flux 2K's plain and 2–8 configurations identically: Kie bills
      // flat per image and does not meter the input, so this is the one band whose
      // signed price is equal rather than a reference premium.
      if (band.modelId === 'flux-2-pro' && resolution === '2K') {
        expect(row!.baseCredits, `${band.modelId} ${resolution}: signed equal band`).toBe(
          plain!.baseCredits,
        );
      } else {
        expect(
          plain!.baseCredits,
          `${band.modelId} ${resolution}: the band must cost MORE than the plain rung`,
        ).toBeLessThan(row!.baseCredits);
      }
    }
  });

  it('carries t2i, which is a third of the rows', () => {
    expect(file.legs.filter((l) => l.mode === 't2i').length).toBeGreaterThan(20);
  });

  it('Grok is no longer a hypothesis — the rate was confirmed against the kie card', () => {
    // Rev. 11 removed ГИПОТЕЗА: kie publishes $0.012/$0.0225 per second and prices
    // image-to-video at the SAME rates, which is exactly what the export carried.
    // The tag was about our confidence in READING the rate, and that doubt is gone.
    //
    // Finance kept the 40% floor anyway, and the distinction is worth preserving
    // here so nobody "finishes the job" by lowering it: R-10 fires on the rate
    // being 68–76% under the model owner's list AND the row having no second leg —
    // neither of which a confirmation changes. kie moved Grok 50% in two weeks
    // once; confirming the new number is a snapshot of an unstable series, not
    // evidence of stability.
    const grok = file.legs.filter((l) => l.modelId.startsWith('grok'));
    expect(grok.length).toBeGreaterThan(0);
    for (const l of grok.filter((l) => l.mode === 't2v')) expect(l.confidence).toBe('HIGH');

    // KNOWN INCONSISTENCY in rev. 11, reported to finance: the two NEW i2v rows
    // still carry ГИПОТЕЗА while their t2v twins — same model, same rung, same
    // $/second, same kie card — are HIGH. It moves no price (both sides are 69 and
    // 37), but one of the two labels is wrong about the same fact. Asserted rather
    // than tolerated so it cannot quietly become permanent.
    expect(
      grok
        .filter((l) => l.confidence === 'HYPOTHESIS')
        .map((l) => `${l.rung}|${l.mode}`)
        .sort(),
      'grok i2v should be HIGH like its t2v twin — chase rev. 12',
    ).toEqual(['480p|i2v', '720p|i2v']);
  });

  it('rev. 16 carries the signed Seedance r2v reserve rows in the export', () => {
    // These rates used to be appended locally. They are now export rows, with the
    // finance depth marker and HIGH confidence, so a re-export that quietly moves one
    // of these rates fails here rather than in a margin average.
    const reserves = file.legs
      .filter((leg) => leg.leg === 2 && leg.mode === 'r2v' && leg.modelId.startsWith('seedance'))
      .map((leg) => `${configKey(leg)} → ${leg.relay} $${leg.usdPerUnit}`);
    expect(reserves.sort()).toEqual(
      [
        'seedance-2-0|480p|r2v|нет|-|any → Kie $0.095',
        'seedance-2-0|720p|r2v|нет|-|any → Kie $0.205',
        'seedance-2-0|1080p|r2v|нет|-|any → Kie $0.51',
        'seedance-2-0-fast|480p|r2v|нет|-|any → Kie $0.0775',
        'seedance-2-0-fast|720p|r2v|нет|-|any → Kie $0.165',
      ].sort(),
    );

    for (const leg of file.legs.filter(
      (candidate) =>
        candidate.leg === 2 && candidate.mode === 'r2v' && candidate.modelId.startsWith('seedance'),
    )) {
      expect(leg.ladderDepth, `${configKey(leg)} depth`).toBe(2);
      expect(leg.confidence, `${configKey(leg)} is a signed rate`).toBe('HIGH');
    }
  });

  it('no two legs of one configuration resolve to the same executable identity', () => {
    // A relay label plus a vendor SKU plus a channel IS the call. Two legs that agree on
    // all three are one route written twice — the shape of the seven mislabelled relays.
    const byConfig = new Map<string, CostLeg[]>();
    for (const l of file.legs) {
      const k = configKey(l);
      byConfig.set(k, [...(byConfig.get(k) ?? []), l]);
    }
    const clashes: string[] = [];
    for (const [k, legs] of byConfig) {
      const ids = legs.map(executableIdentity);
      if (new Set(ids).size !== ids.length) clashes.push(k);
    }
    expect(clashes).toEqual([]);
  });

  it('every configuration charges the same credits on every leg that serves it', () => {
    // The owner's rule: the price a customer sees never depends on who served the job.
    const byConfig = new Map<string, Set<number>>();
    for (const l of file.legs) {
      const k = configKey(l);
      byConfig.set(k, (byConfig.get(k) ?? new Set()).add(l.credits));
    }
    const split = [...byConfig].filter(([, v]) => v.size > 1).map(([k]) => k);
    expect(split).toEqual([]);
  });
});

describe('parser strictness — each negative fixture must fail', () => {
  const lines = CSV.split('\n');
  const rebuild = (mut: (l: string[]) => string[]) => mut([...lines]).join('\n');

  it('rejects a deleted row (count no longer matches)', () => {
    expect(() => parseCostLegs(rebuild((l) => [...l.slice(0, 3), ...l.slice(4)]))).toThrow(
      /declared 140 rows, parsed 139/,
    );
  });

  it('rejects an unknown mode', () => {
    expect(() =>
      parseCostLegs(rebuild((l) => l.map((x, i) => (i === 3 ? x.replace(',t2v,', ',t2x,') : x)))),
    ).toThrow(/unrecognised/);
  });

  it('rejects an Excel serial where an ISO date belongs', () => {
    expect(() =>
      parseCostLegs(
        // Matched by SHAPE, not by the literal capture date: pinning the date meant
        // this fixture silently stopped mutating anything the day finance re-exported
        // with a new one, and a negative test that mutates nothing always passes.
        rebuild((l) =>
          l.map((x, i) => (i === 3 ? x.replace(/,\d{4}-\d{2}-\d{2},/, ',46237,') : x)),
        ),
      ),
    ).toThrow(/Дата ISO/);
  });

  it('rejects a missing column', () => {
    expect(() =>
      parseCostLegs(
        rebuild((l) => l.map((x, i) => (i === 2 ? x.replace('ДОСТОВЕРНОСТЬ,', '') : x))),
      ),
    ).toThrow(/header mismatch/);
  });

  it('rejects a blank cost', () => {
    const idx = lines.findIndex((x) => x.startsWith('veo-3-1,720p'));
    expect(() =>
      parseCostLegs(rebuild((l) => l.map((x, i) => (i === idx ? x.replace(',1.25,', ',,') : x)))),
    ).toThrow(/expected a number/);
  });

  // Both key columns were decoration: «КЛЮЧ конфигурации» was read by nobody, and
  // uniqueness was checked on the recomputed key, so a supplied key could name a
  // different configuration than the row it sat on.
  it('rejects a row key that disagrees with the row it sits on', () => {
    const idx = lines.findIndex((x) => x.startsWith('flux-2-pro,2K,t2i'));
    expect(idx).toBeGreaterThan(0);
    expect(() =>
      parseCostLegs(
        // Mutate only column 25 (the row key), leaving column 24's configuration key
        // intact. The row's own columns still compute 2K, so recomputation must catch
        // the supplied 1K key before the prefix check can run.
        rebuild((l) =>
          l.map((x, i) =>
            i === idx
              ? x.replace(',flux-2-pro|2K|t2i|-|-|any|нога1,', ',flux-2-pro|1K|t2i|-|-|any|нога1,')
              : x,
          ),
        ),
      ),
    ).toThrow(/КЛЮЧ строки/);
  });

  it('rejects a configuration key that does not prefix its own row key', () => {
    const idx = lines.findIndex((x) => x.startsWith('gemini-2-5-flash-image,default,t2i'));
    expect(idx).toBeGreaterThan(0);
    expect(() =>
      parseCostLegs(
        // Only column 24 moves: the trailing comma excludes column 25, whose own value
        // continues into `|нога1`. Mutating both would trip the row-key check above and
        // this assertion would pass without ever reaching the code it names.
        rebuild((l) =>
          l.map((x, i) =>
            i === idx
              ? x.replace(
                  ',gemini-2-5-flash-image|default|t2i|-|-|any,',
                  ',gemini-2-5-flash-image|1K|t2i|-|-|any,',
                )
              : x,
          ),
        ),
      ),
    ).toThrow(/КЛЮЧ конфигурации/);
  });

  // rev. 15 ruling 4. A blank «ПОСРЕДНИК» used to parse as '' and travel on as a costed
  // route with no invoiceable counterparty — the export's own margin arithmetic would
  // still add up, so nothing downstream could notice.
  it('rejects a leg whose relay has no name', () => {
    const idx = lines.findIndex((x) => x.startsWith('gemini-2-5-flash-image,default,t2i'));
    expect(idx).toBeGreaterThan(0);
    expect(() =>
      parseCostLegs(
        rebuild((l) =>
          l.map((x, i) => (i === idx ? x.replace(',основная,LaoZhang,', ',основная,,') : x)),
        ),
      ),
    ).toThrow(/a leg without a named relay is not a leg/);
  });

  it('rejects a leg position that cannot be a position at all', () => {
    const idx = lines.findIndex((x) => x.startsWith('gemini-2-5-flash-image,default,t2i'));
    expect(idx).toBeGreaterThan(0);
    expect(() =>
      parseCostLegs(
        rebuild((l) =>
          l.map((x, i) => (i === idx ? x.replace(',1,основная,', ',0,основная,') : x)),
        ),
      ),
    ).toThrow(/expected a position of 1 or more/);
  });

  it('rejects a leg position deeper than its configuration ladder', () => {
    const idx = lines.findIndex((x) => x.startsWith('flux-2-pro,2K,t2i'));
    expect(idx).toBeGreaterThan(0);
    expect(() =>
      parseCostLegs(
        rebuild((l) =>
          l.map((x, i) =>
            i === idx ? x.replace(',1,основная,', ',2,резервная,').replace('|нога1', '|нога2') : x,
          ),
        ),
      ),
    ).toThrow(/ГЛУБИНА ЛЕСТНИЦЫ: leg 2 exceeds ladder depth 1/);
  });

  it('rejects a configuration whose declared ladder has a missing position', () => {
    const lines = CSV.split('\n');
    const removed = file.legs.find(
      (leg) =>
        leg.modelId === 'seedance-2-0' &&
        leg.rung === '480p' &&
        leg.mode === 'r2v' &&
        leg.leg === 2,
    );
    const idx = lines.findIndex(
      (line) => line.startsWith('seedance-2-0,480p,r2v') && line.includes(',2,резервная,'),
    );
    expect(removed).toBeTruthy();
    expect(idx).toBeGreaterThan(0);
    lines.splice(idx, 1);
    lines[0] = lines[0]!
      .replace(/rows=\d+/, `rows=${file.declared.rows - 1}`)
      .replace(/credits=\d+/, `credits=${file.declared.credits - removed!.credits}`)
      .replace(
        /margin=[\d.]+/,
        `margin=${Number((file.declared.margin - removed!.margin).toFixed(6))}`,
      )
      .replace(/sha256_16=[0-9a-f]{16}/, `sha256_16=${refreshLegsDigest(lines)}`);

    expect(() => parseCostLegs(lines.join('\n'))).toThrow(
      /configuration seedance-2-0\|480p\|r2v\|нет\|-\|any.*ladder positions.*1.*2.*\[1\]/,
    );
  });

  /**
   * Was "accepts the same header names in a different order when the digest matches" —
   * true until finance's rev. 20, and a real hole. Their three checksums are all SUMS, so
   * a sideways shift leaves every one intact while each value sits a field to the left;
   * our own digest is taken over whatever text we wrote, so it agrees with the misread.
   * The header validated by NAME SET, so a permutation sailed through and the engine
   * would have read a confidence string as a price. rev. 20 adds a column-order
   * fingerprint, and this now fails — which is what the code comment beside it had
   * claimed all along.
   */
  it('REFUSES the same header names in a different order — the fingerprint catches it', () => {
    const lines = CSV.split('\n');
    const headerIndex = lines.findIndex((line) => line.startsWith('model_id,'));
    const header = splitCsvForTest(lines[headerIndex]!);
    const permutation = [1, 0, ...header.slice(2).map((_, index) => index + 2)];
    lines[headerIndex] = permutation.map((index) => header[index]!).join(',');
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      if (lines[i]!.trim() === '' || lines[i]!.startsWith('#')) break;
      const cells = splitCsvForTest(lines[i]!);
      lines[i] = permutation.map((index) => quoteCsvForTest(cells[index]!)).join(',');
    }
    lines[0] = lines[0]!.replace(/sha256_16=[0-9a-f]{16}/, `sha256_16=${refreshLegsDigest(lines)}`);

    // Both sums are refreshed and both agree — exactly the state finance warned about.
    expect(() => parseCostLegs(lines.join('\n'))).toThrow(/column-order fingerprint mismatch/);
  });

  it('still parses a file written before the fingerprint existed', () => {
    // The field is optional for exactly one reason: a rev. 19 file has no fingerprint and
    // is not thereby corrupt. Every import writes one.
    const lines = CSV.split('\n');
    lines[0] = lines[0]!.replace(/ cols_sha16=[0-9a-f]{16}/, '');
    expect(parseCostLegs(lines.join('\n')).declared.columns).toBeNull();
  });

  // Owner ruling 2026-08-11 (launch-backlog § L, NP-7): a third leg is coming for the
  // seedance r2v rows. The parser no longer has a hard two-leg cap, but it still rejects
  // a third position whose own row declares the signed two-leg depth.
  it('rejects a third leg position whose row still declares a two-leg ladder', () => {
    const idx = lines.findIndex((x) => x.startsWith('gemini-2-5-flash-image,default,t2i'));
    expect(idx).toBeGreaterThan(0);
    expect(() =>
      parseCostLegs(
        rebuild((l) =>
          l.map((x, i) =>
            i === idx
              ? x
                  .replace(',1,основная,', ',3,резервная,')
                  .replace(',0.324621,1,Сетка FX', ',0.324621,3,Сетка FX')
                  .replace('|нога1', '|нога3')
              : x,
          ),
        ),
      ),
    ).toThrow(/ГЛУБИНА ЛЕСТНИЦЫ: leg 3 exceeds ladder depth 2/);
  });

  it('arms a tripwire before a third signed leg can enter the seeded export', () => {
    expect(
      file.legs.filter((leg) => leg.leg >= 3),
      'leg >= 3 requires runtime execution of an N-leg ladder and gate governance of it before import',
    ).toEqual([]);
  });

  // Position and role are two spellings of one fact. «резервная» on leg 1 would make a
  // reserve look like the primary the price is set from — harmless while a row could only
  // be 1 or 2, not harmless under a ladder.
  it('rejects a role that disagrees with its own leg position', () => {
    const idx = lines.findIndex((x) => x.startsWith('gemini-2-5-flash-image,default,t2i'));
    expect(idx).toBeGreaterThan(0);
    expect(() =>
      parseCostLegs(
        rebuild((l) =>
          l.map((x, i) => (i === idx ? x.replace(',1,основная,', ',1,резервная,') : x)),
        ),
      ),
    ).toThrow(/Роль: leg 1 must be основная/);
  });

  it('rejects a file with no meta line', () => {
    expect(() => parseCostLegs(rebuild((l) => l.slice(1)))).toThrow(/meta line/);
  });
});

describe('reconciliation A — recompute every margin from OUR inputs, not the file', () => {
  // The first version of this test derived `quantity` from the file's own
  // `costRubDisplay` and fed the file's own `credits` back in. It passed on all 76 rows of rev. 5
  // and proved nothing: the file was being checked against itself. Adversarial review
  // caught it. Both inputs now come from OUR catalogue, so a disagreement is a finding.
  it('every leg we price is reconciled — and the ones we do not are named, not skipped', () => {
    const floor = creditFloorRub(seedSubscriptionTiers);
    const checked: string[] = [];
    const report: Array<{ key: string; ours: number; theirs: number; deltaPp: number }> = [];
    const unmatched: string[] = [];
    const quantityGaps: string[] = [];
    const basisGaps: string[] = [];
    const signFlips: string[] = [];
    let worst = 0;
    let worstKey = '';

    for (const leg of file.legs) {
      const point = ourPointFor(leg);
      if (!point) {
        unmatched.push(`${leg.modelId}|${leg.rung}|${leg.mode}|audio=${String(leg.audio)}`);
        continue;
      }
      // OUR side comes entirely from OUR catalogue row — the unit kind we sell in and
      // the count we sell — and never from the leg. The previous version computed it as
      // `leg.basis === 'за секунду' ? point.baseUnits : 1`, reading the LEG's basis: on
      // any other basis both sides became the literal 1, so the check could not fire.
      // It was green on exactly the six Veo rows where we and finance do not agree what
      // a unit IS. Same circularity as the first reconciliation, one level down.
      const r = reconcileLeg(
        leg,
        {
          credits: point.baseCredits,
          // A flat-rate row IS the per-clip basis expressed without a new enum value,
          // so it must reconcile as one — otherwise the guard reports a disagreement
          // that we have in fact just resolved.
          unitKind: point.flatRate ? 'clip' : point.unitKind,
          baseUnits: point.baseUnits,
        },
        floor,
      );
      checked.push(r.key);
      if (r.basisMismatch)
        basisGaps.push(`${r.key}: we sell per ${point.unitKind}, finance prices ${leg.basis}`);
      if (r.quantityMismatch)
        quantityGaps.push(`${r.key}: ours ${point.baseUnits}, theirs ${leg.quantity}`);
      if (point.baseCredits !== leg.credits)
        report.push({
          key: r.key,
          ours: point.baseCredits,
          theirs: leg.credits,
          deltaPp: Number(r.deltaPp.toFixed(2)),
        });
      // Only legs where the two sides AGREE on the price test the arithmetic. Where the
      // prices differ, a margin delta is the expected consequence of that difference and
      // says nothing about whether the recomputation is right.
      if (r.recomputedMargin < 0 !== r.statedMargin < 0)
        signFlips.push(
          `${r.key}: finance ${(r.statedMargin * 100).toFixed(2)}%, recomputed ${(
            r.recomputedMargin * 100
          ).toFixed(2)}%`,
        );
      if (point.baseCredits === leg.credits && r.deltaPp > worst) {
        worst = r.deltaPp;
        worstKey = r.key;
      }
    }

    // Legs with no active price point of ours are a real gap, not a pass. Listing them
    // keeps the set visible; silently skipping is how an uncosted leg reaches production.
    expect(
      [...new Set(unmatched)].sort(),
      'a leg with no active price point must be named in UNMATCHED_LEGS, not skipped',
    ).toEqual([...UNMATCHED_LEGS].sort());
    expect(checked.length).toBeGreaterThan(20);
    // Rev. 6 exports the units finance priced over. A leg priced across a different
    // number of units than we sell is a hole no margin check can see — both sides stay
    // internally consistent and only the customer's bill is wrong.
    //
    //
    // rev. 14 closed the one defect that was open here. rev. 13 wrote `Количество` from
    // «Сек в клипе» unconditionally, which is the billing quantity for a per-second model
    // and the CLIP DURATION for a per-clip one — so fifteen veo rows read 8 while the
    // cost column on those same rows still costed one clip. Finance now derives the field
    // from the billing basis and refuses to emit a per-clip or per-image row with a
    // quantity other than 1, so the class cannot recur, not just this instance.
    expect(quantityGaps, 'finance priced these legs over a different unit count').toEqual([]);
    expect(basisGaps, 'we and finance disagree about what a unit IS').toEqual([]);
    // Where our price and finance's price AGREE, recomputing the margin from vendor
    // rate × landed FX × our units must reproduce the stated margin almost exactly.
    // This is the only part of the comparison that tests arithmetic rather than
    // restating a known price difference.
    //
    // The old bound here was `worst < 80` percentage points across ALL legs, agreeing
    // or not, which is not a tolerance — it is the whole range. Every disagreement in
    // the file fitted inside it, so the assertion could not fail. The successor bound,
    // 0.05 pp, was 500x looser than the data: measured worst across every price-agreeing
    // leg is below 0.0001 pp, because both sides are the same deterministic arithmetic
    // over the same inputs. A tolerance that no real drift can reach is not a tolerance.
    expect(worst, `margin recomputation disagrees on ${worstKey}, where prices MATCH`).toBeLessThan(
      0.0001,
    );
    // `deltaPp` is an ABSOLUTE difference, so it cannot see direction: a leg finance
    // signs as profitable that we recompute as loss-making reads exactly like the
    // harmless opposite. This is the one comparison where the sign is the whole point
    // (I-2: loss is cost > revenue, and exactly zero is allowed), so it runs across
    // EVERY reconciled leg, not only the price-agreeing ones.
    expect(signFlips, 'we and finance disagree about whether these legs make money').toEqual([]);
    // Empty since rev. 13, and that is the mirror CLOSING rather than the check going
    // quiet. rev. 12 mirrored seedance r2v 1080p at a hand-typed 776 against our 775;
    // rev. 13 expresses the parity as a formula (`=O{t2v}`) so the two cannot drift apart
    // by transcription again. Anything appearing here now is a NEW price disagreement.
    expect(report, 'our price and the signed export must agree on every leg').toEqual([]);
    // eslint-disable-next-line no-console
    if (process.env['RECONCILE_REPORT']) console.log(JSON.stringify(report, null, 1));
  });

  /**
   * The sign check above is green on today's file, so on its own it proves nothing.
   * This is the mutation that makes it bite, and it is the failure it exists for: a
   * vendor reprices upward, our recomputation goes under water, and the signed export
   * still carries the old positive margin because nobody re-signed it. The mutation is
   * applied to the leg's vendor rate — the one input that changes without us — and
   * nothing else.
   */
  it('the sign check bites — a repriced leg driven under water is caught, not averaged away', () => {
    const floor = creditFloorRub(seedSubscriptionTiers);
    const priced = file.legs.filter((leg) => leg.margin > 0 && ourPointFor(leg));
    const thin = priced.reduce((a, b) => (b.margin < a.margin ? b : a));
    const ours = ourPointFor(thin)!;
    // The thinnest leg we actually sell. Naming the value rather than the row keeps
    // this honest if finance re-signs the file and a different row becomes thinnest.
    expect(thin.margin).toBeLessThan(0.05);

    // Enough of a vendor increase to cross zero, and no more: at margin m, cost has to
    // grow by a factor above 1/(1-m) before revenue stops covering it.
    const repriced = { ...thin, usdPerUnit: (thin.usdPerUnit / (1 - thin.margin)) * 1.05 };
    const under = reconcileLeg(
      repriced,
      {
        credits: ours.baseCredits,
        unitKind: ours.flatRate ? 'clip' : ours.unitKind,
        baseUnits: ours.baseUnits,
      },
      floor,
    );
    expect(under.statedMargin).toBeGreaterThan(0);
    expect(under.recomputedMargin).toBeLessThan(0);
    expect(under.recomputedMargin < 0 !== under.statedMargin < 0).toBe(true);
    // And the absolute delta on its own would have read as a rounding error: the whole
    // move is small precisely because the leg was thin to begin with.
    expect(under.deltaPp).toBeLessThan(10);
  });
});

/**
 * A row billed per CLIP or per IMAGE is priced for exactly one of them.
 *
 * rev. 13 shipped fifteen Veo rows carrying `Количество = 8` — the clip's LENGTH in a
 * column that means "units this price covers" — on rows whose billing basis is «за клип».
 * A flat clip price divided over eight units undercharges by eight, and the export's own
 * margin column had been computed the correct way, so nothing in the arithmetic
 * disagreed with itself. rev. 14 fixed it at the root and finance's generator now
 * refuses such a row.
 *
 * This replaces the fifteen-row oracle that fix removed. A list of the rows that WERE
 * wrong stops being coverage the moment they are corrected; the rule that made them
 * wrong keeps catching the sixteenth. Only «за секунду» prices a quantity, because only
 * there does the number mean output the customer receives.
 */
describe('quantity is a billing base, not a clip length', () => {
  it('prices every per-clip and per-image row over exactly one unit', () => {
    const offenders = file.legs
      .filter((leg) => leg.basis !== 'за секунду' && leg.quantity !== 1)
      .map((leg) => `${leg.rowKey} — ${leg.basis} × ${leg.quantity}`);
    expect(offenders).toEqual([]);
  });

  it('still lets a per-second row price a real duration', () => {
    const perSecond = file.legs.filter((leg) => leg.basis === 'за секунду');
    expect(perSecond.length).toBeGreaterThan(0);
    expect(perSecond.some((leg) => leg.quantity > 1)).toBe(true);
  });
});
