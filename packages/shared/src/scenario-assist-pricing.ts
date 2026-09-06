import {
  LLM_PRICING_WORKBOOK,
  llmPricingRecord,
  type LlmPricingRecord,
} from './llm-pricing-workbook';

export type ScenarioPricingTier = 'economy' | 'standard' | 'max';
export type ScenarioPricingScope = 'project' | 'span' | 'scene' | 'script';

/** UTF-8 byte envelopes signed in the Vertov workbook (LLM ЦЕНЫ). */
export const SCENARIO_CONTEXT_BANDS: Record<
  ScenarioPricingScope,
  readonly { id: string; maxInputBytes: number }[]
> = {
  project: [
    { id: '8k', maxInputBytes: 8_000 },
    { id: '16k', maxInputBytes: 16_000 },
    { id: '24k', maxInputBytes: 24_000 },
  ],
  span: [
    { id: '8k', maxInputBytes: 8_000 },
    { id: '16k', maxInputBytes: 16_000 },
    { id: '22_4k', maxInputBytes: 22_400 },
  ],
  scene: [
    { id: '8k', maxInputBytes: 8_000 },
    { id: '16k', maxInputBytes: 16_000 },
    { id: '28k', maxInputBytes: 28_000 },
  ],
  script: [
    { id: '16k', maxInputBytes: 16_000 },
    { id: '32k', maxInputBytes: 32_000 },
    { id: '48k', maxInputBytes: 48_000 },
    { id: '64k', maxInputBytes: 64_000 },
    { id: '83_8k', maxInputBytes: 83_800 },
  ],
};

export const SCENARIO_OUTPUT_TOKENS: Record<ScenarioPricingScope, number> = {
  project: 2_000,
  span: 1_500,
  scene: 2_000,
  script: 2_500,
};

export interface ScenarioPricingInput {
  tier: ScenarioPricingTier;
  scope: ScenarioPricingScope;
  /** Complete serialized prompt size in UTF-8 bytes. */
  inputBytes: number;
  /** Whether the bounded rolling conspect is present in the prompt. */
  conspectIncluded: boolean;
  /**
   * Whether this successful turn can trigger the bounded rolling-conspect
   * refresh after the answer.  The active workbook's `/conspect` rows price
   * that conditional economy-model work, not the mere presence of an older
   * summary in the current prompt.  Kept optional for pure callers that only
   * model the prompt shape; in that case the historical `conspectIncluded`
   * predicate is used.
   */
  conspectRefreshRequired?: boolean;
}

export interface ScenarioPricingPlan {
  tier: ScenarioPricingTier;
  scope: ScenarioPricingScope;
  inputBand: string;
  maxInputBytes: number;
  maxOutputTokens: number;
  credits: number;
  conspectIncluded: boolean;
  conspectRefreshRequired: boolean;
  record: LlmPricingRecord;
}

export class ScenarioContextLimitError extends Error {
  readonly code = 'scenario_context_limit_exceeded';
  constructor(
    readonly scope: ScenarioPricingScope,
    readonly inputBytes: number,
    readonly maxInputBytes: number,
  ) {
    super(`Scenario ${scope} context is ${inputBytes} UTF-8 bytes; maximum is ${maxInputBytes}`);
    this.name = 'ScenarioContextLimitError';
  }
}

/** Choose the smallest signed envelope that contains the serialized prompt. */
export function scenarioContextBand(
  scope: ScenarioPricingScope,
  inputBytes: number,
): { id: string; maxInputBytes: number } {
  const bands = SCENARIO_CONTEXT_BANDS[scope];
  const selected = bands.find((band) => inputBytes <= band.maxInputBytes);
  if (selected) return selected;
  const maximum = bands[bands.length - 1]!.maxInputBytes;
  throw new ScenarioContextLimitError(scope, inputBytes, maximum);
}

/**
 * Workbook-only Scenario quote.  No provider catalog or client-side price is
 * consulted here: rates, attempts, FX and the 25% active-band floor all arrive
 * through the generated `LLM ЦЕНЫ` export.
 */
export function planScenarioAssistPricing(input: ScenarioPricingInput): ScenarioPricingPlan {
  const band = scenarioContextBand(input.scope, input.inputBytes);
  const conspectRefreshRequired = input.conspectRefreshRequired ?? input.conspectIncluded;
  const conspect = conspectRefreshRequired ? 'conspect' : 'no-conspect';
  const selector = `${input.tier}/${input.scope}/${band.id}/${conspect}`;
  const record = llmPricingRecord('scenario_assist_band', selector);
  if (record.maxTokenBudget.input !== band.maxInputBytes) {
    throw new Error(
      `scenario pricing workbook band drift: ${selector} has ${record.maxTokenBudget.input}, expected ${band.maxInputBytes}`,
    );
  }
  if (record.maxTokenBudget.output !== SCENARIO_OUTPUT_TOKENS[input.scope]) {
    throw new Error(`scenario pricing workbook output drift: ${selector}`);
  }
  return {
    tier: input.tier,
    scope: input.scope,
    inputBand: band.id,
    maxInputBytes: band.maxInputBytes,
    maxOutputTokens: record.maxTokenBudget.output,
    credits: record.credits,
    conspectIncluded: input.conspectIncluded,
    conspectRefreshRequired,
    record,
  };
}

export function scenarioBandMarginFloor(): number {
  return LLM_PRICING_WORKBOOK.financial.scenarioBandMarginFloor;
}
