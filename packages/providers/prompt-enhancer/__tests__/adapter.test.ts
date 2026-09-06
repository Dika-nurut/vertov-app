import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPromptEnhancerAdapter } from '../src/index';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODE;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

// ── Mode selection ────────────────────────────────────────────────────────────

describe('createPromptEnhancerAdapter — mode selection', () => {
  it('defaults to stub when OPENROUTER_API_KEY is empty', () => {
    const a = createPromptEnhancerAdapter({});
    expect(a.mode).toBe('stub');
  });

  it('returns live mode when API key is present', () => {
    const a = createPromptEnhancerAdapter({ OPENROUTER_API_KEY: 'sk-or-test-key' });
    expect(a.mode).toBe('live');
  });

  it('OPENROUTER_MODE=stub forces stub even when key is set', () => {
    const a = createPromptEnhancerAdapter({
      OPENROUTER_API_KEY: 'sk-or-test-key',
      OPENROUTER_MODE: 'stub',
    });
    expect(a.mode).toBe('stub');
  });

  it('OPENROUTER_MODE=live forces live even when key is absent (escape hatch)', () => {
    const a = createPromptEnhancerAdapter({ OPENROUTER_MODE: 'live' });
    // Mode resolves to live; actual network call would fail, but mode is correct.
    expect(a.mode).toBe('live');
  });
});

// ── Stub adapter ──────────────────────────────────────────────────────────────

describe('stub enhance()', () => {
  it('returns strings prefixed with <en-stub> and <ru-stub>', async () => {
    const a = createPromptEnhancerAdapter({});
    const result = await a.enhance({ promptRu: 'Котик в зимней шапке' });
    expect(result.enhancedEn).toBe('<en-stub> Котик в зимней шапке');
    expect(result.backTranslationRu).toBe('<ru-stub> Котик в зимней шапке');
  });

  it('back-translation field is always present in stub mode', async () => {
    const a = createPromptEnhancerAdapter({});
    const result = await a.enhance({ promptRu: 'test' });
    expect(typeof result.backTranslationRu).toBe('string');
    expect(result.backTranslationRu.length).toBeGreaterThan(0);
  });
});

// ── Live adapter ──────────────────────────────────────────────────────────────

describe('live enhance()', () => {
  const makeValidResponse = () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                enhancedEn: 'A kitten wearing a winter hat',
                backTranslationRu: 'Котёнок в зимней шапке',
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('posts to OpenRouter with correct Authorization Bearer header and model', async () => {
    const fetchMock = vi.fn(async () => makeValidResponse());
    const a = createPromptEnhancerAdapter(
      { OPENROUTER_API_KEY: 'sk-or-secret' },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    await a.enhance({ promptRu: 'Котик в зимней шапке' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-or-secret');

    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.max_tokens).toBe(256);
  });

  it('returns enhancedEn and backTranslationRu from the OpenRouter response', async () => {
    const fetchMock = vi.fn(async () => makeValidResponse());
    const a = createPromptEnhancerAdapter(
      { OPENROUTER_API_KEY: 'sk-or-secret' },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    const result = await a.enhance({ promptRu: 'Котик в зимней шапке' });
    expect(result.enhancedEn).toBe('A kitten wearing a winter hat');
    expect(result.backTranslationRu).toBe('Котёнок в зимней шапке');
  });

  it('throws on non-2xx response from OpenRouter', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    );
    const a = createPromptEnhancerAdapter(
      { OPENROUTER_API_KEY: 'bad-key' },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    await expect(a.enhance({ promptRu: 'test' })).rejects.toThrow(
      /prompt-enhancer: OpenRouter returned 401/,
    );
  });
});
