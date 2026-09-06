import { createHash } from 'node:crypto';

/**
 * The cost-leg contract — finance's «НОГИ (экспорт)» as the engine reads it.
 *
 * `seed/cost-legs.csv` is exported verbatim from the pricing workbook. CSV because it
 * diffs in a pull request, finance can read the diff without a developer, and there is
 * no step where a human can improve a number in transit.
 *
 * Everything here is STRICT. An unknown column, a missing column, an unparseable
 * number or an unrecognised enum is a hard error, never a skipped row — a skipped row
 * is an uncosted leg, and under ruling R-2 an uncosted configuration comes off sale.
 * Silently dropping one would take a product down and look like nothing happened.
 */

/** Billing basis as the vendor states it. Never silently converted to $/second. */
export type Basis = 'за клип' | 'за секунду' | 'за штуку' | 'за изображение';

/**
 * Generation mode. `t2i` is a quarter of the rows — an enum that omits it parses nothing.
 *
 * The `refs-N-M` values are reference-COUNT bands, not separate modes in the product
 * sense: a vendor that meters input images charges a different rate once the count
 * crosses a threshold, and finance prices each band. `refs-0-1` is the band the plain
 * t2i/i2i row already covers on models that include the first reference free, so the
 * two are not alternatives to choose between — they are the same call at a different
 * input count.
 */
export type Mode =
  | 't2v'
  | 'i2v'
  | 'r2v'
  | 'video-edit'
  | 't2i'
  | 'i2i'
  | 'refs-0-1'
  | 'refs-2-8'
  | 'refs-2-10';

/**
 * How far the cost figure can be trusted. `ГИПОТЕЗА` is not decoration: kie sold Grok
 * at 76–85% under xAI's list, the register flagged it, and kie then repriced 50% inside
 * two weeks. A hypothesised rate may be ROUTED to; it must never be the sole basis for
 * a price.
 *
 * `РИСК` arrived with rev. 12 and is a distinct claim, not a louder `СРЕДНЯЯ`: finance
 * is saying the executing leg's rate is unpublished AND one end of the plausible range
 * is a LOSS (the three gpt-image-2 rungs read «Диапазон $0,03-0,05… при плоских $0,05
 * строка low даёт −16,9%»). It is therefore held to the same short clock as ГИПОТЕЗА
 * and trips the same activation finding — a rate nobody can quote must not silently
 * become the sole basis for a price just because it is not literally a hypothesis.
 *
 * `ЗАМЕРЕНО` arrived with rev. 13 and is the OPPOSITE end of the same axis: not a rate
 * finance read off a vendor page, but one we billed ourselves through the exact route
 * the code runs and then unit-calibrated against a published flat rate. It is stronger
 * evidence than `HIGH`, which only ever meant «the vendor publishes this». The three
 * gpt-image-2 rungs moved `РИСК → ЗАМЕРЕНО` in one round, which is precisely the
 * transition the paid probe existed to produce.
 *
 * It carries NO short clock. A published rate can be silently revised on a vendor's
 * page; a rate we measured is a fact about a call that happened on a date, and it
 * expires when the vendor changes, not on a timer. Re-measure on a rate-change signal,
 * not on a calendar.
 */
export type Confidence = 'HIGH' | 'MEDIUM' | 'HYPOTHESIS' | 'RISK' | 'MEASURED';

/** Finance's explicit `Роль` column, normalized without losing its provenance. */
export type CostLegRole = 'primary' | 'fallback';

/**
 * How a reference band charges within itself. `плоская` is one price for the whole
 * band; `за_каждый_сверх` adds `доплата_$_за_картинку` per image past the first.
 * The distinction is what lets the engine price an arbitrary reference count
 * without parsing a mode name like `refs-2-10`.
 */
export type BandPricing = 'плоская' | 'за_каждый_сверх';
const BAND_PRICINGS: readonly BandPricing[] = ['плоская', 'за_каждый_сверх'];

