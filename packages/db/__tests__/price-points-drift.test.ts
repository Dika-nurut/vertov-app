import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import {
  buildPricePointRows,
  PRICE_POINT_SEED,
  type PricePointSeedRow,
} from '../seed/price-points';
import ladder from '../seed/pricing-ladder-v3.json';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface CostEntry {
  creditsBaseConfig: number;
  creditsRef: string;
  matrix?: { modelId: string; resolution: string };
}

/**
 * The frozen v14 ladder remains an audit record for seed rows whose values did
 * not change. Rev. 9 is now the price authority and is checked exhaustively in
 * `rev6-projection.test.ts`; this file keeps the surviving v14 citations honest
 * and guards activation/cardinality invariants around the combined matrix.
 */

/**
 * Rows this guard governs: the ones the frozen v14 ladder can possibly contain.
 *
 * Two kinds of prefix are outside it, and the distinction matters:
 *   - `derived:`  — rows we computed, never in any workbook.
 *   - `revN:`     — rungs added, or values changed, after the v14 freeze. Every
 *                   one of them is governed by the full export projection test
 *                   instead, against the signed export itself.
 *
 * The revision list is matched by SHAPE rather than enumerated. It was a literal
 * list through rev. 9, and the day rev. 10 arrived every new row was silently
 * treated as a surviving v14 citation and failed for having no ladder entry —
 * a guard failing on the correct data because its allowlist had not been told
 * there was a new revision.
 */
const REVISION_PREFIX = /^rev\d+(?:-зеркало)?:/;
const isV14LadderRow = (r: { sourceRef: string }): boolean =>
  !r.sourceRef.startsWith('derived:') && !REVISION_PREFIX.test(r.sourceRef);

const isWorkbookOrExportRow = (r: { sourceRef: string }): boolean =>
  !r.sourceRef.startsWith('derived:');

/** A price row re-signed after the v14 freeze — the `rev<N>:` half of the above. */
const REVISED_SINCE_THE_FREEZE = /^rev\d+(?:-зеркало)?:/;

/**
 * The workbook cell a citation points at, as `sheet␟row`, for the two shapes in
 * play: a frozen ladder cell (`Сетка FX!AA10`) and a signed-export row
 * (`rev9:Сетка FX стр.10` or `rev12:Сетка FX!AA16/AB16`). `null` for anything that is neither — which is the
 * fail-closed direction, since a citation this cannot parse must not be treated
 * as agreeing with another one.
 */
const citedCell = (ref: string): string | null => {
  const normalized = ref.replace(/^rev\d+(?:-зеркало)?:/, '');
  const frozen = /^(.+?)![A-Z]+(\d+)(?:\/[A-Z]+\d+)?$/.exec(normalized);
  if (frozen) return `${frozen[1]}␟${frozen[2]}`;
  const revised = /^(.+?)\s+стр\.(\d+)$/.exec(normalized);
  if (revised) return `${revised[1]}␟${revised[2]}`;
  return null;
};

// Ladder JSON carries no `audio` field — every SSOT row is audio:false (ruling 4,
// SSOT doc "Rulings applied" §4: "audio is not a price dimension"). Folding it
// into the key keeps the key shape aligned with the DB's real uniqueness
// constraint (model_price_points: modelId × resolution × videoInput × audio)
// without needing to thread a constant through the JSON.
const configKey = (modelId: string, resolution: string, videoInput: boolean, audio: boolean) =>
  `${modelId}␟${resolution}␟${videoInput}␟${audio}`;

const ladderByRef = new Map(ladder.ladder.map((e) => [e.ref, e]));
const ladderByConfig = new Map(
  ladder.ladder.map((e) => [configKey(e.model, e.resolution, e.videoInput, false), e]),
);

