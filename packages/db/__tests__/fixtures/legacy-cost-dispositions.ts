export type LegacyCostDisposition =
  | 'MATCHED'
  | 'AMBIGUOUS_RESOLVED_PLAIN'
  | 'AMBIGUOUS_RESOLVED_RELAY'
  | 'AMBIGUOUS_RESOLVED_AUDIO'
  | 'RETIRED_NO_V2_LEG'
  | 'VERDICT_PENDING_FINANCE';

export interface LegacyCostDispositionEntry {
  legacyKey: string;
  disposition: LegacyCostDisposition;
  legacyUsdPerUnit: number;
  v2Leg: string | null;
  v2UsdPerUnit: number | null;
  reason: string;
}

/** Filled by hand from the legacy ladder and signed cost-leg export. */
export const LEGACY_COST_DISPOSITIONS: readonly LegacyCostDispositionEntry[] = [
  {
    legacyKey: 'veo-3-1 · 1080p · direct',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.159375,
    v2Leg: 'veo-3-1|1080p|t2v|да|-|any|нога1',
    v2UsdPerUnit: 1.275,
    reason:
      'The legacy per-second equivalent normalizes by eight reference seconds to the sole Kie leg.',
  },
  {
    legacyKey: 'veo-3-1-fast · 1080p · direct',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.040625,
    v2Leg: 'veo-3-1-fast|1080p|t2v|да|-|any|нога1',
    v2UsdPerUnit: 0.325,
    reason:
      'The legacy per-second equivalent normalizes by eight reference seconds to the sole Kie leg.',
  },
  {
    legacyKey: 'veo-3-1-lite · 1080p · direct',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.021875,
    v2Leg: 'veo-3-1-lite|1080p|t2v|да|-|any|нога1',
    v2UsdPerUnit: 0.175,
    reason:
      'The legacy per-second equivalent normalizes by eight reference seconds to the sole Kie leg.',
  },
  {
    legacyKey: 'seedance-2-0 · 1080p · OpenRouter',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.34,
    v2Leg: 'seedance-2-0|1080p|t2v|нет|-|any|нога1',
    v2UsdPerUnit: 0.34,
    reason: 'The OpenRouter 1080p text-to-video primary leg has the same per-second rate.',
  },
  {
    legacyKey: 'seedance-2-0-fast · 720p · OpenRouter',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.121,
    v2Leg: 'seedance-2-0-fast|720p|t2v|нет|-|any|нога1',
    v2UsdPerUnit: 0.121,
    reason: 'The OpenRouter 720p text-to-video primary leg has the same per-second rate.',
  },
  {
    legacyKey: 'happyhorse-1-1 · 1080p · OpenRouter',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.1278,
    v2Leg: 'happyhorse-1-1|1080p|t2v|нет|-|any|нога1',
    v2UsdPerUnit: 0.1278,
    reason: 'The OpenRouter 1080p text-to-video primary leg preserves the legacy rate.',
  },
  {
    legacyKey: 'happyhorse-1-0 · 1080p · OpenRouter',
    disposition: 'RETIRED_NO_V2_LEG',
    legacyUsdPerUnit: 0.1694,
    v2Leg: null,
    v2UsdPerUnit: null,
    reason:
      'The signed export has only a video-edit leg for this model, which rule 6 cannot use for an unsuffixed legacy key.',
  },
  {
    legacyKey: 'wan-2-7 · 1080p · direct',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.12,
    v2Leg: 'wan-2-7|1080p|t2v|нет|-|any|нога1',
    v2UsdPerUnit: 0.12,
    reason: 'The direct 1080p text-to-video primary leg has the same per-second rate.',
  },
  {
    legacyKey: 'kling-v3-0-std · 720p · OpenRouter',
    disposition: 'AMBIGUOUS_RESOLVED_AUDIO',
    legacyUsdPerUnit: 0.126,
    v2Leg: 'kling-v3-0-std|720p|t2v|да|-|any|нога1',
    v2UsdPerUnit: 0.126,
    reason:
      'Hand-paired to the audio-on primary SKU as the legacy family representative; audio is absent from the legacy key and was not selected by rate.',
  },
  {
    legacyKey: 'grok-imagine-video · 720p · direct',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.015,
    v2Leg: 'grok-imagine-video|720p|t2v|нет|-|any|нога1',
    v2UsdPerUnit: 0.0225,
    reason:
      'The direct 720p text-to-video leg is the named Kie route; its changed rate remains reportable.',
  },
  {
    legacyKey: 'gemini-omni-flash · direct',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.079,
    v2Leg: 'gemini-omni-flash|default|t2v|да|-|any|нога1',
    v2UsdPerUnit: 0.079,
    reason: 'The sole direct Omni leg preserves the legacy per-second rate.',
  },
  {
    legacyKey:
      'seedance-2-0-reference-to-video · 1080p · OpenRouter (deliberate mirror of seedance-2-0)',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.34,
    v2Leg: 'seedance-2-0|1080p|r2v|нет|-|any|нога1',
    v2UsdPerUnit: 0.34,
    reason:
      'splitModelId maps the suffixed picker id to the signed OpenRouter reference-to-video leg.',
  },
  {
    legacyKey:
      'seedance-2-0-fast-reference-to-video · 720p · OpenRouter (deliberate mirror of seedance-2-0-fast)',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.121,
    v2Leg: 'seedance-2-0-fast|720p|r2v|нет|-|any|нога1',
    v2UsdPerUnit: 0.121,
    reason:
      'splitModelId maps the suffixed picker id to the signed OpenRouter reference-to-video leg.',
  },
  {
    legacyKey: 'nano-banana · direct',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.02,
    v2Leg: 'gemini-2-5-flash-image|default|t2i|-|-|any|нога1',
    v2UsdPerUnit: 0.02,
    reason: 'The direct Nano Banana key maps to the sole LaoZhang text-to-image leg.',
  },
  {
    legacyKey: 'nano-banana-2 · direct',
    disposition: 'AMBIGUOUS_RESOLVED_RELAY',
    legacyUsdPerUnit: 0.055,
    v2Leg: 'gemini-3-1-flash-image|1K|t2i|-|-|any|нога2',
    v2UsdPerUnit: 0.055,
    reason:
      'Hand-paired to the LaoZhang reserve because the old direct-family figure belongs to that relay, not the Kie primary.',
  },
  {
    legacyKey: 'nano-banana-2-lite · direct',
    disposition: 'AMBIGUOUS_RESOLVED_RELAY',
    legacyUsdPerUnit: 0.025,
    v2Leg: 'gemini-3-1-flash-lite-image|default|t2i|-|-|any|нога2',
    v2UsdPerUnit: 0.025,
    reason:
      'Hand-paired to the LaoZhang reserve; the direct family spans Kie and LaoZhang and the choice is not derived from agreement.',
  },
  {
    legacyKey: 'nano-banana-pro · 4K · direct',
    disposition: 'AMBIGUOUS_RESOLVED_RELAY',
    legacyUsdPerUnit: 0.09,
    v2Leg: 'gemini-3-pro-image|4K|t2i|-|-|any|нога1',
    v2UsdPerUnit: 0.09,
    reason:
      'Hand-paired to the LaoZhang primary; the direct family also carries a distinct Kie reserve at this rung.',
  },
  {
    legacyKey: 'gpt-image-2 · high · direct',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.08,
    v2Leg: 'gpt-image-2|default|t2i|-|high|any|нога1',
    // 0,08 → 0,03 in rev. 13. The legacy figure stays 0,08 on purpose: it is what the
    // OLD table said, and rewriting history would hide the size of the correction. The
    // v2 side moves because we MEASURED it — three paid calls through the route the code
    // actually runs, with the billing counter's unit calibrated against LaoZhang's
    // published flat $0,09 first. The old 0,08 was Kie's published tier rate for a leg
    // that never executes: `forceGateway: 'nanobanana'` has always run LaoZhang first.
    v2UsdPerUnit: 0.03,
    reason:
      'The legacy high resolution normalizes to the CSV default rung with quality=high. The v2 rate is the MEASURED LaoZhang rate (rev. 13, ЗАМЕРЕНО 09.08.2026), not the Kie tier price the legacy table carried for a leg that never ran.',
  },
  {
    legacyKey: 'seedream-4-5 · direct',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.0325,
    v2Leg: 'seedream-4-5|2K|t2i|-|-|any|нога1',
    v2UsdPerUnit: 0.0325,
    reason:
      'The legacy entry is explicitly the sellable 2K direct tier; its parked 1K workbook rung has no matching v2 configuration.',
  },
  {
    legacyKey: 'seedream-5-0-pro · 2K · direct',
    disposition: 'VERDICT_PENDING_FINANCE',
    legacyUsdPerUnit: 0.07,
    v2Leg: 'seedream-5-0-pro|2K|refs-0-1|-|-|any|нога1',
    v2UsdPerUnit: 0.07,
    reason:
      'The hand-resolved plain row has the same cost rate, but legacy says 29 credits while the signed export and current catalogue say 31; finance owns that unresolved decision.',
  },
  {
    legacyKey: 'seedream-5-0-lite · direct',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.0275,
    v2Leg: 'seedream-5-0-lite|2K|t2i|-|-|any|нога1',
    v2UsdPerUnit: 0.0275,
    reason: 'The direct 2K text-to-image primary leg preserves the legacy rate.',
  },
  {
    legacyKey: 'flux-2-pro · OpenRouter',
    disposition: 'AMBIGUOUS_RESOLVED_PLAIN',
    legacyUsdPerUnit: 0.03,
    v2Leg: 'flux-2-pro|1K|t2i|-|-|any|нога2',
    v2UsdPerUnit: 0.03,
    reason:
      'The legacy model+rung also has a reference band, so it is hand-paired to the plain OpenRouter reserve and never falls through to the band.',
  },
  {
    legacyKey: 'recraft-v4 · OpenRouter',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.04,
    v2Leg: 'recraft-v4|default|t2i|-|-|any|нога1',
    v2UsdPerUnit: 0.04,
    reason: 'The sole OpenRouter text-to-image leg preserves the legacy rate.',
  },
  {
    legacyKey: 'recraft-v4-vector · OpenRouter',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.08,
    v2Leg: 'recraft-v4-vector|default|t2i|-|-|any|нога1',
    v2UsdPerUnit: 0.08,
    reason: 'The sole OpenRouter vector leg preserves the legacy rate.',
  },
  {
    legacyKey: 'veo-3-1 · 1080p · direct · kie · 720p',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.15625,
    v2Leg: 'veo-3-1|720p|t2v|да|-|any|нога1',
    v2UsdPerUnit: 1.25,
    reason:
      'The nested Kie row normalizes its per-second equivalent by eight seconds to the 720p clip leg.',
  },
  {
    legacyKey: 'veo-3-1 · 1080p · direct · kie · 1080p',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.159375,
    v2Leg: 'veo-3-1|1080p|t2v|да|-|any|нога1',
    v2UsdPerUnit: 1.275,
    reason:
      'The nested Kie row normalizes its per-second equivalent by eight seconds to the 1080p clip leg.',
  },
  {
    legacyKey: 'veo-3-1 · 1080p · direct · openrouter · 720p',
    disposition: 'RETIRED_NO_V2_LEG',
    legacyUsdPerUnit: 0.4,
    v2Leg: null,
    v2UsdPerUnit: null,
    reason:
      'The signed export carries no OpenRouter Veo leg, so this exact legacy gateway row has no v2 pair.',
  },
  {
    legacyKey: 'veo-3-1 · 1080p · direct · openrouter · 1080p',
    disposition: 'RETIRED_NO_V2_LEG',
    legacyUsdPerUnit: 0.4,
    v2Leg: null,
    v2UsdPerUnit: null,
    reason:
      'The signed export carries no OpenRouter Veo leg, so this exact legacy gateway row has no v2 pair.',
  },
  {
    legacyKey: 'grok-imagine-video · 720p · direct · kie · 480p',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.008,
    v2Leg: 'grok-imagine-video|480p|t2v|нет|-|any|нога1',
    v2UsdPerUnit: 0.012,
    reason:
      'The nested Kie 480p row maps to the signed text-to-video leg, exposing the later +50% reprice.',
  },
  {
    legacyKey: 'grok-imagine-video · 720p · direct · kie · 720p',
    disposition: 'MATCHED',
    legacyUsdPerUnit: 0.015,
    v2Leg: 'grok-imagine-video|720p|t2v|нет|-|any|нога1',
    v2UsdPerUnit: 0.0225,
    reason:
      'The nested Kie 720p row maps to the signed text-to-video leg, exposing the later +50% reprice.',
  },
  {
    legacyKey: 'grok-imagine-video · 720p · direct · openrouter · 480p',
    disposition: 'RETIRED_NO_V2_LEG',
    legacyUsdPerUnit: 0.05,
    v2Leg: null,
    v2UsdPerUnit: null,
    reason:
      'The signed export carries no OpenRouter Grok leg, so this exact legacy gateway row has no v2 pair.',
  },
  {
    legacyKey: 'grok-imagine-video · 720p · direct · openrouter · 720p',
    disposition: 'RETIRED_NO_V2_LEG',
    legacyUsdPerUnit: 0.05,
    v2Leg: null,
    v2UsdPerUnit: null,
    reason:
      'The signed export carries no OpenRouter Grok leg, so this exact legacy gateway row has no v2 pair.',
  },
];
