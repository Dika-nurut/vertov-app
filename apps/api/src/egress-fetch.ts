import { ProxyAgent, type Dispatcher } from 'undici';

/**
 * Egress fetch for api-side foreign-vendor calls (docs/ops/egress-gateway.md).
 *
 * The generation vendor clients (`@seed/provider-byteplus`) already tunnel
 * through the egress proxy, but the api-side LLM/TTS/ASR/balance callers —
 * scenario AI (`script-assist.ts`), the prompt enhancer /
 * prompt-studio, studio voiceover (OpenAI / ElevenLabs), Groq ASR, and provider
 * balance checks — can otherwise hit vendors from the Cloudflare-blocked prod VM
 * IP and get a 403 ("Access denied by security policy"). This routes those calls
 * through the same forward proxy when `EGRESS_PROXY_URL` is set; unset →
 * identical to global `fetch` (dev/CI unchanged).
 *
 * RU services (Yandex/SMSC/VK/OK OAuth+SMS) must NOT use this — they work from
 * the RU IP and routing auth data through a foreign hop is a 152-ФЗ problem.
 * Keep those on plain `fetch`.
 */

let cached: { key: string; agent: ProxyAgent } | null = null;

export function egressDispatcher(env: NodeJS.ProcessEnv = process.env): Dispatcher | undefined {
  const uri = env.EGRESS_PROXY_URL?.trim();
  if (!uri) return undefined;
  const token = env.EGRESS_PROXY_TOKEN?.trim() || undefined;
  const key = `${uri}|${token ?? ''}`;
  if (cached && cached.key === key) return cached.agent;
  const agent = new ProxyAgent(token ? { uri, token } : { uri });
  cached = { key, agent };
  return agent;
}

/** Test-only: drop the memoized agent so a changed env is re-read. */
export function resetEgressFetchForTest(): void {
  cached = null;
}

/**
 * Drop-in replacement for global `fetch` that adds the egress dispatcher when
 * configured. Assignable wherever a `fetch`-shaped `fetchImpl`/`deps.fetch` is
 * expected. When egress is off it forwards the call unchanged.
 */
export const egressFetch: typeof fetch = (input, init) => {
  const dispatcher = egressDispatcher();
  const opts = (dispatcher ? { ...init, dispatcher } : init) as RequestInit;
  return fetch(input, opts);
};