export interface CostLeg {
  /** Configuration key. Mirrors finance's A+B+C+D+E, which they pre-join in column X. */
  modelId: string;
  rung: string;
  mode: Mode;
  audio: boolean | null;
  quality: string | null;
  /** 1 = primary, 2 = reserve. With the key above this is unique per row. */
  leg: number;
  role: CostLegRole;
  /** Who we bill. A price and a relay travel together — see `providerSku`. */
  relay: string;
  /** Who ultimately serves it. Four doors into one Google is one supplier, not four. */
  upstream: string;
  /**
   * The vendor's own model string. The relay says who to bill; this says what to ask
   * for. Without it, two legs can look distinct and resolve to the same call — which is
   * exactly the defect that put kie's price ladder under a LaoZhang label on seven rows.
   */
  providerSku: string;
  channel: string;
  /** Landed FX multiplier: 1.2492 OpenRouter, 1.1839 direct. */
  fxMultiplier: number;
  basis: Basis;
  usdPerUnit: number;
  landedRubPerUnit: number;
  /** Rounded to 2dp for display. NEVER reconcile against this — see `reconcileLeg`. */
  costRubDisplay: number;
  costKnown: boolean;
  confidence: Confidence;
  credits: number;
  margin: number;
  ladderDepth: number;
  source: string;
  capturedOn: string;
  /** Frame aspect the price covers. `any` on every row today — see HEADER. */
  aspect: string;
  /**
   * Reference band this row prices, as input-image counts. `0..0` on an ordinary
   * row, which means «this row is not about references».
   */
  refsMin: number;
  refsMax: number;
  /** How the band charges inside itself. */
  bandPricing: BandPricing;
  /** USD per input image past the first included image, when `bandPricing` is per-extra. */
  perImageSurchargeUsd: number;
  /**
   * What must stay true for this leg's signed rate to hold, or null.
   *
   * Deliberately NOT part of `confidence`. Confidence is a claim about EVIDENCE and only
   * a measurement moves it; this is a claim about a CONDITION, and on the row that forced
   * the split the condition is one we control ourselves — the AtlasCloud `-developer`
   * tier suffix inside our own adapter. Losing it produces no external signal at all:
   * Atlas still answers, still returns video, and simply invoices more.
   */
  routeRisk: string | null;
  /** The model's default rung — its cheapest, by owner ruling. Same on every leg. */
  defaultRung: string | null;
  /**
   * Output area in megapixels, for legs a vendor bills per megapixel — rev. 19, from our
   * own §3: a rung is a LABEL and the label is not a size. Null on every leg billed by
   * any other basis, and that is the normal case; it is populated only where the area is
   * literally the invoice. Finance's generator refuses to place such a leg in a reserve
   * position behind a rung named by label, which is the machine form of the same fact.
   */
  areaMp: number | null;
  /**
   * Finance's own pre-joined row key (column Z). Carried rather than recomputed BECAUSE
   * it is independent: if their identity for a row and ours disagree, one of us has the
   * wrong idea of what a configuration is, and that is exactly the disagreement no
   * amount of checking our own key against itself can surface.
   */
  rowKey: string;
  /**
   * Units finance priced this leg over, in the leg's own `basis` — 5 seconds, 1 clip,
   * 1 image. New in rev. 6; before it, quantity had to be inferred, and inferring it
   * from the file's own cost is what made reconciliation A circular. It is finance's
   * number, so it is a value to CHECK our catalogue against, never a value to adopt.
   */
  quantity: number;
}

export interface ExcludedRow {
  position: string;
  reason: string;
}

export interface CostLegFile {
  legs: CostLeg[];
  excluded: ExcludedRow[];
  declared: {
    rows: number;
    credits: number;
    margin: number;
    source: string;
    hash: string;
    /** Finance's column-order fingerprint — sha256 of the header NAMES joined by `|`,
     *  first 16 hex. Their rev. 20 added it because their other three checksums are all
     *  SUMS, and addition is commutative: a sideways column shift leaves every one of
     *  them intact while each value sits one field to the left. `null` only for a file
     *  written before the fingerprint existed. */
    columns: string | null;
  };
}

