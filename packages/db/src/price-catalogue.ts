/**
 * The price catalogue, DERIVED — never transcribed.
 *
 * A price used to exist in three places: finance's workbook, a hand-typed table in
 * `seed/price-points.ts`, and hand-written INSERT statements in a migration. Keeping
 * three copies agreeing was most of the work and all of the risk: the copies drifted,
 * a frozen-snapshot guard was added to catch the drift, and then the guard itself had
 * to be maintained. None of that produced a correct price — it produced agreement
 * between transcriptions.
 *
 * So there is one source: `seed/cost-legs.csv`, exported from the workbook, parsed by
 * `cost-legs.ts`. This module turns its LEGS (how we buy) into CONFIGURATIONS (what we
 * sell), and everything downstream derives from the result. Adding a rung is a
 * re-export from finance, not a code change.
 *
 * What stays in code is the part finance cannot know: whether we can actually SERVE a
 * configuration. That is a routing fact, it lives next to the adapters, and it is why
 * `isSellable` is computed rather than stored.
 */

import type { CostLeg, CostLegFile, Mode, UnitKind } from './cost-legs';
import { configKey, executableIdentity, UNIT_KIND_BY_BASIS } from './cost-legs';
import type { Basis } from './cost-legs';

export type { UnitKind };

/** Mode suffixes our catalogue carries as separate model ids. Rule, not table:
 *  `seedance-2-0-reference-to-video` IS `seedance-2-0` in mode `r2v`. Finance keys on
 *  (model, mode); we split some of those pairs into their own rows for the picker. */
const MODE_SUFFIX: ReadonlyArray<{ suffix: string; mode: Mode }> = [
  { suffix: '-reference-to-video', mode: 'r2v' },
  { suffix: '-video-edit', mode: 'video-edit' },
  { suffix: '-image-to-video', mode: 'i2v' },
];

/** Split one of our catalogue model ids into the (model, mode) finance prices on. */
export function splitModelId(catalogueModelId: string): { modelId: string; mode: Mode | null } {
  for (const { suffix, mode } of MODE_SUFFIX) {
    if (catalogueModelId.endsWith(suffix)) {
      return { modelId: catalogueModelId.slice(0, -suffix.length), mode };
    }
  }
  return { modelId: catalogueModelId, mode: null };
}

/** One thing we sell at one price, with every leg that can serve it. */
export interface CatalogueEntry {
  /** Finance's model id, which is also our BASE model id. */
  modelId: string;
  /** The resolution/size step, or `default` where the model has no such axis. */
  rung: string;
  mode: Mode;
  /** `null` where the model has no audio axis at all (every image row). */
  audio: boolean | null;
  /** The vendor's own quality tier, where it is priced separately from the rung. */
  quality: string | null;
  /** Frame aspect the price covers. `any` everywhere today, by owner ruling. */
  aspect: string;
  credits: number;
  /** Units the price covers, in `unitKind`: 5 seconds, 1 clip, 1 image. */
  baseUnits: number;
  basis: Basis;
  unitKind: UnitKind;
  /** Primary leg first, then reserves in file order. Never empty. */
  legs: readonly CostLeg[];
  /**
   * Findings the owner has looked at and accepted, kept VISIBLE. An acknowledgement
   * must never delete the finding it excuses — that was the first version of this and
   * it made the accepted risk vanish from the catalogue entirely, so nobody could see
   * what they were carrying. Each entry is the finding plus the reason it is tolerated.
   */
  acknowledged: readonly string[];
  /**
   * Why this configuration is NOT sellable, in plain words. Empty means sellable.
   *
   * This exists instead of a hand-set `isActive` boolean. A rung used to be off
   * because someone typed `false` next to it; now it is off because something
   * concrete is wrong, and it comes back on by itself the day that thing is fixed.
   * A blocker is never a reason to drop the row: an unpriced configuration and an
   * unsellable one look identical from the outside, and only one of them is safe.
   */
  blockers: readonly string[];
}

/** Sellable = priced, coherent, and nothing concrete standing in the way. */
export function isSellable(e: CatalogueEntry): boolean {
  return e.blockers.length === 0;
}

