import exportData from '../../db/seed/llm-pricing.generated.json';

export type LlmSurface =
  | 'boards_prompt_studio'
  | 'scenario_assist_price'
  | 'scenario_assist_band'
  | 'scenario_structurize'
  | 'scenario_structurize_active'
  | 'scenario_candidate'
  | 'boards_shot_plan'
  | 'boards_scene_objects'
  | 'scenario_material_compaction'
  | 'disabled_prompt_enhancer';

export type LlmUnitPrice = { input: number; output: number };

export interface LlmPricingRecord {
  surface: LlmSurface;
  selector: string;
  model: string;
  primaryProvider: string;
  fallbackProvider: string;
  primaryPriceUsdPerMTok: LlmUnitPrice;
  fallbackPriceUsdPerMTok: LlmUnitPrice;
  primaryMaxAttempts: number;
  fallbackMaxAttempts: number;
  typicalTokenBudget: LlmUnitPrice;
  maxTokenBudget: LlmUnitPrice;
  credits: number;
  marginAtFloor: number;
  briefCharLimit: number;
  resultCharLimit: number;
  charsPerToken: number;
  source: string;
  sourceRef: string;
  /** Cache economics are explicit workbook inputs; 1.0 means no discount. */
  cacheReadMultiplier: number;
  cacheWriteMultiplier: number;
  cacheTtl: string;
  cacheMinPrefixTokens: number;
  cacheStatus: string;
  cacheEvidence: string;
}

export const LLM_PRICING_WORKBOOK = exportData as {
  workbook: {
    path: string;
    sheet: string;
    capturedOn: string;
    sha256: string;
  };
  financial: {
    usdRub: number;
    landedRubPerUsdOpenRouter: number;
    landedRubPerUsdDirect: number;
    creditFloorRub: number;
    marginFloor: number;
    /** Legacy flat Scenario/structurize gross-margin floor retained for replay/import. */
    scenarioMarginFloor: number;
    /** Active Scenario context-band margin floor. */
    scenarioBandMarginFloor: number;
    scenarioConspectTokenBudget: LlmUnitPrice;
    scenarioConspectMaxAttempts: number;
    structurizeMaxAttempts: number;
  };
  records: LlmPricingRecord[];
};

export function llmPricingRecord(surface: LlmSurface, selector: string): LlmPricingRecord {
  const record = LLM_PRICING_WORKBOOK.records.find(
    (candidate) => candidate.surface === surface && candidate.selector === selector,
  );
  if (!record) {
    throw new Error(
      `llm-pricing-workbook: no ${surface}/${selector} row. Update the «LLM ЦЕНЫ» workbook sheet and regenerate the export.`,
    );
  }
  return record;
}

export function llmModelPrice(model: string): LlmUnitPrice {
  const candidates = LLM_PRICING_WORKBOOK.records.filter((record) => record.model === model);
  if (candidates.length === 0) {
    throw new Error(
      `llm-pricing-workbook: no registered token price for model "${model}". Update the workbook before routing to it.`,
    );
  }
  return candidates.reduce<LlmUnitPrice>(
    (dearest, record) => ({
      input: Math.max(
        dearest.input,
        record.primaryPriceUsdPerMTok.input,
        record.fallbackPriceUsdPerMTok.input,
      ),
      output: Math.max(
        dearest.output,
        record.primaryPriceUsdPerMTok.output,
        record.fallbackPriceUsdPerMTok.output,
      ),
    }),
    { input: 0, output: 0 },
  );
}
