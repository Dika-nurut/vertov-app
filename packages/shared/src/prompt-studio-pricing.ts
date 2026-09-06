import { type ModelPriceUsdPerMTok } from './assist-tiers';
import { LLM_PRICING_WORKBOOK, llmPricingRecord } from './llm-pricing-workbook';

/**
 * Boards Prompt Studio is a short visual-prompt writer, not a general chat
 * surface.  These are product envelopes for the complete provider request
 * (system instruction + brief + refs + scene context), not the much larger
 * native context windows advertised by the model vendors.
 *
 * Runway's official guidance says clarity is more important than word count
 * and warns that overly long prompts can conflict; its examples and Kling's
 * official formula focus on a compact subject/motion/scene/camera/lighting
 * description.  The 2,400-token input envelope leaves room for our structured
 * canvas metadata while keeping that visual-prompt workflow bounded. 400
 * output tokens are a deliberately generous hard ceiling for the required JSON
 * wrapper and one to three visual sentences; the normal result is much shorter.
 */
const BOARD_PRICING_ROWS = {
  gemini: llmPricingRecord('boards_prompt_studio', 'gemini'),
  claude: llmPricingRecord('boards_prompt_studio', 'claude'),
  gpt: llmPricingRecord('boards_prompt_studio', 'gpt'),
} as const;
const BOARD_ENVELOPE = BOARD_PRICING_ROWS.gemini;

export const PROMPT_STUDIO_INPUT_TOKEN_LIMIT = BOARD_ENVELOPE.maxTokenBudget.input;
export const PROMPT_STUDIO_OUTPUT_TOKEN_LIMIT = BOARD_ENVELOPE.maxTokenBudget.output;
/**
 * End-user brief/result caps follow the strictest mainstream image/video
 * prompt field we found (Runway Gen-4: 1,000 characters). They are separate
 * from the larger serialized-request budget above, which also carries our
 * system instructions, reference labels and fitted scene metadata.
 */
export const PROMPT_STUDIO_BRIEF_CHAR_LIMIT = BOARD_ENVELOPE.briefCharLimit;
export const PROMPT_STUDIO_RESULT_CHAR_LIMIT = BOARD_ENVELOPE.resultCharLimit;
/** Conservative multilingual estimate; Cyrillic/Asian text can tokenize densely. */
export const PROMPT_STUDIO_CHARS_PER_TOKEN = BOARD_ENVELOPE.charsPerToken;

/** Planning-only typical use; billing is always protected by max budgets. */
export const PROMPT_STUDIO_AVERAGE_TOKEN_BUDGET = {
  ...BOARD_ENVELOPE.typicalTokenBudget,
} as const;

export const PROMPT_STUDIO_MAX_TOKEN_BUDGET = {
  input: PROMPT_STUDIO_INPUT_TOKEN_LIMIT,
  output: PROMPT_STUDIO_OUTPUT_TOKEN_LIMIT,
} as const;

export type PromptStudioModel = 'claude' | 'gpt' | 'gemini';

export interface PromptStudioModelPricing {
  /** Provider slug used by the fallback gateway. */
  model: string;
  /** Kie is attempted first; this is the primary-leg reference price. */
  primaryPriceUsdPerMTok: ModelPriceUsdPerMTok;
  /** OpenRouter fallback; this is the conservative price basis. */
  fallbackPriceUsdPerMTok: ModelPriceUsdPerMTok;
  averageTokenBudget: typeof PROMPT_STUDIO_AVERAGE_TOKEN_BUDGET;
  maxTokenBudget: typeof PROMPT_STUDIO_MAX_TOKEN_BUDGET;
}

/**
 * Per-selector pricing inputs. The max-envelope cost basis includes the Kie
 * primary plus one pre-result OpenRouter fallback attempt. This is conservative
 * if Kie has already consumed billable tokens before failing; a healthy Kie
 * route with no fallback is upside, never an assumption.
 *
 * The workbook applies its signed direct landed FX to Kie and its signed
 * OpenRouter landed FX to fallback. Unit prices, FX and product envelopes all
 * arrive through the generated «LLM ЦЕНЫ» export; this file supplies no manual
 * financial inputs.
 */
