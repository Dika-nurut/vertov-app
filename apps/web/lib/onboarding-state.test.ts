import { afterEach, describe, expect, it, vi } from 'vitest';
import { postOnboarding } from './onboarding-state';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postOnboarding', () => {
  it('retries once after a failed response and accepts the second response', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ onboardedAt: 'now' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await expect(postOnboarding('https://api.test', {})).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails after the one permitted retry so the card can remain visible', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetch);

    await expect(postOnboarding('https://api.test', {})).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