/**
 * Blockers the owner has looked at and accepted, with the reason and the date.
 *
 * A blocker is a finding, not a veto — the engine reports what is wrong and the owner
 * decides whether it is worth stopping for. Recording the override here rather than
 * deleting the check keeps the finding visible: the day the reason expires, the row is
 * still flagged and nobody has to remember why it was fine.
 *
 * `expiresOn` is not decoration either. Until 2026-08-09 this was a bare
 * `Map<string, string>` and "expires when rev. 13 lands" lived only in prose — which is
 * to say it never expired, and an acknowledgement written against one month's evidence
 * would go on silently clearing a money gate forever. Same shape as
 * `ExpiringMarginException` in `margin-floors.ts`: an override with no end date is an
 * override nobody will revisit.
 */
export interface AcknowledgedBlocker {
  expiresOn: string;
  reason: string;
  /**
   * The `rung|mode` configurations this acknowledgement was written against, or omitted
   * to cover the whole model.
   *
   * An acknowledgement keyed on the model id alone silently adopts every configuration
   * added afterwards: a new Omni rung whose leg is РИСК for an entirely different reason
   * would arrive pre-accepted, having never been read by anyone. Naming the covered
   * configurations makes the next one surface as the blocker it is.
   */
  covers?: readonly string[];
}

const ACKNOWLEDGED: ReadonlyMap<string, AcknowledgedBlocker> = new Map([
  [
    'grok-imagine-video: every leg is ГИПОТЕЗА',
    {
      // The ruling ties this to "the end of the engine work"; dated out to the end of the
      // quarter so it surfaces rather than lapsing the moment a phase slips.
      expiresOn: '2026-09-30',
      // Only the i2v rungs are ГИПОТЕЗА; the t2v pair moved to HIGH on the kie price list
      // of 2026-08-04. Naming them keeps the acknowledgement from adopting a rung that
      // arrives unverified later for a different reason.
      covers: ['720p|i2v', '480p|i2v'],
      reason:
        'Owner ruling 2026-08-04: Grok stays in the product list; the paid verification ' +
        'call runs at the end of the engine work. R-10 already holds these two rungs at a ' +
        '40% floor rather than 25% precisely because the rate is unverified, which absorbs ' +
        'a vendor increase of up to +67%.',
    },
  ],
]);

/**
 * Acknowledgements are dated, so reading them needs a clock. `buildCatalogue` takes an
 * optional `now` rather than reaching for `Date.now()` inline so tests can stand at either
 * side of an expiry — the same contract `activeMarginExceptions` uses.
 */
function activeAcknowledgement(key: string, now: Date, config: string): string | undefined {
  const ack = ACKNOWLEDGED.get(key);
  if (!ack) return undefined;
  if (ack.covers && !ack.covers.includes(config)) return undefined;
  const expires = Date.parse(`${ack.expiresOn}T00:00:00Z`);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return undefined;
  return ack.reason;
}

export class CatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueError';
  }
}

/**
 * Fold legs into configurations, refusing anything ambiguous.
 *
 * Every check below is a real defect class, not a formality:
 *
 *  - **Legs disagreeing on credits** would mean the price depends on who served the
 *    job. The owner's standing rule is that it must not, and a customer who was
 *    failed over must never see a different number.
 *  - **Legs disagreeing on quantity or basis** is the same hole one level down: same
 *    price, different amount of product. No margin check can see it, because both
 *    sides stay internally consistent.
 *  - **No primary leg** means we would fail over to a reserve as the normal path.
 *  - **A duplicate configuration** means two prices for one thing, and whichever the
 *    resolver happened to reach first would win.
 */