const MODES: readonly Mode[] = [
  't2v',
  'i2v',
  'r2v',
  'video-edit',
  't2i',
  'i2i',
  'refs-0-1',
  'refs-2-8',
  'refs-2-10',
];

/** How the vendor meters, and therefore how a charge must scale. Lives here rather
 *  than in the catalogue so reconciliation can compare bases without a cycle. */
export type UnitKind = 'image' | 'second' | 'clip';

export const UNIT_KIND_BY_BASIS: Record<Basis, UnitKind> = {
  'за штуку': 'image',
  // rev. 13 renamed the image basis «за штуку» → «за изображение». Same unit, clearer
  // word — and a rename, not a new basis, so both map to `image`. The old spelling is
  // still live: our 7 ours-only rows were written against rev. 12 and have not been
  // regenerated by finance, so dropping it would fail the parse on rows finance never
  // touched. Neither spelling is guessed — both appear in files on disk today.
  'за изображение': 'image',
  'за секунду': 'second',
  'за клип': 'clip',
};
const BASES: readonly Basis[] = ['за клип', 'за секунду', 'за штуку', 'за изображение'];

/** Header, in order, exactly as the workbook emits it. Order is part of the contract:
 * a reordered file is a changed file and should fail loudly, not be re-mapped. */
const HEADER = [
  'model_id',
  'rung',
  'mode',
  'audio',
  'quality',
  'leg',
  'Роль',
  'ПОСРЕДНИК',
  'АПСТРЕМ',
  'SKU у поставщика',
  'Канал',
  'Множ.',
  'База тарификации',
  '$ за ед.',
  'Landed ₽/ед',
  'Себест ₽',
  'Себест известна',
  'ДОСТОВЕРНОСТЬ',
  'Кредитов',
  'Маржа ноги',
  'ГЛУБИНА ЛЕСТНИЦЫ',
  'Источник',
  'Дата ISO',
  'Количество',
  'aspect',
  'refs_min',
  'refs_max',
  'цена_в_полосе',
  'доплата_$_за_картинку',
  'КЛЮЧ конфигурации',
  'КЛЮЧ строки',
  'РИСК МАРШРУТА',
  'ступень_по_умолчанию',
  'площадь_МП',
] as const;

class CostLegError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `cost-legs.csv line ${line}: ${message}`);
    this.name = 'CostLegError';
  }
}

function roleOf(value: string, line: number): CostLegRole {
  const role = value.trim();
  if (role === 'основная') return 'primary';
  if (role === 'резервная') return 'fallback';
  throw new CostLegError(`Роль: unrecognised ${JSON.stringify(value)}`, line);
}

/** Minimal RFC4180 split — the export quotes any field containing a comma. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function num(raw: string, field: string, line: number): number {
  const v = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(v)) {
    throw new CostLegError(`${field}: expected a number, got ${JSON.stringify(raw)}`, line);
  }
  return v;
}

/**
 * A number the price formula divides by or multiplies into money. Finiteness is not
 * enough: a zero quantity makes `credits × units / quantity` infinite, and a negative
 * one inverts the charge. Both would reach the kernel as a plausible-looking number.
 */
function positive(raw: string, field: string, line: number): number {
  const v = num(raw, field, line);
  if (v <= 0) throw new CostLegError(`${field}: must be greater than zero, got ${v}`, line);
  return v;
}

function positiveInteger(raw: string, field: string, line: number): number {
  const v = num(raw, field, line);
  if (!Number.isInteger(v) || v < 1) {
    throw new CostLegError(`${field}: expected a positive integer, got ${v}`, line);
  }
  return v;
}

function yesNo(raw: string, field: string, line: number): boolean | null {
  const t = raw.trim();
  // '—' is the workbook's "not applicable" — image rows have no audio axis at all.
  if (t === '' || t === '-' || t === '—') return null;
  if (t === 'да') return true;
  if (t === 'нет') return false;
  throw new CostLegError(`${field}: expected да/нет, got ${JSON.stringify(raw)}`, line);
}

