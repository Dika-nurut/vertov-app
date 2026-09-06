import { LLM_PRICING_WORKBOOK, llmModelPrice, llmPricingRecord } from './llm-pricing-workbook';

/**
 * «Сценарий» assist tiers — the user-facing model picker (Экономный /
 * Стандарт / Максимум) for screenplay co-writing calls via OpenRouter.
 *
 * Pricing doctrine (research/archive/scenario-canvas-goal-2026-07.md):
 *  - one flat credit price per (tier × context band) so the UX reads simply;
 *  - anchored (span) calls send span + enclosing scene + библия + scene
 *    index — bounded, NOT the whole script;
 *  - whole-script commands are explicit and priced higher per tier;
 *  - active context-band quotes use the workbook's 25% no-cache gross-margin
 *    floor at the worst-case revenue floor (cheapest ₽/credit across
 *    subscription tiers), enforced by the workbook guardrail tests. The older
 *    flat rows and their 7% policy remain replay/import compatibility only.
 *
 * Vendor rates and token budgets come from the generated export of the
 * workbook's «LLM ЦЕНЫ» sheet. Defaults were chosen for RU prose quality
 * (validated by the
 * RU screenplay eval in research/archive/scenario-canvas-assist-eval-2026-07.md);
 * candidates listed for future re-evaluation.
 */

export type AssistTierId = 'economy' | 'standard' | 'max';
export type AssistScope = 'project' | 'span' | 'scene' | 'script';

export interface AssistTier {
  id: AssistTierId;
  labelRu: string;
  /** OpenRouter model slug used verbatim. */
  model: string;
  /** Evaluated alternatives, best-first, for manual re-pointing. */
  candidates: string[];
  /** Flat credit price per call by scope. */
  creditsPerCall: Record<AssistScope, number>;
  /** OpenRouter catalog price, USD per 1M tokens (guardrail input). */
  priceUsdPerMTok: { input: number; output: number };
  /**
   * Send `reasoning: {enabled:false}` — reasoning-by-default models
   * (deepseek v4, gpt-5 family) otherwise burn the whole max_tokens on
   * hidden thinking and stream zero content (live smoke, 2026-07-02).
   */
  disableReasoning?: boolean;
}

/**
 * Worst-case token budgets per call. `output` is the hard `max_tokens` cap
 * on the completion. `input` is the REAL ceiling of everything we can send —
 * the SUM of every section's own char cap, materials INCLUDED, at 3 chars/tok:
 *
 *   base prompt + МИР ПРОЕКТА notes (8k) + materials (20k) + verbatim window
 *   (9k) + question (8k) + scene index (5k) + { span: enclosing scene 12k +
 *   selected fragment 4k | script: whole-script text 200k = ~120 pages }.
 *
 * Every one of those sections is HARD-clamped server-side, so a real call can
 * never exceed this — a long question, a full МИР ПРОЕКТА, a 2 MB screenplay
 * cannot push a call into the red. The workbook formulas use these exact
 * budgets, so raising a clamp requires a workbook update and regenerated export.
 */
export const ASSIST_TOKEN_BUDGET: Record<AssistScope, { input: number; output: number }> = {
  project: { ...llmPricingRecord('scenario_assist_price', 'economy/project').maxTokenBudget },
  span: { ...llmPricingRecord('scenario_assist_price', 'economy/span').maxTokenBudget },
  scene: { ...llmPricingRecord('scenario_assist_price', 'economy/scene').maxTokenBudget },
  script: { ...llmPricingRecord('scenario_assist_price', 'economy/script').maxTokenBudget },
};

/** RU chars-per-token estimate. */
export const ASSIST_CHARS_PER_TOKEN = 3;

/** «Материалы проекта» hard ceiling on total chars injected per call. */
export const MATERIALS_MAX_CHARS = 20_000;

/**
 * МИР ПРОЕКТА = the editor's memory, read on every turn. To keep that read
 * cheap even at maximum fill, the flat `notes` list is clamped to this many
 * chars per call (like materials already are). Notes past the ceiling are
 * dropped from the prompt in author order — the ceiling should rarely bind.
 */
export const MEMORY_NOTES_MAX_CHARS = 8_000;

