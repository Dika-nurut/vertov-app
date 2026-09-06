import { FasterWhisperProvider } from './faster-whisper.js';
import { GroqAsrProvider } from './groq.js';
import type { AsrProvider } from './types.js';

/**
 * Parses ASR_LANG_OVERRIDES ("uz:groq,en:whisper") into a map.
 * Used to route low-resource languages (e.g. Uzbek) to the higher-quality fallback.
 */
function parseLangOverrides(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const [lang, provider] = pair.trim().split(':');
    if (lang && provider) map.set(lang.trim(), provider.trim());
  }
  return map;
}

export interface AsrFactory {
  /** Pick the best provider for the requested language. Returns null when no
   * provider is configured (caller should fall back to the demo stub). */
  forLanguage(language?: string): AsrProvider | null;
}

export interface AsrFactoryOptions {
  /** Foreign-hosted ASR API transport. API callers pass egressFetch here. */
  groqFetch?: typeof fetch;
}

export function createAsrFactory(
  env: Record<string, string | undefined>,
  opts: AsrFactoryOptions = {},
): AsrFactory {
  const whisperProvider = env['WHISPER_SERVER_URL']
    ? new FasterWhisperProvider(
        env['WHISPER_SERVER_URL'],
        // Default must match the container's WHISPER__MODEL preload (compose) so the
        // server doesn't load a second model handle for an aliased name.
        env['WHISPER_MODEL'] ?? 'Systran/faster-whisper-small',
        { token: env['ASR_SERVER_TOKEN'] },
      )
    : null;

  const groqProvider = env['GROQ_API_KEY']
    ? new GroqAsrProvider(env['GROQ_API_KEY'], opts.groqFetch ? { apiFetch: opts.groqFetch } : {})
    : null;

  const langOverrides = parseLangOverrides(env['ASR_LANG_OVERRIDES']);
  const globalForce = env['ASR_PROVIDER'];

  return {
    forLanguage(language?: string): AsrProvider | null {
      // Per-language override wins first.
      const langOverride = language ? langOverrides.get(language) : undefined;
      const resolvedForce = langOverride ?? globalForce;

      if (resolvedForce === 'groq') return groqProvider;
      if (resolvedForce === 'whisper') return whisperProvider;

      // Default: whisper primary, groq fallback, null if neither configured.
      return whisperProvider ?? groqProvider;
    },
  };
}
