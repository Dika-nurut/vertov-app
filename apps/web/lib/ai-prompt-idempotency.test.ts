import { describe, expect, it } from 'vitest';
import { aiPromptClaimKey, shouldRetainAiPromptClaim } from './ai-prompt-idempotency';

describe('AI prompt claim identity', () => {
  it('reuses an existing node key and only creates one for a fresh node', () => {
    expect(aiPromptClaimKey('claim-1', () => 'should-not-run')).toBe('claim-1');
    expect(aiPromptClaimKey(undefined, () => 'claim-2')).toBe('claim-2');
  });

  it('retains only an ambiguous/in-progress 409 claim', () => {
    expect(shouldRetainAiPromptClaim({ status: 409, error: 'prompt_studio_in_progress' })).toBe(
      true,
    );
    expect(shouldRetainAiPromptClaim({ status: 409 })).toBe(true);
    expect(
      shouldRetainAiPromptClaim({ status: 409, error: 'prompt_studio_retry_with_new_key' }),
    ).toBe(false);
    expect(
      shouldRetainAiPromptClaim({ status: 409, error: 'prompt_studio_idempotency_key_reused' }),
    ).toBe(false);
    expect(shouldRetainAiPromptClaim({ status: 503, error: 'prompt_studio_unavailable' })).toBe(
      false,
    );
  });
});