/**
 * Background file compaction (МИР ПРОЕКТА memory). Files larger than
 * `MATERIAL_SUMMARY_MIN_RAW_CHARS` are summarized by the economy model on
 * upload into a `summary` of at most `MATERIAL_SUMMARY_MAX_CHARS` chars —
 * ALWAYS shorter than the raw text — which is injected in the raw file's place
 * every turn. Small files are cheap enough to inject whole (no summary).
 */
export const MATERIAL_SUMMARY_MIN_RAW_CHARS = 1_500;
export const MATERIAL_SUMMARY_MAX_CHARS = 1_500;
const MATERIAL_COMPACTION_WORKBOOK = llmPricingRecord('scenario_material_compaction', 'background');
export const MATERIAL_COMPACTION_INPUT_TOKEN_LIMIT =
  MATERIAL_COMPACTION_WORKBOOK.maxTokenBudget.input;
export const MATERIAL_COMPACTION_OUTPUT_TOKEN_LIMIT =
  MATERIAL_COMPACTION_WORKBOOK.maxTokenBudget.output;

/**
 * Rolling-conспект generation is a cheap economy-model op folded into every
 * turn (~$0.0002 typical). Charged into the guardrail as a flat per-call
 * overhead so the margin math never pretends memory is free.
 */
export const CONSPECT_INPUT_TOKEN_LIMIT =
  LLM_PRICING_WORKBOOK.financial.scenarioConspectTokenBudget.input;
export const CONSPECT_OUTPUT_TOKEN_LIMIT =
  LLM_PRICING_WORKBOOK.financial.scenarioConspectTokenBudget.output;
export const CONSPECT_MAX_ATTEMPTS = LLM_PRICING_WORKBOOK.financial.scenarioConspectMaxAttempts;

/**
 * Materials surcharge in credits, by tier. Now ZERO on every tier: the
 * worst-case materials ceiling is baked straight into the base scope price
 * (ASSIST_TOKEN_BUDGET.input already includes the 20k materials budget), so
 * attaching files never changes what a call costs. Owner pricing 2026-07-08:
 * one price per (tier × scope), no separate materials step — simpler path
 * for the client (variant B). Kept as a table so `assistPrice` and callers
 * stay stable if a future tier ever needs a real surcharge again.
 */
export const MATERIALS_SURCHARGE: Record<AssistTierId, number> = {
  economy: 0,
  standard: 0,
  max: 0,
};

/**
 * Server-computed price of one assist call, in credits. Just the base scope
 * price now (materials are baked in — see MATERIALS_SURCHARGE). The client
 * mirrors this in the ask button («Спросить · N кр») but NEVER computes the
 * charge — the server is the source of truth.
 */
export function assistPrice(tier: AssistTier, scope: AssistScope, hasMaterials: boolean): number {
  return tier.creditsPerCall[scope] + (hasMaterials ? MATERIALS_SURCHARGE[tier.id] : 0);
}

export type ModelPriceUsdPerMTok = { input: number; output: number };

/**
 * The pricing calculator's settings — the THREE knobs that turn a model's
 * catalog $-price into a credit price. Change a model, its $-price, or a token
 * budget and the credit prices below re-derive themselves; these stay put.
 */
export const ASSIST_PRICING = {
  /**
   * Cheapest ₽ a subscription credit is ever sold for (the subscription
   * catalog floor). Prices are set against this so they hold on EVERY plan.
   * assist-tiers.test.ts asserts it still matches the live catalog.
   */
  creditFloorRub: LLM_PRICING_WORKBOOK.financial.creditFloorRub,
  /**
   * Legacy flat-row Scenario gross-margin floor. Active Scenario context bands
   * and structurize rows use `scenarioBandMarginFloor` (25%) instead; this
   * 7% value remains only so historical flat-row imports/replays are stable.
   */
  marginFloor: LLM_PRICING_WORKBOOK.financial.scenarioMarginFloor,
  /**
   * Honest landed cost of $1 of gateway spend: CBR rate × OpenRouter top-up
   * (5.5%) × payment corridor × 18.03% agent VAT (Vertov_Pricing_Model.xlsx,
   * «ПОЛНАЯ СЕБЕСТОИМОСТЬ $1 через OpenRouter»). NOT the bare FX rate.
   *
   * This is the OpenRouter leg, because every assist model runs there. It was
   * 95.56 — the retired 76.5-basis figure — long after v14 re-based the landed
   * rate to 106.182. Assist is pure cost-plus at the margin floor, so the stale
   * number did not merely misreport: it under-priced every «Сценарий» call by
   * ~11% against what the dollar actually costs us. `@seed/db`'s `GATEWAY_FX_RUB` is
   * the source; a CI guard pins the two together, because this package cannot
   * import from `@seed/db` without a dependency cycle.
   */
  landedRubPerUsd: LLM_PRICING_WORKBOOK.financial.landedRubPerUsdOpenRouter,
} as const;

