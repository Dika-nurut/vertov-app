export type PerRungFindingKind =
  | 'DIVERGENCE'
  | 'OLD_TABLE_UNCOSTED'
  | 'NO_LEGACY_ENTRY'
  | 'NO_V2_ENTRY';

export interface PerRungReconciliationEntry {
  /** Stable identity of one active `PRICE_POINT_SEED` row. */
  rowKey: string;
  kind: PerRungFindingKind;
  oldGateway: string | null;
  /** The catalogue's primary leg for this exact configuration, or null when absent. */
  v2Leg: string | null;
  oldMargin: number | null;
  newMargin: number | null;
  deltaPp: number | null;
  /** New landed-RUB cost minus old landed-RUB cost for this row's baseUnits. */
  landedCostDeltaRub: number | null;
  /** True means the old number flatters the row's margin relative to v2. */
  oldMoreFlattering: boolean | null;
  verdict: string;
}

/**
 * Hand-authored from the reconciliation output. This is deliberately a literal oracle:
 * a new, disappeared, or numerically changed finding must be reviewed rather than
 * changing its expected value by following the computed result.
 *
 * DANGER: `oldMoreFlattering: true` is the activation-gate risk. The old number can
 * approve a row at a margin the v2 leg does not actually earn.
 */
export const PER_RUNG_RECONCILIATION: readonly PerRungReconciliationEntry[] = [
  {
    rowKey: 'veo-3-1-fast|720p|mode=any|audio=true|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'kie',
    v2Leg: 'veo-3-1-fast|720p|t2v|да|-|any|нога1',
    oldMargin: 0.19037535069864697,
    newMargin: 0.252654169875674,
    deltaPp: 6.227881917702705,
    landedCostDeltaRub: -2.5157875,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 1080p cost applied to every rung, so it is wrong by construction; v2 uses the exact signed 720p leg and no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'veo-3-1-lite|720p|mode=any|audio=true|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'kie',
    v2Leg: 'veo-3-1-lite|720p|t2v|да|-|any|нога1',
    oldMargin: 0.19414982458816366,
    newMargin: 0.3092712782184259,
    deltaPp: 11.512145363026228,
    landedCostDeltaRub: -2.5157875,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 1080p cost applied to every rung, so it is wrong by construction; v2 uses the exact signed 720p leg and no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'seedance-2-0|720p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'openrouter',
    v2Leg: 'seedance-2-0|720p|t2v|нет|-|any|нога1',
    oldMargin: -0.6878099611444717,
    newMargin: 0.2504138113740729,
    deltaPp: 93.82237725185446,
    landedCostDeltaRub: -100.34199,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 1080p cost applied to 720p, so it is wrong by construction; v2 uses the exact signed 720p leg and no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'seedance-2-0|480p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'openrouter',
    v2Leg: 'seedance-2-0|480p|t2v|нет|-|any|нога1',
    oldMargin: -2.7597421893080303,
    newMargin: 0.2591096274010646,
    deltaPp: 301.88518167090945,
    landedCostDeltaRub: -144.93843,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 1080p cost applied to 480p, so it is wrong by construction; v2 uses the exact signed 480p leg and no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'seedance-2-0-fast|480p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'openrouter',
    v2Leg: 'seedance-2-0-fast|480p|t2v|нет|-|any|нога1',
    oldMargin: -0.6441843646911614,
    newMargin: 0.26894943123649184,
    deltaPp: 91.31337959276532,
    landedCostDeltaRub: -35.677152,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 720p cost applied to 480p, so it is wrong by construction; v2 uses the exact signed 480p leg and no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'happyhorse-1-1|720p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'openrouter',
    v2Leg: 'happyhorse-1-1|720p|t2v|нет|-|any|нога1',
    oldMargin: 0.03341034253514008,
    newMargin: 0.2527460238065089,
    deltaPp: 21.933568127136883,
    landedCostDeltaRub: -15.39639,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 1080p cost applied to 720p, so it is wrong by construction; v2 uses the exact signed 720p leg and no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'wan-2-7|720p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'kie',
    v2Leg: 'wan-2-7|720p|t2v|нет|-|any|нога1',
    oldMargin: -0.1187262733149419,
    newMargin: 0.2541824844567052,
    deltaPp: 37.290875777164715,
    landedCostDeltaRub: -20.1263,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 1080p t2v cost applied to 720p, while v2 uses the exact signed 720p t2v leg; no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'wan-2-7|720p|mode=i2v|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'kie',
    v2Leg: 'wan-2-7|720p|i2v|нет|-|any|нога1',
    // Rev. 21 moved this rung onto the same kie leg and the same price as its t2v twin,
    // so every figure here is now the twin's figure. That equality is the assertion: if
    // the two ever diverge again while both rows name нога1 on kie, one of them is wrong.
    oldMargin: -0.1187262733149419,
    newMargin: 0.2541824844567052,
    deltaPp: 37.290875777164715,
    landedCostDeltaRub: -20.1263,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 1080p cost applied to 720p; v2 uses the exact signed 720p i2v leg, which since rev. 21 is the same kie leg at the same rate as t2v.',
  },
  // wan-2-7|1080p|mode=i2v STOPPED DIVERGING in rev. 21 and its entry is deliberately
  // gone rather than zeroed. It was the DANGER row of this manifest: the old model-wide
  // scalar read 43,2% while v2 scored the rung at 25,1%, because v2 served it on the
  // dearer exact OpenRouter leg — an activation number that was not real. Wiring
  // `wan/2-7-image-to-video` put the rung on kie at the price its t2v twin already had,
  // so the old path and the signed leg now agree and there is nothing left to reconcile.
  // A row leaving this list is the outcome the programme exists to produce; a row
  // leaving it WITHOUT a repricing or a routing change in the same commit is not.
  {
    rowKey: 'kling-v3-0-std|720p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'openrouter',
    v2Leg: 'kling-v3-0-std|720p|t2v|нет|-|any|нога1',
    oldMargin: -0.12239362416107413,
    newMargin: 0.25173758389261747,
    deltaPp: 37.41312080536916,
    landedCostDeltaRub: -22.29822,
    oldMoreFlattering: false,
    verdict:
      'The old table has no audio axis and applies its model scalar to the silent row, while v2 uses the exact signed audio-off leg; no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'grok-imagine-video|720p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'kie',
    v2Leg: 'grok-imagine-video|720p|t2v|нет|-|any|нога1',
    oldMargin: 0.6035817770644879,
    newMargin: 0.4053726655967319,
    deltaPp: -19.8209111467756,
    landedCostDeltaRub: 4.5284175,
    oldMoreFlattering: true,
    verdict:
      'DANGER: the old model-wide figure flatters the 720p rung against the signed Kie reprice, while v2 uses the exact 720p leg; finance sign-off is required and no price is changed.',
  },
  {
    rowKey: 'grok-imagine-video|480p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'kie',
    v2Leg: 'grok-imagine-video|480p|t2v|нет|-|any|нога1',
    oldMargin: 0.6057245782695446,
    newMargin: 0.40858686740431704,
    deltaPp: -19.71377108652276,
    landedCostDeltaRub: 2.415156,
    oldMoreFlattering: true,
    verdict:
      'DANGER: the old model-wide figure flatters the 480p rung against the signed Kie reprice, while v2 uses the exact 480p leg; finance sign-off is required and no price is changed.',
  },
  {
    rowKey: 'gemini-3-1-flash-image|1K|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'nanobanana',
    v2Leg: 'gemini-3-1-flash-image|1K|t2i|-|-|any|нога1',
    oldMargin: 0.01672734899328876,
    newMargin: 0.28489261744966443,
    deltaPp: 26.81652684563757,
    landedCostDeltaRub: -1.5094725,
    oldMoreFlattering: false,
    verdict:
      'The old direct-family scalar corresponds to the hand-selected reserve rate rather than the catalogue primary, so v2 uses the exact primary leg and finance must sign off the relay interpretation.',
  },
  {
    rowKey: 'gemini-3-1-flash-lite-image|default|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    // 2026-09-02 owner re-pin (migration 0108): the row's real primary is KIE —
    // finance's нога1. The old legacy-ladder scalar still carries the laozhang-era
    // conservative $0.025, so the DIVERGENCE remains but now reads old < new
    // (pessimistic direction, costs availability not money).
    oldGateway: 'kie',
    v2Leg: 'gemini-3-1-flash-lite-image|default|t2i|-|-|any|нога1',
    oldMargin: 0.15577600671140934,
    newMargin: 0.3246208053691275,
    deltaPp: 16.884479865771816,
    landedCostDeltaRub: -0.5031575,
    oldMoreFlattering: false,
    verdict:
      'The old direct-family scalar corresponds to the hand-selected reserve rate rather than the catalogue primary, so v2 uses the exact primary leg and finance must sign off the relay interpretation.',
  },
  {
    rowKey: 'gpt-image-2|low|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'laozhang',
    v2Leg: 'gpt-image-2|default|t2i|-|low|any|нога1',
    oldMargin: -0.8702808466701084,
    newMargin: 0.29864468249870946,
    deltaPp: 116.89255291688178,
    landedCostDeltaRub: -5.031575,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the high-quality cost applied to low quality, so it is wrong by construction; v2 uses the exact signed low-quality leg and no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'gpt-image-2|medium|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'laozhang',
    v2Leg: 'gpt-image-2|default|t2i|-|medium|any|нога1',
    oldMargin: -0.15779290508149568,
    // rev. 13 signed all three gpt-image-2 tiers on ONE LaoZhang leg billing a FLAT
    // $0.03; the manifest still carried the per-tier $0.05 this rung used to be costed
    // at. 27.6% → 56.6% is that correction, not a reprice — 21 credits is unchanged.
    newMargin: 0.5658276605944392,
    deltaPp: 72.3620565675935,
    landedCostDeltaRub: -5.031575,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the high-quality cost applied to medium quality, so it is wrong by construction; v2 uses the exact signed medium-quality leg and no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'seedream-5-0-pro|1K|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'kie',
    v2Leg: 'seedream-5-0-pro|1K|refs-0-1|-|-|any|нога1',
    oldMargin: -0.32965278942953,
    newMargin: 0.3351736052852349,
    deltaPp: 66.48263947147649,
    landedCostDeltaRub: -3.5221025,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 2K cost applied to 1K, so it is wrong by construction; v2 uses the exact signed 1K leg and no price is changed pending finance sign-off.',
  },
  // flux-2-pro|1K|refs 2-8 stood here until rev. 15 and is GONE rather than updated.
  //
  // It was a DIVERGENCE only because finance's designated нога1 for this band was
  // OpenRouter while the runtime routed kie — the reconciliation was comparing two
  // different legs and reporting the 17.9pp between them as a finding. rev. 15 moved kie
  // to нога1, on our recommendation, and the two sides now name the same leg. Nothing was
  // repriced; the row simply stopped disagreeing, which is what resolution looks like.
  //
  // The band itself is on notice: it exists because kie refused 2+ references, the kie
  // adapter fix of 2026-08-09 removed that refusal, and finance holds 14 credits only
  // until 2026-08-24 pending the paid call. When that lands the price becomes 11 and the
  // band row is deleted outright.
  {
    rowKey: 'seedance-2-0-reference-to-video|720p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'openrouter',
    v2Leg: 'seedance-2-0|720p|r2v|нет|-|any|нога1',
    oldMargin: -0.6878099611444717,
    newMargin: 0.2504138113740729,
    deltaPp: 93.82237725185446,
    landedCostDeltaRub: -100.34199,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 1080p cost applied to the r2v 720p mirror, so it is wrong by construction; v2 uses the exact signed r2v leg and no price is changed pending finance sign-off.',
  },
  {
    rowKey: 'seedance-2-0-reference-to-video|480p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'openrouter',
    v2Leg: 'seedance-2-0|480p|r2v|нет|-|any|нога1',
    oldMargin: -2.7597421893080303,
    newMargin: 0.2591096274010646,
    deltaPp: 301.88518167090945,
    landedCostDeltaRub: -144.93843,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 1080p cost applied to the r2v 480p mirror, so it is wrong by construction; v2 uses the exact signed r2v leg and no price is changed pending finance sign-off.',
  },
  {
    rowKey:
      'seedance-2-0-fast-reference-to-video|480p|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'openrouter',
    v2Leg: 'seedance-2-0-fast|480p|r2v|нет|-|any|нога1',
    oldMargin: -0.6441843646911614,
    newMargin: 0.26894943123649184,
    deltaPp: 91.31337959276532,
    landedCostDeltaRub: -35.677152,
    oldMoreFlattering: false,
    verdict:
      'The old model-wide figure is the 720p cost applied to the r2v 480p mirror, so it is wrong by construction; v2 uses the exact signed r2v leg and no price is changed pending finance sign-off.',
  },
  {
    // ACTIVE since rev. 14, which re-banded flux's cheap rung `default` → `1K` and so
    // let the 2K rung finally be declared. The old path has no 2K figure at all — it
    // carries ONE per-model scalar ($0.025, kie's 1K rate) and applies it to whatever
    // rung is asked for, so its 49.3% is the 1K cost worn by a 2K request. v2 uses the
    // MEASURED $0.035 (7 kie credits at $0,005, calibrated off the signed 1K leg) and
    // lands at 29.1%, above the floor. Flattering by 20.3pp, which is the dangerous
    // direction and exactly why the rung was priced from a measurement rather than from
    // a per-megapixel extrapolation — BFL's $0.03/MP model overshoots this rung ~3.4x.
    rowKey: 'flux-2-pro|2K|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'kie',
    v2Leg: 'flux-2-pro|2K|t2i|-|-|any|нога1',
    oldMargin: 0.4934656040268456,
    newMargin: 0.2908518456375838,
    deltaPp: -20.261375838926178,
    landedCostDeltaRub: 1.0063149999999998,
    oldMoreFlattering: true,
    verdict:
      "The old model-wide scalar is kie's 1K rate applied to a 2K request, so it is wrong by construction; v2 uses the measured $0.035 2K rate and the rung sells at 29.1%. No price is changed.",
  },
  {
    rowKey: 'flux-2-pro|2K|mode=i2i|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'kie',
    v2Leg: 'flux-2-pro|2K|i2i|-|-|any|нога1',
    oldMargin: 0.4934656040268456,
    newMargin: 0.2908518456375838,
    deltaPp: -20.261375838926178,
    landedCostDeltaRub: 1.0063149999999998,
    oldMoreFlattering: true,
    verdict:
      "The old model-wide scalar is kie's 1K rate applied to a 2K image-to-image request; v2 uses the measured $0.035 2K rate and the signed 15-credit row sells at 29.1%. No price is changed.",
  },
  {
    // The top rung of the owner's 13/21/33 ladder. The old path costs it at gpt-image-2's
    // `high` tier rate ($0.08); the leg finance signed is LaoZhang billing FLAT $0.03 at
    // every tier, which is what the ladder's 33 credits actually cost to serve. 72.4% is
    // therefore real, not a modelling artefact — and it is the direct evidence for the
    // owner ruling of 2026-08-10 that the ladder is VALUE-based pricing: at one flat cost
    // the price rule returns 13 on all three tiers, and 21/33 sell perceived quality.
    // Pessimistic direction (old reads worse), so nothing was ever activated on a margin
    // it did not earn.
    rowKey: 'gpt-image-2|high|mode=any|audio=false|videoInput=false|refs=0-any',
    kind: 'DIVERGENCE',
    oldGateway: 'laozhang',
    v2Leg: 'gpt-image-2|default|t2i|-|high|any|нога1',
    oldMargin: 0.26322269676632093,
    newMargin: 0.7237085112873703,
    deltaPp: 46.04858145210494,
    landedCostDeltaRub: -5.031575,
    oldMoreFlattering: false,
    verdict:
      'The old per-tier figure charges $0.08 for the high tier; the signed LaoZhang leg bills a FLAT $0.03 at every tier, so v2 reads 72.4%. No price is changed — the ladder is a signed owner override, not a cost-derived one.',
  },
];

/** The inactive row singled out in the brief remains a dangerous activation watch item. */
export const INACTIVE_FLATTERING_WATCH = {
  rowKey: 'seedance-2-0|4K|mode=any|audio=false|videoInput=false|refs=0-any',
  v2Leg: 'seedance-2-0|4K|t2v|нет|-|any|нога1',
  oldMargin: 0.7413839575665728,
  newMargin: 0.25029064732626105,
  deltaPp: -49.10933102403118,
  landedCostDeltaRub: 342.7744,
  verdict:
    'DANGER: this row is inactive today, but the old table flatters its 4K margin by applying the model scalar; v2 uses the exact signed 4K leg, so activation must not rely on the old number.',
} as const;
