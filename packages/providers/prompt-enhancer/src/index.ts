import { parseOpenAiUsage, type AiCallAttempt, type AiUsage } from '@seed/shared';

export type PromptEnhancerMode = 'stub' | 'live';

export interface EnhanceInput {
  /** Russian prompt from the user — max 4 000 chars (enforced by caller). */
  promptRu: string;
}

export interface EnhanceResult {
  /** English-language enhanced prompt suitable for image/video generation. */
  enhancedEn: string;
  /** Back-translation to Russian so the user can verify meaning wasn't lost. */
  backTranslationRu: string;
}

export interface PromptEnhancerAdapter {
  mode: PromptEnhancerMode;
  enhance(input: EnhanceInput, attempts?: AiCallAttempt[]): Promise<EnhanceResult>;
}

export interface PromptEnhancerEnv {
  KIE_API_KEY?: string;
  KIE_CHAT_DISABLED?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODE?: string;
}

export interface PromptEnhancerDeps {
  /** Override for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Optional logger. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** Fixed OpenRouter slug used by prompt enhancement and recorded in BRD-0A. */
export const PROMPT_ENHANCER_MODEL = 'openai/gpt-4o-mini';
const MAX_TOKENS = 256;

const SYSTEM_PROMPT = `You are a creative prompt engineer.
The user provides a prompt in Russian for an AI image or video generator.
Your task:
1. Translate the prompt into fluent English optimised for diffusion-based image/video generation (vivid, descriptive, with style/lighting cues).
2. Provide a back-translation of the enhanced English prompt back into Russian, so the user can verify the meaning was preserved.

Reply with ONLY valid JSON — no markdown, no extra keys:
{"enhancedEn": "...", "backTranslationRu": "..."}`;

function resolveMode(env: PromptEnhancerEnv): PromptEnhancerMode {
  const explicit = (env.OPENROUTER_MODE ?? '').toLowerCase();
  if (explicit === 'stub') return 'stub';
  if (explicit === 'live') return 'live';
  if (!env.OPENROUTER_API_KEY) return 'stub';
  return 'live';
}

/**
 * Construct a prompt-enhancer adapter. Mode is `stub` when
 * `OPENROUTER_API_KEY` is absent (or `OPENROUTER_MODE=stub`). Live mode
 * posts to OpenRouter's chat-completions endpoint with GPT-4o-mini.
 */
export function createPromptEnhancerAdapter(
  env: PromptEnhancerEnv = process.env as PromptEnhancerEnv,
  deps: PromptEnhancerDeps = {},
): PromptEnhancerAdapter {
  const mode = resolveMode(env);
  const log = deps.log ?? ((msg, meta) => console.log(`[prompt-enhancer] ${msg}`, meta ?? {}));
  log(`adapter constructed mode=${mode}`);
  if (mode === 'stub') return createStubAdapter();
  return createLiveAdapter(env, deps);
}

function createStubAdapter(): PromptEnhancerAdapter {
  return {
    mode: 'stub',
    async enhance(input) {
      return {
        enhancedEn: `<en-stub> ${input.promptRu}`,
        backTranslationRu: `<ru-stub> ${input.promptRu}`,
      };
    },
  };
}

function createLiveAdapter(
  env: PromptEnhancerEnv,
  deps: PromptEnhancerDeps,
): PromptEnhancerAdapter {
  const apiKey = env.OPENROUTER_API_KEY!;
  const fetchImpl = deps.fetch ?? fetch;

  return {
    mode: 'live',
    async enhance(input, attempts) {
      let usage: AiUsage | null = null;
      let outcome: AiCallAttempt['outcome'] = 'error';
      let errorMessage: string | undefined;
      try {
        let res: Response;
        try {
          res = await fetchImpl(OPENROUTER_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: PROMPT_ENHANCER_MODEL,
              max_tokens: MAX_TOKENS,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: input.promptRu },
              ],
            }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err) {
          const name = (err as Error)?.name;
          if (name === 'TimeoutError' || name === 'AbortError') {
            throw new Error('openrouter_timeout');
          }
          throw err;
        }

        if (!res.ok) {
          const body = await res.text();
          throw new Error(
            `prompt-enhancer: OpenRouter returned ${res.status} ${body.slice(0, 200)}`,
          );
        }

        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        usage = parseOpenAiUsage(data);

        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          outcome = 'empty';
          throw new Error('prompt-enhancer: empty response from OpenRouter');
        }
        outcome = 'ok';

        let parsed: { enhancedEn?: string; backTranslationRu?: string };
        try {
          parsed = JSON.parse(content) as typeof parsed;
        } catch {
          throw new Error(
            `prompt-enhancer: invalid JSON from OpenRouter: ${content.slice(0, 200)}`,
          );
        }

        if (!parsed.enhancedEn || !parsed.backTranslationRu) {
          throw new Error(`prompt-enhancer: missing fields in response: ${content.slice(0, 200)}`);
        }

        return {
          enhancedEn: parsed.enhancedEn,
          backTranslationRu: parsed.backTranslationRu,
        };
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        attempts?.push({
          route: 'openrouter',
          model: PROMPT_ENHANCER_MODEL,
          attempt: (attempts?.length ?? 0) + 1,
          outcome,
          usage,
          ...(errorMessage ? { errorMessage } : {}),
        });
      }
    },
  };
}

export {
  createPromptStudioAdapter,
  PROMPT_STUDIO_MODEL_SLUGS,
  PROMPT_STUDIO_OUTPUT_TOKEN_LIMIT,
  PROMPT_STUDIO_REF_TOKEN_RE,
  promptStudioProviderInput,
  sanitizeSceneContext,
  type PromptStudioAdapter,
  type PromptStudioInput,
  type PromptStudioModel,
  type PromptStudioResult,
} from './prompt-studio';