/**
 * Cost of one OpenRouter attempt in USD for a given model and scope. Product
 * prices use the workbook route rows below because those additionally cover
 * Kie, OpenRouter retries and rolling-conспект.
 */
export function assistCostUsd(price: ModelPriceUsdPerMTok, scope: AssistScope): number {
  const budget = ASSIST_TOKEN_BUDGET[scope];
  return (budget.input * price.input + budget.output * price.output) / 1_000_000;
}

export function assistCostUsdForBudget(
  budget: { input: number; output: number },
  price: { input: number; output: number },
): number {
  return (budget.input * price.input + budget.output * price.output) / 1e6;
}

/**
 * Legacy single-OpenRouter-leg calculator retained for generic bounded helpers
 * and comparison tests. Scenario sell prices do not use this shortcut; they
 * come from workbook route rows that include all permitted attempts.
 */
export function assistCreditsFor(price: ModelPriceUsdPerMTok, scope: AssistScope): number {
  return creditsForCostUsd(assistCostUsd(price, scope));
}

/**
 * The floor→credits step of the calculator, factored out so any bounded
 * provider op (assist scopes, structurization, future one-shots) prices itself
 * by the SAME fail-closed rule: land at or above the selected margin floor at the
 * cheapest credit price. `ceil` so we never under-charge. Given a worst-case
 * USD cost, return the credits to bill.
 */
export function creditsForCostUsd(
  costUsd: number,
  marginFloor = ASSIST_PRICING.marginFloor,
): number {
  const costRub = costUsd * ASSIST_PRICING.landedRubPerUsd;
  const revenuePerCredit = ASSIST_PRICING.creditFloorRub * (1 - marginFloor);
  return Math.ceil(costRub / revenuePerCredit);
}

/**
 * Runtime lookup for model token cost. The authoritative rate is maintained in
 * the workbook's «LLM ЦЕНЫ» sheet and reaches this map through the generated
 * export. To put a new model on a tier, add its conservative $/1M-token rate to
 * the workbook and regenerate the export first.
 *
 * ⚠️ The workbook rate is the number that reflects the actual cost of a model.
 * Everything else is arithmetic on top of it. If the workbook value is
 * ≥ the model's true price, the selected signed floor remains protected;
 * if it understates the true price, no amount of formula saves us — so keep it
 * honest and conservative. Prices are OpenRouter $/1M tokens (input/output).
 */
const workbookModel = (model: string): ModelPriceUsdPerMTok => llmModelPrice(model);

export const MODEL_PRICES_USD_PER_MTOK: Record<string, ModelPriceUsdPerMTok> = {
  'deepseek/deepseek-v4-flash': workbookModel('deepseek/deepseek-v4-flash'),
  'qwen/qwen3.5-plus-02-15': workbookModel('qwen/qwen3.5-plus-02-15'),
  'google/gemini-2.5-flash': workbookModel('google/gemini-2.5-flash'),
  // Standard tier (kie-primary since 2026-07-24): the live route goes FIRST to
  // the kie.ai Gemini chat API ($0.15/$0.90 per 1M tok — see
  // KIE_GEMINI3_FLASH_PRICE_USD_PER_MTOK below), OpenRouter only as the
  // automatic fallback (script-assist.ts streamAssistCompletion). The OR price
  // stays HERE as the cost basis: it is the conservative worst case (the
  // fallback leg), so routing primary to cheaper kie only improves margin.
  'google/gemini-3-flash-preview': workbookModel('google/gemini-3-flash-preview'),
  // Max tier (kie-primary since 2026-07-24): the live route goes FIRST to the
  // kie.ai Claude endpoint ($0.85/$4.275 per 1M tok — see
  // KIE_CLAUDE_SONNET5_PRICE_USD_PER_MTOK below), OpenRouter only as the
  // automatic fallback (script-assist.ts streamAssistCompletion). The OR price
  // stays HERE as the cost basis: it is the conservative worst case (the
  // fallback leg), so routing primary to cheaper kie only improves margin.
  'anthropic/claude-sonnet-5': workbookModel('anthropic/claude-sonnet-5'),
  // Boards Prompt Studio GPT-5.6 Terra fallback leg. Keeping this slug in the
  // shared catalog lets usage-cost reconstruction use the same source as the
  // selector pricing calculator.
  'openai/gpt-5.6-terra': workbookModel('openai/gpt-5.6-terra'),
  // Register a model in «LLM ЦЕНЫ» before pointing a tier at it.
};