export function buildCatalogue(file: CostLegFile, now: Date = new Date()): CatalogueEntry[] {
  const byConfig = new Map<string, CostLeg[]>();
  for (const leg of file.legs) {
    const k = configKey(leg);
    byConfig.set(k, [...(byConfig.get(k) ?? []), leg]);
  }

  const entries: CatalogueEntry[] = [];
  for (const [key, legs] of byConfig) {
    const sorted = [...legs].sort((a, b) => a.leg - b.leg);
    const [primary, ...rest] = sorted;
    if (!primary) throw new CatalogueError(`${key}: no legs`);
    if (primary.leg !== 1) throw new CatalogueError(`${key}: no primary leg (leg 1)`);

    for (const other of rest) {
      if (other.credits !== primary.credits) {
        throw new CatalogueError(
          `${key}: legs disagree on price (${primary.credits} vs ${other.credits}) — ` +
            'the price a customer sees must not depend on who served the job',
        );
      }
      if (other.quantity !== primary.quantity) {
        throw new CatalogueError(
          `${key}: legs disagree on quantity (${primary.quantity} vs ${other.quantity})`,
        );
      }
      if (other.basis !== primary.basis) {
        throw new CatalogueError(
          `${key}: legs disagree on billing basis (${primary.basis} vs ${other.basis})`,
        );
      }
    }

    // Two legs that resolve to the same call are one route written twice: a failover
    // that re-dials the relay that just failed. This lived only in a test bound to the
    // committed file, so any FUTURE export could ship it.
    const identities = new Set<string>();
    for (const l of sorted) {
      const id = executableIdentity(l);
      if (identities.has(id)) {
        throw new CatalogueError(`${key}: two legs resolve to the same call (${id})`);
      }
      identities.add(id);
    }

    // Blockers, not exceptions. These configurations are coherent — the numbers agree
    // and the key is unambiguous — they simply must not be sold as they stand. Throwing
    // would take the whole catalogue down over one row, which is how a pricing bug
    // becomes an outage.
    const blockers: string[] = [];

    // A hypothesised rate may be ROUTED to; the parser's own doctrine says it must
    // never be the SOLE basis for a price. kie sold Grok 68–76% under xAI's list and
    // then repriced +50% inside two weeks — that is what the confidence column is for.
    const acknowledged: string[] = [];
    const finding = (text: string, ackKey: string): void => {
      const ack = activeAcknowledgement(ackKey, now, `${primary.rung}|${primary.mode}`);
      if (ack) acknowledged.push(`${text} — ACCEPTED: ${ack}`);
      else blockers.push(text);
    };

    if (sorted.every((l) => l.confidence === 'HYPOTHESIS')) {
      finding(
        'every leg is ГИПОТЕЗА — no verified rate stands behind this price',
        `${primary.modelId}: every leg is ГИПОТЕЗА`,
      );
    }

    // РИСК is the rev. 12 escalation of the same defect: not a guessed rate but an
    // unpublished one whose plausible range crosses zero. Importing the flag and then
    // ignoring it here would be worse than never having it — the whole point of the
    // column is that the gate reads it.
    // NOT `every`, unlike the ГИПОТЕЗА check above, and the difference is deliberate.
    // ГИПОТЕЗА is a claim about the EVIDENCE for a price: one verified leg is enough to
    // stand behind it. РИСК is a claim about a SPECIFIC leg's executing rate crossing into
    // loss, and a HIGH reserve does not make the primary's unquotable rate safe — the
    // primary is the leg that runs. Any reachable РИСК leg is therefore reported.
    if (sorted.some((l) => l.confidence === 'RISK')) {
      finding(
        'a leg is РИСК — it bills at a rate nobody can quote, and its range crosses zero',
        `${primary.modelId}: every leg is РИСК`,
      );
    }

    // Ruling R-1 sets the FALLBACK floor at 0%, not 25% — a thin reserve is better
    // than a vendor outage. Below zero is not thin, it is a sale at a loss.
    for (const l of sorted) {
      if (l.margin < 0) {
        blockers.push(`leg ${l.leg} (${l.relay}) earns ${l.margin} — below the 0% floor`);
      }
    }

    // Finance cannot know whether an amount is BILLABLE. `costKnown = нет` means the
    // rate is a placeholder, and a placeholder must not reach a customer's invoice.
    for (const l of sorted) {
      if (!l.costKnown) blockers.push(`leg ${l.leg} (${l.relay}) has no known cost`);
    }

    entries.push({
      modelId: primary.modelId,
      rung: primary.rung,
      mode: primary.mode,
      audio: primary.audio,
      quality: primary.quality,
      aspect: primary.aspect,
      credits: primary.credits,
      baseUnits: primary.quantity,
      basis: primary.basis,
      unitKind: UNIT_KIND_BY_BASIS[primary.basis],
      legs: sorted,
      blockers,
      acknowledged,
    });
  }

  // NOT a duplicate check over `entries`: those come from a Map keyed on exactly these
  // fields, so one entry per key is guaranteed by construction and the check could never
  // fire. It read like a guard and was structurally dead — the test over it restated the
  // Map rather than testing anything. The real risk is upstream: two ROWS that are one
  // configuration under our key but a different configuration under finance's, which is
  // what their pre-joined row key exists to express.
  const rowKeys = new Map<string, string>();
  for (const leg of file.legs) {
    const ours = `${configKey(leg)}|нога${leg.leg}`;
    const theirs = leg.rowKey || ours;
    const seenAs = rowKeys.get(theirs);
    if (seenAs !== undefined && seenAs !== ours) {
      throw new CatalogueError(
        `finance row key ${theirs} maps to two different configurations (${seenAs}, ${ours})`,
      );
    }
    rowKeys.set(theirs, ours);
  }
  return entries;
}