describe('parametric price seed vs frozen workbook ladder', () => {
  it('drops the retired-workbook _pruned audit block rather than carry stale numbers', () => {
    // data-audit finding B2: the retired file's `_pruned` cells no longer match
    // the book they claimed to preserve. v14's 55-row SSOT doesn't carry those
    // cells at all (re-deriving them would mean reading the retired-basis
    // workbook directly, which goal invariant 1 forbids) — see `_prunedNote`.
    expect((ladder as Record<string, unknown>)['_pruned']).toBeUndefined();
    expect(ladder._prunedNote).toBeTruthy();
  });

  it('keeps every surviving v14 citation aligned by full price configuration', () => {
    for (const r of PRICE_POINT_SEED) {
      if (!isV14LadderRow(r)) continue;
      const key = configKey(r.modelId, r.resolution, r.videoInput, r.audio);
      expect(
        ladderByConfig.has(key),
        `seed row at config ${key} (${r.sourceRef}) has no ladder entry`,
      ).toBe(true);
      const cell = ladderByConfig.get(key)!;
      expect(cell.ref, `ref drift at config ${key}`).toBe(r.sourceRef);
      expect(cell.credits, `credit drift at config ${key}`).toBe(r.baseCredits);
      expect(cell.baseUnits, `baseUnits drift at config ${key}`).toBe(r.baseUnits);
    }
  });

  it('labels every non-v14 row with a known, independently guarded provenance', () => {
    for (const r of PRICE_POINT_SEED) {
      if (isV14LadderRow(r)) {
        expect(ladderByRef.has(r.sourceRef), `seed row cites unknown cell ${r.sourceRef}`).toBe(
          true,
        );
        continue;
      }
      expect(
        r.sourceRef.startsWith('derived:') || REVISION_PREFIX.test(r.sourceRef),
        `seed row has unknown provenance ${r.sourceRef}`,
      ).toBe(true);
    }
  });

  it("seeds only resolutions at or below each model's deliverable ceiling, for rows reachable today", () => {
    // Inactive rows are exempt: the v14 SSOT deliberately seeds two configs that
    // exceed their model's CURRENT declared ceiling — seedance-2-0 4K (owner
    // ruling 3, blocked on the kie 4K probe) and its with-video 4K leg
    // (Параметрика!C40) — inactive precisely BECAUSE they are not deliverable
    // today, same as the retired file's `_pruned` cells were undeliverable. The
    // retired file kept those out of the seed entirely (pruned); v14 keeps them
    // IN the seed but inactive (goal invariant 2), so this guard must only bind
    // rows that could actually be activated and served.
    const maxByModel = new Map(seedModels.map((m) => [m.id, m.maxResolution]));
    const resolutionRank = (value: string): number | null => {
      const p = /^(\d+)p$/i.exec(value);
      if (p) return Number(p[1]);
      const k = /^(\d+)K$/i.exec(value);
      if (k) return Number(k[1]) * 1024;
      const square = /^(\d+)x(\d+)$/i.exec(value);
      if (square) return Math.max(Number(square[1]), Number(square[2]));
      return null; // quality labels (low/medium/high/default) have no pixel rank.
    };

    for (const point of PRICE_POINT_SEED.filter((r) => r.isActive)) {
      const max = maxByModel.get(point.modelId);
      expect(max, `price point references unknown model ${point.modelId}`).toBeTruthy();
      const pointRank = resolutionRank(point.resolution);
      const maxRank = max ? resolutionRank(max) : null;
      if (pointRank != null && maxRank != null) {
        expect(
          pointRank,
          `${point.modelId} ${point.resolution} exceeds deliverable maxResolution ${max}`,
        ).toBeLessThanOrEqual(maxRank);
      }
    }
  });

  /**
   * Coordinator finding (terra adversarial pass, 2026-07-28): asserting a bare
   * count of inactive rows lets a future edit swap WHICH config is inactive
   * (e.g. accidentally activate a with-video leg while deactivating something
   * else) and stay green, as long as the total is unchanged. Naming each one by
   * key + reason means flipping ANY of them requires deleting or editing its
   * specific named assertion below — the count is now a derived consequence of
   * the list, not the guard itself.
   */
  const INACTIVE_SSOT_CONFIGS: ReadonlyArray<{
    modelId: string;
    resolution: string;
    videoInput: boolean;
    reason: string;
  }> = [
    {
      modelId: 'flux-2-pro',
      resolution: '1K',
      videoInput: false,
      reason:
        'owner ruling 2026-08-26 — the 2–8-reference premium expired after Kie began serving that band; only the plain 1K row remains active at 11 credits',
    },
    {
      modelId: 'seedream-4-5',
      resolution: '1K',
      videoInput: false,
      reason:
        'Kie Seedream 4.5 exposes only basic (2K) and high (4K); the workbook rung stays parked for drift mapping',
    },
    {
      modelId: 'seedance-2-0',
      resolution: '4K',
      videoInput: false,
      reason:
        'owner ruling 3 — blocked on the kie 4K probe; also unreachable today (declared resolutions stop at 1080p)',
    },
    {
      modelId: 'seedance-2-0-reference-to-video',
      resolution: '4K',
      videoInput: true,
      reason:
        'with-video leg (Параметрика 38-45) — no trusted media-duration source exists anywhere in packages/db/schema/* (goal §8 follow-up: "trusted input duration")',
    },
    {
      modelId: 'seedance-2-0-reference-to-video',
      resolution: '1080p',
      videoInput: true,
      reason: 'with-video leg — same as above',
    },
    {
      modelId: 'seedance-2-0-reference-to-video',
      resolution: '720p',
      videoInput: true,
      reason: 'with-video leg — same as above',
    },
    {
      modelId: 'seedance-2-0-reference-to-video',
      resolution: '480p',
      videoInput: true,
      reason: 'with-video leg — same as above',
    },
    {
      modelId: 'seedance-2-0-fast-reference-to-video',
      resolution: '720p',
      videoInput: true,
      reason: 'with-video leg — same as above',
    },
    {
      modelId: 'seedance-2-0-fast-reference-to-video',
      resolution: '480p',
      videoInput: true,
      reason: 'with-video leg — same as above',
    },
    // Kling 1080p and 4K are GONE, not merely inactive. Rev. 11 withdrew them:
    // the catalogue declares `resolutions: ['720p']`, so those rows priced rungs
    // that were never on sale, from a Kie leg that does not exist either.

    {
      modelId: 'veo-3-1',
      resolution: '4K',
      videoInput: false,
      reason: 'Kie 4K requires the /veo/get-4k-video two-step, which is not wired',
    },
    {
      modelId: 'veo-3-1-fast',
      resolution: '4K',
      videoInput: false,
      reason: 'Kie 4K requires the /veo/get-4k-video two-step, which is not wired',
    },
    {
      modelId: 'veo-3-1-lite',
      resolution: '4K',
      videoInput: false,
      reason: 'Kie 4K requires the /veo/get-4k-video two-step, which is not wired',
    },
    {
      modelId: 'happyhorse-1-0',
      resolution: '720p',
      videoInput: false,
      reason:
        'delisted 2026-08-03 per workbook v14 03_08: HappyHorse 1.0 is dearer than 1.1 at the same result',
    },
    {
      modelId: 'happyhorse-1-0',
      resolution: '1080p',
      videoInput: false,
      reason: 'delisted 2026-08-03 — same as above',
    },
  ];

  it('enumerates all inactive export/workbook configs by name and reason', () => {
    const nonDerived = PRICE_POINT_SEED.filter(isWorkbookOrExportRow);

    // The guard keys on the full six-column price identity. The retired Flux entry
    // names its reference band explicitly; all other entries are plain selectors.
    for (const { modelId, resolution, videoInput, reason } of INACTIVE_SSOT_CONFIGS) {
      const row = nonDerived.find(
        (r) =>
          r.modelId === modelId &&
          r.resolution === resolution &&
          r.videoInput === videoInput &&
          (modelId === 'flux-2-pro' ? (r.refsMin ?? 0) > 0 : (r.refsMin ?? 0) === 0),
      );
      expect(
        row,
        `${modelId} ${resolution} videoInput=${videoInput} (${reason}) — no such row`,
      ).toBeTruthy();
      expect(
        row!.isActive,
        `${modelId} ${resolution} videoInput=${videoInput} should be INACTIVE: ${reason}`,
      ).toBe(false);
    }

    // The reverse direction: nothing ELSE is silently inactive without a named
    // reason above (a config going inactive unnoticed is exactly the failure
    // mode invariant 2 exists to catch).
    const named = new Set(
      INACTIVE_SSOT_CONFIGS.map((c) => `${c.modelId}␟${c.resolution}␟${c.videoInput}`),
    );
    for (const r of nonDerived.filter((r) => !r.isActive)) {
      const key = `${r.modelId}␟${r.resolution}␟${r.videoInput}`;
      expect(
        named.has(key),
        `${key} is inactive but not enumerated above — name it, with a reason`,
      ).toBe(true);
    }
  });

  it('carries the real 56-active/11-inactive split of the 67 export/workbook rows', () => {
    const ssotRows = buildPricePointRows().filter(isWorkbookOrExportRow);
    // 59 after rev. 11: Kling lost 1080p and 4K (rungs never on sale) and gained a
    // quiet-audio 720p row, so the workbook/export set is one smaller and one more
    // of it is active.
    //
    // 64 once the key carries a mode and a band: the five configurations rev. 10
    // signed above the row we used to charge — Wan 720p/1080p i2v, Flux's 2–8
    // reference band, and both Seedream Pro 2–10 bands. All five are ACTIVE; none
    // replaces a row, because each prices a request shape the old key could not
    // distinguish from the cheaper one.
    // Rev. 19 adds the distinct 2K i2i and 2–8 reference configurations, both active
    // at Kie's signed 15-credit image price; neither replaces the plain 2K row.
    expect(ssotRows.length).toBe(67);
    // The retired Flux reference band became the sixteenth named inactive row on
    // 2026-08-26; its historical workbook/export row is retained for audit.
    expect(ssotRows.filter((r) => r.isActive).length).toBe(53);
    expect(ssotRows.filter((r) => !r.isActive).length).toBe(INACTIVE_SSOT_CONFIGS.length);
    expect(
      PRICE_POINT_SEED.find((r) => r.modelId === 'grok-imagine-video' && r.resolution === '720p')
        ?.baseCredits,
    ).toBe(69);
  });

  it('prices a cheaper resolution never above a dearer one for the same model', () => {
    // The whole point of parametric pricing: a higher rung must not cost fewer
    // credits at the same duration. Rev. 9 restores the strict 145 < 323 < 776
    // Seedance ladder that the frozen v14 seed had flattened at 480p/720p.
    const p480 = PRICE_POINT_SEED.find(
      (r) => r.modelId === 'seedance-2-0' && r.resolution === '480p',
    )!;
    const p720 = PRICE_POINT_SEED.find(
      (r) => r.modelId === 'seedance-2-0' && r.resolution === '720p',
    )!;
    const p1080 = PRICE_POINT_SEED.find(
      (r) => r.modelId === 'seedance-2-0' && r.resolution === '1080p',
    )!;
    expect(p480.baseUnits).toBe(p720.baseUnits);
    expect(p720.baseUnits).toBe(p1080.baseUnits);
    expect(p480.baseCredits).toBeLessThanOrEqual(p720.baseCredits);
    expect(p720.baseCredits).toBeLessThan(p1080.baseCredits);
  });

  it('keeps the 5-tier credit grid the reseed will write', () => {
    // Locks the tier grid alongside the ladder so a tier-credit edit is a
    // deliberate, reviewed change (not a stray number). Untouched by the v14
    // price-catalogue regeneration (out of this goal's scope).
    expect(ladder.tiers).toEqual([
      { name: 'Start', priceRub: 599, credits: 1175 },
      { name: 'Pro', priceRub: 1649, credits: 4400 },
      { name: 'Studio', priceRub: 3799, credits: 10300 },
      { name: 'Elite', priceRub: 5799, credits: 15900 },
      { name: 'Ultra', priceRub: 11699, credits: 32500 },
    ]);
  });

  /**
   * The COST side must agree with the PRICE side about the same workbook cell.
   *
   * `costModel` entries carry `creditsBaseConfig` — the credit price of the rung
   * they are costing — and cite the cell it came from. `PRICE_POINT_SEED` carries
   * `baseCredits` for the same rung and cites the same cell. Nothing asserted that
   * the two agreed, and twice they did not:
   *
   *   - `gemini-3-pro-image` cited `Сетка FX!AA35` (4K = 50) while carrying 37,
   *     the 1K figure from AA34. That single wrong number is the entire reason
   *     Ruling 9 carried a `gemini-3-pro-image → kie` exception at 1.4% — it
   *     scored kie's 4K rate against the 1K price. Fixed 2026-08-02, exception
   *     deleted with it.
   *   - `gemini-3-1-flash-image` cited `Сетка FX!AA32` while carrying 28 against
   *     the price row's 23. Fixed in the same change.
   *
   * A wrong-but-plausible `creditsBaseConfig` does not fail any other test: it
   * silently moves every margin the guard computes for that model, in either
   * direction. This is the guard for that whole class.
   */
  it('costs each rung at the credit price the price table charges for it', () => {
    // The frozen ladder has ONE cell per rung and no audio axis, while a model with
    // a user audio lever now has TWO price rows for that rung (Kling: 270 with
    // sound, 180 without). The cell prices the audio-ON configuration — that is the
    // rate the adapter runs by default — so compare against that row. Keyed by
    // last-write-wins the map picked whichever row happened to come second, which
    // made this guard report a disagreement that is really two configurations.
    const priced = new Map<string, PricePointSeedRow>();
    for (const r of PRICE_POINT_SEED.filter((r) => r.isActive)) {
      const key = `${r.modelId}\u0000${r.resolution}`;
      const existing = priced.get(key);
      if (!existing || (r.audio && !existing.audio)) priced.set(key, r);
    }

    const compared: string[] = [];
    const mismatched: string[] = [];
    const exempt: string[] = [];

    for (const entry of (ladder.costModel as CostEntry[]).filter((e) => e.matrix)) {
      const row = priced.get(`${entry.matrix!.modelId}\u0000${entry.matrix!.resolution}`);
      if (!row) continue;
      const rung = `${entry.matrix!.modelId} @ ${entry.matrix!.resolution}`;
      const detail =
        `${rung}: cost says ${entry.creditsBaseConfig} (${entry.creditsRef}), ` +
        `price says ${row.baseCredits} (${row.sourceRef})`;

      // The same exemption `isV14LadderRow` draws at the top of this file, applied
      // to the cost side: `creditsBaseConfig` is frozen at v14, so it CANNOT carry a
      // price that post-dates the freeze. A `rev<N>:` price row is exactly such a
      // price, and it is already guarded exhaustively against the signed export in
      // `rev6-projection.test.ts` — comparing it to the frozen cell would only
      // assert that the freeze failed to predict the future.
      //
      // The exemption is deliberately two-part, so it cannot swallow anything else:
      // the price row must carry an explicit `rev<N>:` or `rev<N>-зеркало:` prefix AND both citations must
      // still name the same workbook cell. A row with no prefix can therefore never
      // reach it (it fails the first half), and a rev row that quietly re-pointed at
      // a different line of the workbook cannot either (it fails the second) — that
      // re-pointing is the `gemini-3-pro-image` failure described above, which has to
      // stay catchable.
      const costCell = citedCell(entry.creditsRef);
      if (
        REVISED_SINCE_THE_FREEZE.test(row.sourceRef) &&
        costCell !== null &&
        costCell === citedCell(row.sourceRef)
      ) {
        exempt.push(detail);
        continue;
      }

      compared.push(rung);
      if (row.baseCredits !== entry.creditsBaseConfig) mismatched.push(detail);
    }

    expect(mismatched, `cost/price disagree on the same rung:\n${mismatched.join('\n')}`).toEqual(
      [],
    );

    // The exemption must never be able to empty this guard. Eleven of the 24 matrix
    // rungs remain frozen at v14 and really compare; 13 were re-signed after the
    // freeze. Lower this only together with the revision that moved the rows, and
    // name that revision — a silent drop means the guard stopped binding and nobody
    // noticed.
    expect(
      compared.length,
      `only ${compared.length} rungs still compare against the frozen ladder ` +
        `(${exempt.length} exempted as post-freeze):\n${exempt.join('\n')}`,
    ).toBe(10);
  });
});