/**
 * rev. 15 ruling 4: a leg without a named relay is not a leg. A blank «ПОСРЕДНИК»
 * used to parse as the empty string and travel on as a costed route nobody could
 * invoice against, so the parser refuses it rather than costing an anonymous door.
 */
function namedRelay(raw: string, field: string, line: number): string {
  const t = raw.trim();
  if (t === '' || t === '-' || t === '—') {
    throw new CostLegError(`${field}: a leg without a named relay is not a leg`, line);
  }
  return t;
}

/**
 * A leg POSITION, not a leg count. Owner ruling 2026-08-11: the export is going to carry
 * a third leg (a new vendor for the seedance reference-to-video rows), so this refuses
 * only what cannot be a position — zero, negatives and fractions — rather than capping at
 * two. Capping was the shape of launch-backlog § L NP-7, and it is the thing being lifted.
 *
 * Nothing else here counts legs: the row key is `|ногаN` for any N, role is derived from
 * position (leg 1 primary, deeper legs reserve), and `route-attempt-context.ts` already
 * reads it that way. What a third leg still needs is GOVERNANCE — the margin gate
 * enumerates legs from the model row, not from this file, so a third priced leg is not
 * automatically floored. That work waits on the vendor actually being wired.
 */
function legNumber(raw: string, line: number): number {
  const v = num(raw, 'leg', line);
  if (!Number.isInteger(v) || v < 1) {
    throw new CostLegError(`leg: expected a position of 1 or more, got ${v}`, line);
  }
  return v;
}

function nonNegative(raw: string, field: string, line: number): number {
  const v = num(raw, field, line);
  if (v < 0) throw new CostLegError(`${field}: must not be negative, got ${v}`, line);
  return v;
}

function bandPricingOf(raw: string, line: number): BandPricing {
  const t = raw.trim() as BandPricing;
  if (!BAND_PRICINGS.includes(t)) {
    throw new CostLegError(`цена_в_полосе: unrecognised ${JSON.stringify(raw)}`, line);
  }
  return t;
}

function confidenceOf(raw: string, line: number): Confidence {
  const t = raw.trim();
  // Checked before HIGH only because rev. 13 writes «HIGH по ставке, РИСК по маршруту»
  // on the omni rows — a compound claim where the RISK half is the one that can lose
  // money, so it must not be swallowed by a `startsWith('HIGH')` match.
  if (t.startsWith('ЗАМЕРЕНО')) return 'MEASURED';
  if (t.includes('РИСК')) return 'RISK';
  if (t.startsWith('HIGH')) return 'HIGH';
  if (t.startsWith('ГИПОТЕЗА')) return 'HYPOTHESIS';
  if (t.startsWith('СРЕДНЯЯ') || t.startsWith('MEDIUM')) return 'MEDIUM';
  throw new CostLegError(`ДОСТОВЕРНОСТЬ: unrecognised value ${JSON.stringify(raw)}`, line);
}

/**
 * Digest of the LEGS block — the header line plus every data row, exactly as written.
 *
 * The meta line's `sha256_16` used to be parsed and compared against nothing, while a
 * comment here claimed it was what "makes a silent deletion impossible". It made
 * nothing impossible: the meta line is a self-declaration, and an edit to the rows
 * plus a matching edit to the meta line passed every check. A seal that is never
 * broken open is decoration.
 *
 * It now covers the rows it is supposed to protect, so changing a price without
 * recomputing the digest is a hard error rather than a silent success.
 */
/** Finance's column-order fingerprint: sha256 over the header NAMES joined by `|`,
 *  first 16 hex. Reproduced from their rev. 20 export (`da54ec1b730a358b` over 34
 *  columns) — deliberately not a sum, so it breaks on a shift, insertion or rename. */
export function columnFingerprint(header: readonly string[]): string {
  return createHash('sha256').update(header.join('|'), 'utf8').digest('hex').slice(0, 16);
}

function legsDigest(block: string): string {
  return createHash('sha256').update(block, 'utf8').digest('hex').slice(0, 16);
}