/** The full identity of a sellable configuration — finance's key, verbatim. */
export function entryKey(
  e: Pick<CatalogueEntry, 'modelId' | 'rung' | 'mode' | 'audio' | 'quality' | 'aspect'>,
): string {
  const a = e.audio === null ? '-' : e.audio ? 'да' : 'нет';
  return [e.modelId, e.rung, e.mode, a, e.quality ?? '-', e.aspect].join('|');
}

/**
 * Which catalogue model serves a configuration.
 *
 * The owner's ruling, 2026-08-04: the PICKER keeps reference-to-video and video-edit
 * as their own entries, because /boards derives a node's reference slots from the
 * selected model's capabilities and collapsing them would take that away. The PRICE
 * does not follow — finance keys on (model, mode), and so do we.
 *
 * So one price row serves both faces of the same thing, and this is the only place
 * that knows they are the same thing.
 */
export function servingModelId(
  entry: Pick<CatalogueEntry, 'modelId' | 'mode'>,
  knownModelIds: ReadonlySet<string>,
): string | null {
  const suffixed = MODE_SUFFIX.find((s) => s.mode === entry.mode);
  if (suffixed) {
    // A mode that has its own picker entry REQUIRES that entry. It used to fall back
    // to the base model, which is worse than returning nothing: HappyHorse 1.0's
    // video-edit price (487) would have been attached to the plain model, so an
    // ordinary generation billed at the video-edit rate — and HappyHorse 1.1's r2v
    // price would be charged for a job whose video reference the adapter silently
    // drops. Paying an r2v price for a t2v result is the exact shape of defect the
    // whole derivation exists to make impossible.
    const id = `${entry.modelId}${suffixed.suffix}`;
    return knownModelIds.has(id) ? id : null;
  }
  // Modes with no separate entry — t2v, t2i, refs-2-10 — are a REQUEST SHAPE on the
  // base model: how many references are attached, not which model was chosen.
  return knownModelIds.has(entry.modelId) ? entry.modelId : null;
}

/**
 * Charge for one request against one configuration.
 *
 * `units` is what the customer asked for, in the configuration's own `unitKind` —
 * output seconds, or a count of images. For a `clip` configuration it is IGNORED, and
 * that is the whole point: the vendor charges one price for any duration, so we do
 * too. Prorating there is not a rounding difference, it is selling below cost.
 */
export function chargeFor(entry: CatalogueEntry, units: number): number {
  // Validate BEFORE the clip short-circuit. The early return used to sit above this
  // check, so a NaN or a zero duration on a per-clip configuration returned the full
  // price without complaint — the one basis where a nonsense request looked healthiest.
  if (!Number.isFinite(units) || units <= 0) {
    throw new CatalogueError(`${entryKey(entry)}: units must be positive, got ${units}`);
  }
  if (entry.unitKind === 'clip') return entry.credits;
  return Math.ceil((entry.credits * units) / entry.baseUnits);
}