/**
 * kie.ai unit price for the standard tier's Gemini 3 Flash (owner-provided,
 * 2026-07-24) — the PRIMARY leg of that tier's text route (OpenRouter is the
 * automatic fallback; routing lives in apps/api/src/script-assist.ts +
 * kie-chat.ts). NOT the cost basis for credit pricing: MODEL_PRICES keeps the
 * OpenRouter $0.50/$3.00 as the conservative worst case, so this is reference
 * data only (shown in the admin panel) and never feeds assistCreditsFor.
 */
export const KIE_GEMINI3_FLASH_PRICE_USD_PER_MTOK: ModelPriceUsdPerMTok = {
  ...llmPricingRecord('boards_prompt_studio', 'gemini').primaryPriceUsdPerMTok,
};

/**
 * kie.ai unit price for the max tier's Claude Sonnet 5 (owner-provided,
 * 2026-07-24) — the PRIMARY leg of that tier's text route (same router +
 * fallback as the Gemini leg). NOT the cost basis for credit pricing:
 * MODEL_PRICES keeps the OpenRouter $2.00/$10.00 as the conservative worst
 * case, so this is reference data only (shown in the admin panel) and never
 * feeds assistCreditsFor.
 */
export const KIE_CLAUDE_SONNET5_PRICE_USD_PER_MTOK: ModelPriceUsdPerMTok = {
  ...llmPricingRecord('boards_prompt_studio', 'claude').primaryPriceUsdPerMTok,
};

/** kie.ai primary price for Boards Prompt Studio GPT-5.6 Terra. */
export const KIE_GPT56_TERRA_PRICE_USD_PER_MTOK: ModelPriceUsdPerMTok = {
  ...llmPricingRecord('boards_prompt_studio', 'gpt').primaryPriceUsdPerMTok,
};

/**
 * Fail-closed price lookup. An unregistered model slug is a HARD ERROR at
 * module load — never a silent guess. This is what makes "swap the model
 * tomorrow" safe: change a tier's `model` to an unregistered slug and the app
 * refuses to start until you register that model's real cost, so a tier can
 * never be priced against a stale or made-up number.
 */
export function modelPrice(slug: string): ModelPriceUsdPerMTok {
  const price = MODEL_PRICES_USD_PER_MTOK[slug];
  if (!price) {
    throw new Error(
      `assist-tiers: no registered token price for model "${slug}". Add its OpenRouter ` +
        `$/1M price to workbook sheet «LLM ЦЕНЫ» before pricing a tier on it.`,
    );
  }
  return price;
}

/** A tier's declared inputs — model by slug; its $-price AND credits are derived. */
type AssistTierSpec = Omit<AssistTier, 'creditsPerCall' | 'priceUsdPerMTok'>;

const TIER_SPECS: AssistTierSpec[] = [
  {
    id: 'economy',
    labelRu: 'Экономный',
    model: 'qwen/qwen3.5-plus-02-15',
    candidates: [
      'qwen/qwen3.5-plus-02-15',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-v4-flash',
    ],
    disableReasoning: true,
  },
  {
    id: 'standard',
    labelRu: 'Стандарт',
    model: 'google/gemini-3-flash-preview',
    candidates: ['google/gemini-3-flash-preview', 'deepseek/deepseek-v3.2', 'openai/gpt-5-mini'],
    disableReasoning: true,
  },
  {
    id: 'max',
    labelRu: 'Максимум',
    model: 'anthropic/claude-sonnet-5',
    candidates: ['anthropic/claude-sonnet-5', 'openai/gpt-5.1', 'google/gemini-2.5-pro'],
  },
];