/** Parse the export. Throws on anything it does not fully understand. */
export function parseCostLegs(text: string): CostLegFile {
  const lines = text.split('\n');
  const meta = lines[0] ?? '';
  const m =
    /^#\s*rows=(\d+)\s+credits=(\d+)\s+margin=([\d.]+)\s+source=(.+?)\s+sha256_16=([0-9a-f]{16})(?:\s+cols_sha16=([0-9a-f]{16}))?\s*$/.exec(
      meta,
    );
  if (!m) throw new CostLegError('first line must be the meta line with rows/credits/margin/hash');
  const declared = {
    rows: Number(m[1]),
    credits: Number(m[2]),
    margin: Number(m[3]),
    source: m[4]!,
    hash: m[5]!,
    /** Finance's fourth checksum (their rev. 20). Optional only so a file written
     *  before it existed still parses; every import writes it. */
    columns: m[6] ?? null,
  };

  let i = 1;
  const expectBlock = (name: string): void => {
    while (i < lines.length && lines[i]!.trim() === '') i += 1;
    if (lines[i]?.trim() !== `# ${name}`) {
      throw new CostLegError(`expected block marker "# ${name}"`, i + 1);
    }
    i += 1;
  };

  expectBlock('LEGS');
  const blockStart = i;
  const header = splitCsvLine(lines[i]!);
  i += 1;
  const requiredHeaderNames: ReadonlySet<string> = new Set(HEADER);
  const actualHeaderNames = new Set(header);
  const missing = HEADER.filter((h) => !actualHeaderNames.has(h));
  const unknown = header.filter((h) => !requiredHeaderNames.has(h));
  const headerNamesMatch =
    actualHeaderNames.size === requiredHeaderNames.size &&
    [...requiredHeaderNames].every((name) => actualHeaderNames.has(name)) &&
    [...actualHeaderNames].every((name) => requiredHeaderNames.has(name));
  if (header.length !== HEADER.length || !headerNamesMatch) {
    throw new CostLegError(
      `header mismatch. missing=[${missing.join(', ')}] unknown=[${unknown.join(', ')}]`,
      i,
    );
  }
  // Finance's fourth checksum, verified against the header we actually read. Their other
  // three are sums, and a sideways shift leaves all three intact — the numbers reconcile
  // perfectly while every field sits one column to the left, and the engine reads a
  // confidence string as a price. Their reading rule, adopted verbatim: if the
  // fingerprint disagrees and the sums agree, the structure is wrong and the numbers are
  // meaningless — so this throws instead of warning.
  if (declared.columns !== null) {
    const fingerprint = columnFingerprint(header);
    if (fingerprint !== declared.columns) {
      throw new CostLegError(
        `column-order fingerprint mismatch: header hashes to ${fingerprint}, the meta line ` +
          `declares ${declared.columns}. The three sums cannot see a sideways shift — read ` +
          'the structure, not the numbers.',
        i,
      );
    }
  }
  const indexByHeaderName = new Map(header.map((name, index) => [name, index] as const));

  const legs: CostLeg[] = [];
  let blockEnd = i;
  for (; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim() === '' || raw.startsWith('#')) break;
    blockEnd = i;
    const c = splitCsvLine(raw);
    const line = i + 1;
    if (c.length !== HEADER.length) {
      throw new CostLegError(`expected ${HEADER.length} columns, got ${c.length}`, line);
    }
    const cell = (name: (typeof HEADER)[number]): string => c[indexByHeaderName.get(name)!]!;
    const mode = cell('mode').trim() as Mode;
    if (!MODES.includes(mode)) {
      throw new CostLegError(`mode: unrecognised ${JSON.stringify(cell('mode'))}`, line);
    }
    const basis = cell('База тарификации').trim() as Basis;
    if (!BASES.includes(basis)) {
      throw new CostLegError(
        `База тарификации: unrecognised ${JSON.stringify(cell('База тарификации'))}`,
        line,
      );
    }
    const date = cell('Дата ISO').trim();
    // Shape AND calendar. The shape check alone accepted 2026-02-31, which is not a
    // date — and a capture date that never happened is a provenance claim that cannot
    // be checked against anything.
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    ) {
      // Excel serials (46237) reach here if finance regresses the ISO formatting.
      throw new CostLegError(
        `Дата ISO: expected a real YYYY-MM-DD, got ${JSON.stringify(date)}`,
        line,
      );
    }
    legs.push({
      modelId: cell('model_id').trim(),
      rung: cell('rung').trim(),
      mode,
      audio: yesNo(cell('audio'), 'audio', line),
      quality: cell('quality').trim() || null,
      leg: legNumber(cell('leg'), line),
      role: roleOf(cell('Роль'), line),
      relay: namedRelay(cell('ПОСРЕДНИК'), 'ПОСРЕДНИК', line),
      upstream: cell('АПСТРЕМ').trim(),
      providerSku: cell('SKU у поставщика').trim(),
      channel: cell('Канал').trim(),
      fxMultiplier: num(cell('Множ.'), 'Множ.', line),
      basis,
      usdPerUnit: num(cell('$ за ед.'), '$ за ед.', line),
      landedRubPerUnit: num(cell('Landed ₽/ед'), 'Landed ₽/ед', line),
      costRubDisplay: num(cell('Себест ₽'), 'Себест ₽', line),
      costKnown: yesNo(cell('Себест известна'), 'Себест известна', line) === true,
      confidence: confidenceOf(cell('ДОСТОВЕРНОСТЬ'), line),
      credits: positive(cell('Кредитов'), 'Кредитов', line),
      margin: num(cell('Маржа ноги'), 'Маржа ноги', line),
      ladderDepth: positiveInteger(cell('ГЛУБИНА ЛЕСТНИЦЫ'), 'ГЛУБИНА ЛЕСТНИЦЫ', line),
      source: cell('Источник').trim(),
      capturedOn: date,
      quantity: positive(cell('Количество'), 'Количество', line),
      aspect: cell('aspect').trim() || 'any',
      refsMin: nonNegative(cell('refs_min'), 'refs_min', line),
      refsMax: nonNegative(cell('refs_max'), 'refs_max', line),
      bandPricing: bandPricingOf(cell('цена_в_полосе'), line),
      perImageSurchargeUsd: nonNegative(
        cell('доплата_$_за_картинку'),
        'доплата_$_за_картинку',
        line,
      ),
      routeRisk: cell('РИСК МАРШРУТА').trim() || null,
      defaultRung: cell('ступень_по_умолчанию').trim() || null,
      areaMp: cell('площадь_МП').trim() ? num(cell('площадь_МП'), 'площадь_МП', line) : null,
      rowKey: cell('КЛЮЧ строки').trim(),
    });

    // Both key columns were decoration: «КЛЮЧ конфигурации» was read by nobody, and
    // uniqueness was checked on the RECOMPUTED key only, so a supplied key could name a
    // different configuration than the row it sat on. Hold both to the row's own data.
    //
    // This sits INSIDE the parse loop on purpose. The legs digest below catches any hand
    // edit first, so a check placed after it is unreachable and could never be red-proofed;
    // here it also covers the case the digest cannot — a genuinely regenerated export whose
    // keys disagree with its own columns.
    const parsed = legs[legs.length - 1]!;

    // Position and role are two spellings of one fact, and nothing checked they agreed.
    // That was survivable while a row could only be leg 1 or 2 — it stops being survivable
    // under a ladder, where «резервная» on leg 1 would make a reserve look like the
    // primary the price is set from. Derived consumers already assume the mapping:
    // `apps/worker/src/route-attempt-context.ts` reads leg 1 as primary and everything
    // deeper as a reserve.
    const expectedRole = parsed.leg === 1 ? 'primary' : 'fallback';
    if (parsed.role !== expectedRole) {
      throw new CostLegError(
        `Роль: leg ${parsed.leg} must be ${expectedRole === 'primary' ? 'основная' : 'резервная'}, got ${JSON.stringify(cell('Роль').trim())}`,
        line,
      );
    }

    if (parsed.leg > parsed.ladderDepth) {
      throw new CostLegError(
        `ГЛУБИНА ЛЕСТНИЦЫ: leg ${parsed.leg} exceeds ladder depth ${parsed.ladderDepth}`,
        line,
      );
    }

    const suppliedConfigKey = cell('КЛЮЧ конфигурации').trim();
    const computedRowKey = `${configKey(parsed)}|нога${parsed.leg}`;
    if (parsed.rowKey !== computedRowKey) {
      throw new CostLegError(
        `КЛЮЧ строки: row says ${JSON.stringify(parsed.rowKey)} but its own columns compute ${JSON.stringify(computedRowKey)}`,
        line,
      );
    }
    if (parsed.rowKey !== `${suppliedConfigKey}|нога${parsed.leg}`) {
      throw new CostLegError(
        `КЛЮЧ конфигурации: ${JSON.stringify(suppliedConfigKey)} does not prefix its own КЛЮЧ строки ${JSON.stringify(parsed.rowKey)}`,
        line,
      );
    }
  }

  const excluded: ExcludedRow[] = [];
  if (i < lines.length) {
    expectBlock('EXCLUDED');
    const eh = splitCsvLine(lines[i]!);
    i += 1;
    if (eh[0] !== 'position' || eh[1] !== 'reason') {
      throw new CostLegError('EXCLUDED block header must be position,reason', i);
    }
    for (; i < lines.length; i += 1) {
      if (lines[i]!.trim() === '') continue;
      const c = splitCsvLine(lines[i]!);
      const [position = '', reason = ''] = c;
      excluded.push({ position: position.trim(), reason: reason.trim() });
    }
  }

  // The declared count is the whole point of having one: without it a deleted row is
  // indistinguishable from a row that never existed, and a configuration silently
  // leaves the catalogue.
  if (legs.length !== declared.rows) {
    throw new CostLegError(`declared ${declared.rows} rows, parsed ${legs.length}`);
  }
  const credits = legs.reduce((a, l) => a + l.credits, 0);
  if (credits !== declared.credits) {
    throw new CostLegError(`declared credits ${declared.credits}, summed ${credits}`);
  }
  const margin = Number(legs.reduce((a, l) => a + l.margin, 0).toFixed(6));
  if (Math.abs(margin - declared.margin) > 1e-6) {
    throw new CostLegError(`declared margin ${declared.margin}, summed ${margin}`);
  }

  // The digest stays after the row shape is known good, so a corrupt file reports the
  // thing that is actually wrong instead of an opaque hash mismatch. The ladder check
  // follows it so a regenerated export can prove its own declared positions.
  const actualHash = legsDigest(lines.slice(blockStart, blockEnd + 1).join('\n'));
  if (actualHash !== declared.hash) {
    throw new CostLegError(
      `LEGS digest ${actualHash} does not match the declared sha256_16=${declared.hash} — ` +
        'a row was edited without regenerating the export',
    );
  }

  const byConfiguration = new Map<string, CostLeg[]>();
  for (const leg of legs) {
    const configuration = configKey(leg);
    byConfiguration.set(configuration, [...(byConfiguration.get(configuration) ?? []), leg]);
  }
  for (const [configuration, configurationLegs] of byConfiguration) {
    const depths = [...new Set(configurationLegs.map((leg) => leg.ladderDepth))].sort(
      (a, b) => a - b,
    );
    if (depths.length !== 1) {
      throw new CostLegError(
        `configuration ${configuration}: rows declare ladder depths [${depths.join(', ')}]`,
      );
    }
    const ladderDepth = depths[0]!;
    const positions = configurationLegs.map((leg) => leg.leg).sort((a, b) => a - b);
    const expectedPositions = Array.from({ length: ladderDepth }, (_, index) => index + 1);
    if (
      positions.length !== expectedPositions.length ||
      positions.some((position, index) => position !== expectedPositions[index])
    ) {
      throw new CostLegError(
        `configuration ${configuration}: ladder positions must be exactly 1..${ladderDepth}, got [${positions.join(', ')}]`,
      );
    }
  }

  const rowKeys = new Set<string>();
  for (const l of legs) {
    const k = configKey(l) + `|нога${l.leg}`;
    if (rowKeys.has(k)) throw new CostLegError(`duplicate row key ${k}`);
    rowKeys.add(k);
  }

  return { legs, excluded, declared };
}