describe('a reference band must cover everything the model accepts', () => {
  it('every banded row reaches its model’s advertised maxRefs', () => {
    // Above its ceiling a band stops matching and the unbounded plain row wins by
    // fallback — so a band that stops short of `maxRefs` sells the model's dearest
    // request at its cheapest price, silently. The kernel cannot defend this (an
    // unbounded row matching everything is what unbounded MEANS); the invariant has
    // to live with the data, which is here.
    const banded = PRICE_POINT_SEED.filter((row) => row.isActive && row.refsMin > 0);
    expect(banded.length, 'the seed must carry the reference bands').toBeGreaterThan(0);

    for (const row of banded) {
      const model = seedModels.find((candidate) => candidate.id === row.modelId);
      expect(model, `${row.modelId} left the seed roster`).toBeDefined();
      const maxRefs = (model?.capabilities as { maxRefs?: number } | undefined)?.maxRefs;
      expect(
        typeof maxRefs,
        `${row.modelId} prices a reference band but advertises no maxRefs`,
      ).toBe('number');
      expect(
        row.refsMax,
        `${row.modelId} ${row.resolution}: the band stops at ${row.refsMax} but the model accepts ${maxRefs} — everything above falls back to the cheaper plain row`,
      ).toBe(maxRefs);
    }
  });
});