/**
 * Tiers, fully workbook-derived: model, budgets, routes, attempts and final
 * credits are signed on «LLM ЦЕНЫ». No runtime sell-price table remains.
 */
export const ASSIST_TIERS: AssistTier[] = TIER_SPECS.map((spec) => {
  const priceUsdPerMTok = modelPrice(spec.model);
  const workbookCredits = (scope: AssistScope) =>
    llmPricingRecord('scenario_assist_price', `${spec.id}/${scope}`).credits;
  return {
    ...spec,
    priceUsdPerMTok,
    creditsPerCall: {
      project: workbookCredits('project'),
      span: workbookCredits('span'),
      scene: workbookCredits('scene'),
      script: workbookCredits('script'),
    },
  };
});

export function assistTier(id: string): AssistTier | undefined {
  return ASSIST_TIERS.find((t) => t.id === id);
}

/**
 * Worst-case provider cost of one call, USD (tier convenience wrapper over
 * `assistCostUsd`). `hasMaterials` no longer changes cost — the materials
 * ceiling is already inside the budget — but the param stays for the guardrail.
 */
export function assistCallCostUsd(
  tier: AssistTier,
  scope: AssistScope,
  _hasMaterials = false,
): number {
  const row = llmPricingRecord('scenario_assist_price', `${tier.id}/${scope}`);
  const primary =
    (row.primaryMaxAttempts *
      (row.maxTokenBudget.input * row.primaryPriceUsdPerMTok.input +
        row.maxTokenBudget.output * row.primaryPriceUsdPerMTok.output)) /
    1_000_000;
  const fallback =
    (row.fallbackMaxAttempts *
      (row.maxTokenBudget.input * row.fallbackPriceUsdPerMTok.input +
        row.maxTokenBudget.output * row.fallbackPriceUsdPerMTok.output)) /
    1_000_000;
  const economy = llmPricingRecord('scenario_assist_price', 'economy/project');
  const conspect =
    (CONSPECT_MAX_ATTEMPTS *
      (CONSPECT_INPUT_TOKEN_LIMIT * economy.primaryPriceUsdPerMTok.input +
        CONSPECT_OUTPUT_TOKEN_LIMIT * economy.primaryPriceUsdPerMTok.output)) /
    1_000_000;
  return primary + fallback + conspect;
}

/* ---------------------------------------------------------------------------
 * Structurization (goal S1) — the ONE call that turns a rough idea (or pasted
 * screenplay) into {format, brief, outline}. Priced by the SAME fail-closed
 * calculator, but on its OWN budget and ALWAYS on the economy model regardless
 * of the user's tier (decision #4: "cheap by construction"). Cache savings are
 * upside only — the price is derived from the UNCACHED worst case (invariant B3).
 * ------------------------------------------------------------------------- */

/**
 * Structurization always routes to the economy model, whatever the user's tier.
 * Deliberately NOT gated on the economy tier's admin ON/OFF switch
 * (assist_tier_states, 2026-07-24): structurization is the S1 pipeline surface
 * (idea → outline), not the tier picker — switching «Экономный» off for assist
 * chat must not break idea structurization (or the internal conспект/material
 * compaction calls, which likewise use the economy MODEL, never a user tier).
 */
export const STRUCTURIZE_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * Max gateway attempts for ONE structurization (first call + schema-fail
 * retries). A COMMITTED result can have cost up to this many full provider
 * calls, so the price below MUST cover them — otherwise a two-attempt success
 * would break the margin floor and let real provider spend outrun the daily cap.
 * The route clamps its own attempt budget to this value so we can never make
 * more calls than we priced (fail-closed).
 */
export const STRUCTURIZE_MAX_ATTEMPTS = LLM_PRICING_WORKBOOK.financial.structurizeMaxAttempts;

/**
 * Worst-case token budget for one structurization. Fail-closed by BYTES, not a
 * chars/token guess: a BPE token is at least one byte, so tokens ≤ UTF-8
 * byteLength for ANY input (dense Cyrillic, emoji, adversarial Unicode included).
 * The route caps the assembled prompt's byte length to `input`, so real input
 * tokens can never exceed it. `input` = the system playbook (~6.1 KB) + the
 * byte-capped source (`STRUCTURIZE_SOURCE_MAX_BYTES`) + wrapper, with margin.
 * `output` hard-caps the JSON completion. This is what keeps the derived price —
 * and the daily-spend reservation, which uses the same cost — truly fail-closed.
 */