/** The configuration a leg serves. Two legs of one configuration share this. */
export function configKey(
  l: Pick<CostLeg, 'modelId' | 'rung' | 'mode' | 'audio' | 'quality' | 'aspect'>,
): string {
  const a = l.audio === null ? '-' : l.audio ? 'да' : 'нет';
  return [l.modelId, l.rung, l.mode, a, l.quality ?? '-', l.aspect].join('|');
}

/**
 * The executable identity of a leg. Two legs that resolve to the same call are one
 * route written twice, whatever their labels say — the check that would have caught
 * seven mislabelled relays before finance found them by hand.
 */
export function executableIdentity(l: CostLeg): string {
  return [l.relay.toLowerCase(), l.providerSku.toLowerCase(), l.channel.toLowerCase()].join('|');
}

export interface Reconciliation {
  key: string;
  statedMargin: number;
  recomputedMargin: number;
  /** Absolute difference in PERCENTAGE POINTS. */
  deltaPp: number;
  quantity: number;
  /**
   * We and finance disagree about what a UNIT IS. Strictly worse than a quantity
   * disagreement: we sell Veo in 8-second units while finance sells one clip at any
   * duration, so there is no number of units that makes the two sides comparable.
   */
  basisMismatch: boolean;
  /** Same basis, different count — we sell 6 seconds where the price covers 5. */
  quantityMismatch: boolean;
}

