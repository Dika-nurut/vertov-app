import { describe, expect, it } from 'vitest';
import {
  derivedCostUsd,
  KIE_CLAUDE_SONNET5_PRICE_USD_PER_MTOK,
  KIE_GPT56_TERRA_PRICE_USD_PER_MTOK,
  MODEL_PRICES_USD_PER_MTOK,
  mergeAiUsage,
  parseAnthropicUsage,
  parseOpenAiUsage,
  parseResponsesUsage,
} from '../src/index';

describe('AI usage parsers', () => {
  it('parses an OpenRouter chat-completions usage frame including cache, reasoning, and cost', () => {
    expect(
      parseOpenAiUsage({
        usage: {
          prompt_tokens: 120,
          completion_tokens: 34,
          prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
          completion_tokens_details: { reasoning_tokens: 8 },
          cost: 0.004,
        },
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 34,
      cacheReadTokens: 50,
      cacheWriteTokens: 30,
      reasoningTokens: 8,
      costUsd: 0.004,
    });
  });

  it('distinguishes a missing usage object from reported zero tokens', () => {
    expect(parseOpenAiUsage({ choices: [] })).toBeNull();
    expect(parseOpenAiUsage({ usage: { prompt_tokens: 0 } })?.inputTokens).toBe(0);
  });

  it('rejects hostile token values without rejecting the whole usage object', () => {
    for (const value of ['abc', -5, Number.NaN, Infinity, 12.5, 3_000_000_000]) {
      expect(parseOpenAiUsage({ usage: { prompt_tokens: value } })?.inputTokens).toBeNull();
    }
  });

  it('parses Anthropic streaming usage and merges final output without erasing input counts', () => {
    const start = parseAnthropicUsage({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 200,
          output_tokens: 1,
          cache_read_input_tokens: 150,
          cache_creation_input_tokens: 20,
        },
      },
    });
    const delta = parseAnthropicUsage({ type: 'message_delta', usage: { output_tokens: 42 } });
    expect(mergeAiUsage(start, delta)).toEqual({
      inputTokens: 200,
      outputTokens: 42,
      cacheReadTokens: 150,
      cacheWriteTokens: 20,
      reasoningTokens: null,
      costUsd: null,
    });
    expect(
      mergeAiUsage(start, parseAnthropicUsage({ type: 'message_delta', usage: {} })),
    ).toMatchObject({
      inputTokens: 200,
    });
  });

  it('parses a Responses usage object', () => {
    expect(
      parseResponsesUsage({
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 7 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    ).toMatchObject({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 7, reasoningTokens: 3 });
  });

  it('does not persist an Anthropic message_start placeholder output when the stream truncates', () => {
    expect(
      parseAnthropicUsage({
        type: 'message_start',
        message: { usage: { input_tokens: 200, output_tokens: 1, cache_read_input_tokens: 50 } },
      }),
    ).toMatchObject({ inputTokens: 200, cacheReadTokens: 50, outputTokens: null });
  });

  it('prices kie Claude with its route price rather than the OpenRouter fallback price', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      costUsd: null,
    };
    const kieCost = derivedCostUsd('kie_claude', 'anthropic/claude-sonnet-5', usage);
    const openRouterCost =
      MODEL_PRICES_USD_PER_MTOK['anthropic/claude-sonnet-5']!.input +
      MODEL_PRICES_USD_PER_MTOK['anthropic/claude-sonnet-5']!.output;
    expect(kieCost).toBe(
      KIE_CLAUDE_SONNET5_PRICE_USD_PER_MTOK.input + KIE_CLAUDE_SONNET5_PRICE_USD_PER_MTOK.output,
    );
    expect(kieCost).not.toBe(openRouterCost);
    expect(derivedCostUsd('kie_responses', 'openai/gpt-5.6-terra', usage)).toBe(
      KIE_GPT56_TERRA_PRICE_USD_PER_MTOK.input + KIE_GPT56_TERRA_PRICE_USD_PER_MTOK.output,
    );
    expect(
      derivedCostUsd('kie_claude', 'anthropic/claude-sonnet-5', {
        ...usage,
        inputTokens: null,
      }),
    ).toBeNull();
  });
});