export const STRUCTURIZE_TOKEN_BUDGET: { input: number; output: number } = {
  ...llmPricingRecord('scenario_structurize_active', 'economy/active').maxTokenBudget,
};

/**
 * Hard cap on the UTF-8 byte length of the source handed to the model. Chosen so
 * the full assembled prompt (system + wrapper + source) stays under
 * `STRUCTURIZE_TOKEN_BUDGET.input` bytes → tokens ≤ that budget for any input.
 * The route byte-truncates to this; the idempotency fingerprint still uses the
 * COMPLETE input, so truncation never lets a changed revision replay.
 */
export const STRUCTURIZE_SOURCE_MAX_BYTES = 32_000;

/**
 * Worst-case provider cost of ONE gateway call in a structurization, USD. Pure —
 * no rolling conспект (structurization is a single stateless call), so no
 * overhead term. Used by the margin guardrail; the billed price below multiplies
 * it by the retry budget.
 */
export function structurizeCostUsd(
  price: ModelPriceUsdPerMTok = modelPrice(STRUCTURIZE_MODEL),
): number {
  return (
    (STRUCTURIZE_TOKEN_BUDGET.input * price.input +
      STRUCTURIZE_TOKEN_BUDGET.output * price.output) /
    1_000_000
  );
}

/**
 * Credits billed for one structurization — exported from the active workbook
 * formula at the Scenario 25% no-cache floor, never hand-typed in runtime. Sized to the WORST-CASE
 * provider spend of a committed result: up to `STRUCTURIZE_MAX_ATTEMPTS` full
 * calls (a schema-fail retry then a success both bill the flat price, so it must
 * cover both). Swap the economy model (and register its price) and this
 * re-derives itself. Four credits from the active workbook row today.
 */
export const STRUCTURIZE_CREDITS: number = llmPricingRecord(
  'scenario_structurize_active',
  'economy/active',
).credits;

/** Active 25% workbook row for the post-rollout structurize policy. */
export const STRUCTURIZE_ACTIVE_CREDITS: number = llmPricingRecord(
  'scenario_structurize_active',
  'economy/active',
).credits;

/** Gross margin of one call at a given ₽/credit revenue rate. */
export function assistMarginAtFloor(
  tier: AssistTier,
  scope: AssistScope,
  creditFloorRub: number,
  _usdToRub: number,
  hasMaterials = false,
): number {
  const revenueRub = assistPrice(tier, scope, hasMaterials) * creditFloorRub;
  const row = llmPricingRecord('scenario_assist_price', `${tier.id}/${scope}`);
  const primaryUsd =
    (row.primaryMaxAttempts *
      (row.maxTokenBudget.input * row.primaryPriceUsdPerMTok.input +
        row.maxTokenBudget.output * row.primaryPriceUsdPerMTok.output)) /
    1_000_000;
  const fallbackUsd =
    (row.fallbackMaxAttempts *
      (row.maxTokenBudget.input * row.fallbackPriceUsdPerMTok.input +
        row.maxTokenBudget.output * row.fallbackPriceUsdPerMTok.output)) /
    1_000_000;
  const economy = llmPricingRecord('scenario_assist_price', 'economy/project');
  const conspectUsd =
    (CONSPECT_MAX_ATTEMPTS *
      (CONSPECT_INPUT_TOKEN_LIMIT * economy.primaryPriceUsdPerMTok.input +
        CONSPECT_OUTPUT_TOKEN_LIMIT * economy.primaryPriceUsdPerMTok.output)) /
    1_000_000;
  const directFx = LLM_PRICING_WORKBOOK.financial.landedRubPerUsdDirect;
  const openRouterFx = LLM_PRICING_WORKBOOK.financial.landedRubPerUsdOpenRouter;
  const costRub =
    primaryUsd * (row.primaryProvider === 'OpenRouter' ? openRouterFx : directFx) +
    fallbackUsd * (row.fallbackProvider === 'OpenRouter' ? openRouterFx : directFx) +
    conspectUsd * openRouterFx;
  return 1 - costRub / revenueRub;
}