/**
 * `docs/platform/model-catalog.md` is declared THE single source of truth for
 * models/gateways/pricing (CLAUDE.md), and its «ACTIVE токены» column is the only place a
 * human reads what we charge. Nothing checked it against the seed, so it silently drifted.
 *
 * Measured 2026-08-09: **twelve model rows** were stale, all from one commit (`05868e44`,
 * rev9 «every price aligned to the signed export») that moved the code and left the doc.
 * The drift was not cosmetic — Veo had moved to flat-rate and the table still quoted a
 * per-8s ladder; `gemini-3-1-flash-image` read 23/27/32 against a live 17/23/28; Seedream
 * Pro 2K read 29 against a live 31, which is the very «29 or 31?» the build plan was still
 * carrying as an open question FOR FINANCE. A stale SSOT does not just misinform — it
 * manufactures questions for other people about numbers we already decided.
 *
 * The doc is now correct. This is the guard that keeps it so: every ACTIVE price must be
 * findable in its model's token cell. Deliberately a SUBSTRING check, not a format match —
 * the column is prose (bands, «flat per clip», per-5s anchors, provenance notes) and
 * pinning its shape would fail on every legitimate edit. It answers one question only:
 * can a reader find this number there at all.
 */
describe('the catalogue quotes every price we actually charge', () => {
  const CATALOGUE = readFileSync(
    join(__dirname, '../../../docs/platform/model-catalog.md'),
    'utf8',
  ).split('\n');

  /** The «ACTIVE токены» cell of the table row naming this model, or null if unlisted. */
  function tokenCell(modelId: string): string | null {
    const row = CATALOGUE.find((line) => line.trimStart().startsWith(`| ${modelId} `));
    return row ? (row.split('|').map((cell) => cell.trim())[5] ?? null) : null;
  }

  const active = PRICE_POINT_SEED.filter((row) => row.isActive);

  it('covers a real population, so an empty sweep cannot pass as compliance', () => {
    const listed = new Set(active.map((row) => row.modelId).filter((id) => tokenCell(id)));
    expect(listed.size).toBeGreaterThan(10);
  });

  it('no active price is missing from its catalogue row', () => {
    const missing: string[] = [];
    for (const row of active) {
      const cell = tokenCell(row.modelId);
      // A model absent from the table is a different gap (documentation coverage) and is
      // not this guard's to report — it would fire on every unlisted internal row.
      if (cell === null) continue;
      if (!cell.includes(String(row.baseCredits))) {
        const band = row.refsMin ? ` refs${row.refsMin}-${row.refsMax}` : '';
        missing.push(
          `${row.modelId} ${row.resolution}${band} = ${row.baseCredits} not in "${cell}"`,
        );
      }
    }
    expect(missing).toEqual([]);
  });
});
