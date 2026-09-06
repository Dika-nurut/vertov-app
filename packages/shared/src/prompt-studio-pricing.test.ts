import { describe, expect, it } from 'vitest';
import { ASSIST_PRICING } from './assist-tiers';
import { LLM_PRICING_WORKBOOK, llmPricingRecord } from './llm-pricing-workbook';
import {
  PROMPT_STUDIO_CHARS_PER_TOKEN,
  PROMPT_STUDIO_BRIEF_CHAR_LIMIT,
  PROMPT_STUDIO_CREDITS,
  PROMPT_STUDIO_INPUT_TOKEN_LIMIT,
  PROMPT_STUDIO_OUTPUT_TOKEN_LIMIT,
  PROMPT_STUDIO_PRICING,
  PROMPT_STUDIO_RESULT_CHAR_LIMIT,
  promptStudioCostUsd,
  promptStudioCreditsFor,
  promptStudioMarginAtFloor,
} from './prompt-studio-pricing';

describe('Boards Prompt Studio pricing', () => {
  it('uses a compact visual-prompt envelope rather than a general chat budget', () => {
    expect(PROMPT_STUDIO_INPUT_TOKEN_LIMIT).toBe(2_400);
    expect(PROMPT_STUDIO_OUTPUT_TOKEN_LIMIT).toBe(400);
    expect(PROMPT_STUDIO_BRIEF_CHAR_LIMIT).toBe(1_000);
    expect(PROMPT_STUDIO_RESULT_CHAR_LIMIT).toBe(1_000);
    expect(PROMPT_STUDIO_CHARS_PER_TOKEN).toBe(1.5);
    expect(PROMPT_STUDIO_INPUT_TOKEN_LIMIT).toBeGreaterThan(2 * PROMPT_STUDIO_OUTPUT_TOKEN_LIMIT);
  });

  it('derives a distinct selector price from each model fallback leg', () => {
    expect(PROMPT_STUDIO_CREDITS).toEqual({ gemini: 2, claude: 6, gpt: 7 });
    for (const model of ['gemini', 'claude', 'gpt'] as const) {
      expect(PROMPT_STUDIO_CREDITS[model]).toBe(promptStudioCreditsFor(model));
      expect(promptStudioCostUsd(model, 'average')).toBeLessThan(promptStudioCostUsd(model, 'max'));
    }
  });

  it('uses the workbook export as every selector financial input', () => {
    for (const model of ['gemini', 'claude', 'gpt'] as const) {
      const row = llmPricingRecord('boards_prompt_studio', model);
      expect(PROMPT_STUDIO_PRICING[model].model).toBe(row.model);
      expect(PROMPT_STUDIO_PRICING[model].primaryPriceUsdPerMTok).toEqual(
        row.primaryPriceUsdPerMTok,
      );
      expect(PROMPT_STUDIO_PRICING[model].fallbackPriceUsdPerMTok).toEqual(
        row.fallbackPriceUsdPerMTok,
      );
      expect(PROMPT_STUDIO_PRICING[model].maxTokenBudget).toEqual(row.maxTokenBudget);
      expect(PROMPT_STUDIO_CREDITS[model]).toBe(row.credits);
      expect(promptStudioMarginAtFloor(model)).toBeCloseTo(row.marginAtFloor, 12);
    }
    expect(ASSIST_PRICING.creditFloorRub).toBe(LLM_PRICING_WORKBOOK.financial.creditFloorRub);
    expect(LLM_PRICING_WORKBOOK.financial.marginFloor).toBe(0.25);
    expect(LLM_PRICING_WORKBOOK.financial.scenarioMarginFloor).toBe(0.07);
  });

  it('clears the workbook margin floor at the maximum input and output', () => {
    for (const model of ['gemini', 'claude', 'gpt'] as const) {
      expect(promptStudioMarginAtFloor(model)).toBeGreaterThanOrEqual(
        LLM_PRICING_WORKBOOK.financial.marginFloor,
      );
    }
  });

  it('keeps Kie savings as upside instead of relying on them for solvency', () => {
    for (const model of ['gemini', 'claude', 'gpt'] as const) {
      expect(promptStudioCostUsd(model, 'max', 'primary')).toBeLessThanOrEqual(
        promptStudioCostUsd(model, 'max', 'fallback'),
      );
      expect(promptStudioCostUsd(model, 'max', 'worst_case_route')).toBe(
        promptStudioCostUsd(model, 'max', 'primary') +
          promptStudioCostUsd(model, 'max', 'fallback'),
      );
      expect(PROMPT_STUDIO_PRICING[model].maxTokenBudget.input).toBe(
        PROMPT_STUDIO_INPUT_TOKEN_LIMIT,
      );
    }
  });
});
