import {
  KIE_CLAUDE_SONNET5_PRICE_USD_PER_MTOK,
  KIE_GEMINI3_FLASH_PRICE_USD_PER_MTOK,
  KIE_GPT56_TERRA_PRICE_USD_PER_MTOK,
  MODEL_PRICES_USD_PER_MTOK,
} from './assist-tiers';

export type AiRoute = 'openrouter' | 'kie_gemini' | 'kie_claude' | 'kie_responses';

export type AiUsageOp =
  | 'assist'
  | 'conspect'
  | 'material_compaction'
  | 'structurize'
  | 'prompt_studio'
  | 'prompt_enhancer'
  | 'scene_objects'
  | 'scenario_shot_plan';

export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Tokens served from the provider's prompt cache — the 0.2 probe's signal. */
  cacheReadTokens: number | null;
  /** Tokens written INTO the cache on this call (Anthropic reports it separately). */
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** Provider-reported USD for this call, when the gateway returns one. */
  costUsd: number | null;
}

/** One HTTP attempt against one gateway. The unit of the ai_usage_events table. */
export interface AiCallAttempt {
  route: AiRoute;
  /** The model slug we asked for (kie legs: the slug the router dispatched on). */
  model: string;
  /** 1-based, counted across ALL legs and retries of one logical request. */
  attempt: number;
  /** TRANSPORT outcome only. */
  outcome: 'ok' | 'error' | 'empty';
  usage: AiUsage | null;
  /** True only when a provider-supported cache marker was actually sent. */
  cacheMarkersSent?: boolean;
  /** Truncated to 300 chars. Never contains a secret — do not log request bodies. */
  errorMessage?: string;
}

const emptyUsage = (): AiUsage => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  costUsd: null,
});

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function token(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : null;
}

function cost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseOpenAiUsage(payload: unknown): AiUsage | null {
  const usage = object(object(payload)?.usage);
  if (!usage) return null;
  const promptDetails = object(usage.prompt_tokens_details);
  const completionDetails = object(usage.completion_tokens_details);
  return {
    ...emptyUsage(),
    inputTokens: token(usage.prompt_tokens),
    outputTokens: token(usage.completion_tokens),
    cacheReadTokens: token(promptDetails?.cached_tokens),
    cacheWriteTokens: token(promptDetails?.cache_write_tokens),
    reasoningTokens: token(completionDetails?.reasoning_tokens),
    costUsd: cost(usage.cost),
  };
}

export function parseAnthropicUsage(payload: unknown): AiUsage | null {
  const frame = object(payload);
  const usage = object(frame?.usage) ?? object(object(frame?.message)?.usage);
  if (!usage) return null;
  return {
    ...emptyUsage(),
    inputTokens: token(usage.input_tokens),
    outputTokens: frame?.type === 'message_start' ? null : token(usage.output_tokens),
    cacheReadTokens: token(usage.cache_read_input_tokens),
    cacheWriteTokens: token(usage.cache_creation_input_tokens),
  };
}

export function parseResponsesUsage(payload: unknown): AiUsage | null {
  const usage = object(object(payload)?.usage);
  if (!usage) return null;
  const inputDetails = object(usage.input_tokens_details);
  const outputDetails = object(usage.output_tokens_details);
  return {
    ...emptyUsage(),
    inputTokens: token(usage.input_tokens),
    outputTokens: token(usage.output_tokens),
    cacheReadTokens: token(inputDetails?.cached_tokens),
    reasoningTokens: token(outputDetails?.reasoning_tokens),
  };
}

/** Fold a later frame's usage into an earlier one. Later non-null values win. */
export function mergeAiUsage(prev: AiUsage | null, next: AiUsage | null): AiUsage | null {
  if (!prev) return next;
  if (!next) return prev;
  return {
    inputTokens: next.inputTokens ?? prev.inputTokens,
    outputTokens: next.outputTokens ?? prev.outputTokens,
    cacheReadTokens: next.cacheReadTokens ?? prev.cacheReadTokens,
    cacheWriteTokens: next.cacheWriteTokens ?? prev.cacheWriteTokens,
    reasoningTokens: next.reasoningTokens ?? prev.reasoningTokens,
    costUsd: next.costUsd ?? prev.costUsd,
  };
}

export function derivedCostUsd(route: AiRoute, model: string, usage: AiUsage): number | null {
  const price =
    route === 'openrouter'
      ? MODEL_PRICES_USD_PER_MTOK[model]
      : route === 'kie_gemini' && model === 'google/gemini-3-flash-preview'
        ? KIE_GEMINI3_FLASH_PRICE_USD_PER_MTOK
        : route === 'kie_claude' && model === 'anthropic/claude-sonnet-5'
          ? KIE_CLAUDE_SONNET5_PRICE_USD_PER_MTOK
          : route === 'kie_responses' && model === 'openai/gpt-5.6-terra'
            ? KIE_GPT56_TERRA_PRICE_USD_PER_MTOK
            : null;
  if (!price) return null;
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  // Workbook rows intentionally contain no unverified cache discount. Split
  // the provider's input total into uncached/read/write buckets for audit, but
  // price every bucket at the conservative uncached input rate. A future
  // verified cache-rate column can change only these bucket multipliers; it
  // must never make the pre-call quote cheaper by assumption.
  const cacheRead = Math.min(input, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.min(Math.max(0, input - cacheRead), usage.cacheWriteTokens ?? 0);
  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  const inputCost = (uncached + cacheRead + cacheWrite) * price.input;
  return (inputCost + output * price.output) / 1_000_000;
}