/**
 * Recompute a leg's margin from INPUTS — vendor rate × landed FX × quantity — against
 * credits and the credit floor we hold, and compare to what finance stated.
 *
 * Two things this must not do, both learned the hard way:
 *
 * 1. **Never reconcile against `costRubDisplay`.** It is rounded to 2dp, and finance
 *    computes the margin from the unrounded value. Reconciling against the rounded
 *    figure puts 35 of 76 rows outside a 0.01pp tolerance while nothing is wrong.
 * 2. **Never take `credits` from the export.** They are the number under review. Pass
 *    our own catalogue's credits; a disagreement is then a real finding rather than the
 *    file agreeing with itself.
 *
 * `quantity` likewise comes from our contract, not the file. Rev. 6 added a quantity
 * column, but adopting it would put finance on both sides of the comparison again; it
 * is reported as `quantityMismatch` instead, which is a finding in its own right — a
 * leg priced over 5 seconds while our catalogue sells 6 is a 20% hole no margin check
 * would see, because both sides would be internally consistent.
 */
export function reconcileLeg(
  leg: CostLeg,
  ours: { credits: number; unitKind: UnitKind; baseUnits: number },
  creditFloorRub: number,
): Reconciliation {
  // OUR side of the comparison comes entirely from OUR catalogue — the unit kind we
  // sell in and the count we sell. The previous version read the unit count off the
  // LEG's own basis (`basis === 'за секунду' ? ourBaseUnits : 1`), which meant that on
  // any non-second basis both sides were the literal constant 1 and the check could
  // never fire. It was green on precisely the six Veo rows where the two sides do not
  // even agree what a unit is. That is the same circularity as the first reconciliation,
  // one level down, and it is why this now takes our unitKind rather than inferring it.
  const basisMismatch = UNIT_KIND_BY_BASIS[leg.basis] !== ours.unitKind;
  const quantity = basisMismatch ? leg.quantity : ours.baseUnits;
  const exactCost = leg.usdPerUnit * leg.landedRubPerUnit * quantity;
  const revenue = ours.credits * creditFloorRub;
  const recomputed = 1 - exactCost / revenue;
  return {
    key: configKey(leg) + `|нога${leg.leg}`,
    statedMargin: leg.margin,
    recomputedMargin: recomputed,
    deltaPp: Math.abs(recomputed - leg.margin) * 100,
    quantity,
    basisMismatch,
    quantityMismatch: !basisMismatch && quantity !== leg.quantity,
  };
}