export const PROMPT_STUDIO_PRICING: Record<PromptStudioModel, PromptStudioModelPricing> = {
  claude: {
    model: BOARD_PRICING_ROWS.claude.model,
    primaryPriceUsdPerMTok: BOARD_PRICING_ROWS.claude.primaryPriceUsdPerMTok,
    fallbackPriceUsdPerMTok: BOARD_PRICING_ROWS.claude.fallbackPriceUsdPerMTok,
    averageTokenBudget: PROMPT_STUDIO_AVERAGE_TOKEN_BUDGET,
    maxTokenBudget: PROMPT_STUDIO_MAX_TOKEN_BUDGET,
  },
  gpt: {
    model: BOARD_PRICING_ROWS.gpt.model,
    primaryPriceUsdPerMTok: BOARD_PRICING_ROWS.gpt.primaryPriceUsdPerMTok,
    fallbackPriceUsdPerMTok: BOARD_PRICING_ROWS.gpt.fallbackPriceUsdPerMTok,
    averageTokenBudget: PROMPT_STUDIO_AVERAGE_TOKEN_BUDGET,
    maxTokenBudget: PROMPT_STUDIO_MAX_TOKEN_BUDGET,
  },
  gemini: {
    model: BOARD_PRICING_ROWS.gemini.model,
    primaryPriceUsdPerMTok: BOARD_PRICING_ROWS.gemini.primaryPriceUsdPerMTok,
    fallbackPriceUsdPerMTok: BOARD_PRICING_ROWS.gemini.fallbackPriceUsdPerMTok,
    averageTokenBudget: PROMPT_STUDIO_AVERAGE_TOKEN_BUDGET,
    maxTokenBudget: PROMPT_STUDIO_MAX_TOKEN_BUDGET,
  },
};

export type PromptStudioBudgetKind = 'average' | 'max';
export type PromptStudioCostBasis = 'primary' | 'fallback' | 'worst_case_route';

export function promptStudioCostUsd(
  model: PromptStudioModel,
  budget: PromptStudioBudgetKind = 'max',
  basis: PromptStudioCostBasis = 'worst_case_route',
): number {
  const spec = PROMPT_STUDIO_PRICING[model];
  const tokenBudget = spec[budget === 'max' ? 'maxTokenBudget' : 'averageTokenBudget'];
  const costFor = (unitPrice: ModelPriceUsdPerMTok) =>
    (tokenBudget.input * unitPrice.input + tokenBudget.output * unitPrice.output) / 1_000_000;
  if (basis === 'primary') return costFor(spec.primaryPriceUsdPerMTok);
  if (basis === 'fallback') return costFor(spec.fallbackPriceUsdPerMTok);
  // A Kie request can fail after provider work has started, then the route may
  // make one OpenRouter fallback call. Price both legs so the one customer
  // charge still covers the worst provider spend.
  return costFor(spec.primaryPriceUsdPerMTok) + costFor(spec.fallbackPriceUsdPerMTok);
}

/** Credits are derived from the conservative max-envelope two-leg route. */
export function promptStudioCreditsFor(model: PromptStudioModel): number {
  const spec = PROMPT_STUDIO_PRICING[model];
  const tokenBudget = spec.maxTokenBudget;
  const primaryUsd =
    (tokenBudget.input * spec.primaryPriceUsdPerMTok.input +
      tokenBudget.output * spec.primaryPriceUsdPerMTok.output) /
    1_000_000;
  const fallbackUsd =
    (tokenBudget.input * spec.fallbackPriceUsdPerMTok.input +
      tokenBudget.output * spec.fallbackPriceUsdPerMTok.output) /
    1_000_000;
  const costRub =
    primaryUsd * LLM_PRICING_WORKBOOK.financial.landedRubPerUsdDirect +
    fallbackUsd * LLM_PRICING_WORKBOOK.financial.landedRubPerUsdOpenRouter;
  const revenuePerCredit =
    LLM_PRICING_WORKBOOK.financial.creditFloorRub *
    (1 - LLM_PRICING_WORKBOOK.financial.marginFloor);
  return Math.ceil(costRub / revenuePerCredit);
}

export const PROMPT_STUDIO_CREDITS: Record<PromptStudioModel, number> = {
  gemini: BOARD_PRICING_ROWS.gemini.credits,
  claude: BOARD_PRICING_ROWS.claude.credits,
  gpt: BOARD_PRICING_ROWS.gpt.credits,
};

/** Gross margin at the cheapest credit revenue floor and worst route spend. */
export function promptStudioMarginAtFloor(model: PromptStudioModel): number {
  const revenueRub = PROMPT_STUDIO_CREDITS[model] * LLM_PRICING_WORKBOOK.financial.creditFloorRub;
  const spec = PROMPT_STUDIO_PRICING[model];
  const tokenBudget = spec.maxTokenBudget;
  const primaryUsd =
    (tokenBudget.input * spec.primaryPriceUsdPerMTok.input +
      tokenBudget.output * spec.primaryPriceUsdPerMTok.output) /
    1_000_000;
  const fallbackUsd =
    (tokenBudget.input * spec.fallbackPriceUsdPerMTok.input +
      tokenBudget.output * spec.fallbackPriceUsdPerMTok.output) /
    1_000_000;
  const costRub =
    primaryUsd * LLM_PRICING_WORKBOOK.financial.landedRubPerUsdDirect +
    fallbackUsd * LLM_PRICING_WORKBOOK.financial.landedRubPerUsdOpenRouter;
  return 1 - costRub / revenueRub;
}
