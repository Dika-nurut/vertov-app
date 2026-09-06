/**
 * kie.ai text legs — PRIMARY routes for two «Сценарий» tiers (owner decisions
 * 2026-07-24), OpenRouter stays the automatic fallback for both (the router
 * lives in script-assist.ts: streamAssistCompletion):
 *
 *  · standard tier → Gemini 3 Flash via the kie CHAT endpoint (≈70% cheaper);
 *  · max tier      → Claude Sonnet 5 via the kie CLAUDE endpoint (≈57% cheaper).
 *
 * Gemini chat API shape (owner-captured kie.ai docs): the model name is in the
 * PATH, not the body — there is NO `model` field; message `content` is an ARRAY
 * of parts (text part: `{type:'text', text}`); SSE responses are OpenAI-shaped
 * (`data: {choices:[{delta:{content}}]}`, `data: [DONE]`). Auth reuses the
 * media-adapter KIE_API_KEY. `max_tokens` is NOT documented but is sent anyway
 * (OpenAI-compatible gateways typically accept/ignore unknown fields) —
 * UNVERIFIED against the live API: if a live smoke ever 400s on it, drop it here.
 *
 * Claude API shape (owner-captured kie.ai docs): ANTHROPIC-shaped, unlike the
 * Gemini endpoint — `model` IS required in the body (`claude-sonnet-5`),
 * messages carry user/assistant roles with plain-string content, responses are
 * Anthropic SSE (`event:`/`data:` pairs; text lives in content_block_delta
 * text_delta fragments; stream ends at message_stop). UNVERIFIED live: the
 * `anthropic-version` header (native-API convention, harmless if ignored) and
 * the top-level `system` field (NOT in kie's docs — Anthropic gateways usually
 * accept it; a 400 on it falls back cleanly to OpenRouter via the router).
 * `thinkingFlag` is deliberately OMITTED: the max tier does not set
 * disableReasoning, so kie's default applies (see the tier def in
 * @seed/shared assist-tiers).
 */
import {
  mergeAiUsage,
  parseAnthropicUsage,
  parseOpenAiUsage,
  type AiCallAttempt,
  type AiUsage,
} from '@seed/shared';

// Overridable so an e2e stack can point the gateway at a local mock (never a
// live call in tests). Mirrors OPENROUTER_URL in script-assist.ts.
const KIE_CHAT_URL =
  process.env.KIE_CHAT_URL ?? 'https://api.kie.ai/gemini-3-flash/v1/chat/completions';
const KIE_CLAUDE_URL = process.env.KIE_CLAUDE_URL ?? 'https://api.kie.ai/claude/v1/messages';

/** The text model slugs that get a kie-primary leg (standard + max tiers). */
export const KIE_PRIMARY_MODEL = 'google/gemini-3-flash-preview';
export const KIE_CLAUDE_PRIMARY_MODEL = 'anthropic/claude-sonnet-5';

/**
 * Should a kie leg be attempted first? Read PER CALL (not at module load) so
 * tests and ops can flip it without a restart: requires KIE_API_KEY (the same
 * key the media adapters use) and honors the KIE_CHAT_DISABLED=1 ops
 * kill-switch — ONE switch covers both kie text legs (Gemini + Claude).
 */
export function kiePrimaryEnabled(): boolean {
  return Boolean(process.env.KIE_API_KEY) && process.env.KIE_CHAT_DISABLED !== '1';
}

/**
 * Admin-panel visibility (read-only): which leg currently serves a kie-routed
 * tier. `primary` is 'kie' only while the key is present AND the kill-switch
 * is off; OpenRouter is always the pre-token fallback.
 */
export function kieChatRoute(): { primary: 'kie' | 'openrouter'; fallback: 'openrouter' } {
  return { primary: kiePrimaryEnabled() ? 'kie' : 'openrouter', fallback: 'openrouter' };
}

/** Shared call shape for both kie legs (mirrors streamCompletion's contract). */
export interface KieLegArgs {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  disableReasoning: boolean;
  maxTokens: number;
  system: string;
  user: string;
  onReasoning?: () => void;
  onDelta: (delta: string) => void;
  attempts?: AiCallAttempt[];
}

/**
 * Stream one kie.ai Gemini chat completion, invoking onDelta per token chunk —
 * the same contract as script-assist's streamCompletion (signal, onReasoning,
 * onDelta, returns the full text). NO internal retry: the router's OpenRouter
 * fallback takes the role of the pre-token retry, and a mid-stream failure must
 * surface to the caller so it can decide (never replay after a visible delta).
 *
 * `disableReasoning` maps to the tier's reasoning kill: include_thoughts:false
 * + reasoning_effort:'low'. When false the kie defaults apply (fields omitted).
 */
export async function streamKieCompletion(args: KieLegArgs): Promise<string> {
  const apiKey = process.env.KIE_API_KEY ?? '';
  const requestBody = JSON.stringify({
    max_tokens: args.maxTokens,
    stream: true,
    ...(args.disableReasoning ? { include_thoughts: false, reasoning_effort: 'low' } : {}),
    messages: [
      { role: 'system', content: [{ type: 'text', text: args.system }] },
      { role: 'user', content: [{ type: 'text', text: args.user }] },
    ],
  });

  // Fail closed before any provider work if the deadline already expired
  // (same late-abort discipline as streamCompletion).
  args.signal.throwIfAborted();
  let outcome: AiCallAttempt['outcome'] = 'error';
  let usage: AiUsage | null = null;
  let full = '';
  let errorMessage: string | undefined;
  try {
    const res = await args.fetchImpl(KIE_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
      signal: args.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`kie gateway ${res.status}: ${body.slice(0, 300)}`);
    }

    let buffer = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          outcome = full ? 'ok' : 'empty';
          return full;
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning?: string;
                reasoning_content?: string;
                reasoning_details?: unknown[];
              };
            }>;
          };
          usage = mergeAiUsage(usage, parseOpenAiUsage(json));
          const frame = json.choices?.[0]?.delta;
          if (
            frame?.reasoning ||
            frame?.reasoning_content ||
            (frame?.reasoning_details?.length ?? 0) > 0
          ) {
            args.onReasoning?.();
          }
          const delta = frame?.content;
          if (delta) {
            full += delta;
            args.onDelta(delta);
          }
        } catch {
          // malformed provider frame — ignore it and continue the stream
        }
      }
    }
    // Some gateways close without [DONE]; content so far is still usable. An
    // empty return is the router's cue to fall back to OpenRouter.
    outcome = full ? 'ok' : 'empty';
    return full;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    args.attempts?.push({
      route: 'kie_gemini',
      model: KIE_PRIMARY_MODEL,
      attempt: (args.attempts?.length ?? 0) + 1,
      outcome,
      usage,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }
}

/**
 * Stream one kie.ai Claude (Anthropic-shaped) completion — the max tier's
 * primary leg. Same contract as streamKieCompletion (signal, onReasoning,
 * onDelta, returns the full text; NO internal retry — the router's OpenRouter
 * fallback covers pre-token failure, and a mid-stream failure must surface so
 * it never replays after a visible delta).
 *
 * Unlike the Gemini endpoint: `model` IS in the body; the system prompt goes
 * into the Anthropic top-level `system` field (UNDOCUMENTED on kie — Anthropic
 * gateways accept it; if kie ever 400s on it, the router falls back to OR
 * cleanly, and the fix would be folding it into the first user message).
 * `thinkingFlag` is omitted — the max tier keeps provider-default reasoning.
 */
export async function streamKieClaudeCompletion(args: KieLegArgs): Promise<string> {
  const apiKey = process.env.KIE_API_KEY ?? '';
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-5',
    system: args.system,
    max_tokens: args.maxTokens,
    stream: true,
    messages: [{ role: 'user', content: args.user }],
  });

  // Fail closed before any provider work if the deadline already expired
  // (same late-abort discipline as streamCompletion).
  args.signal.throwIfAborted();
  let outcome: AiCallAttempt['outcome'] = 'error';
  let usage: AiUsage | null = null;
  let full = '';
  let errorMessage: string | undefined;
  try {
    const res = await args.fetchImpl(KIE_CLAUDE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Native-API convention per kie's docs; harmless if the gateway ignores it.
        'anthropic-version': '2023-06-01',
      },
      body: requestBody,
      signal: args.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`kie claude gateway ${res.status}: ${body.slice(0, 300)}`);
    }

    // Anthropic SSE: `event: <name>` + `data: <json>` pairs. The data payload's
    // own `type` mirrors the event name, so dispatching on the parsed type is
    // enough (event lines are skipped). Text arrives as content_block_delta →
    // delta.type 'text_delta' → delta.text; 'thinking_delta' counts as reasoning
    // for the UI's «thinking» phase. message_stop terminates the stream.
    let buffer = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        try {
          const json = JSON.parse(payload) as {
            type?: string;
            delta?: { type?: string; text?: string; thinking?: string };
            error?: { type?: string; message?: string };
          };
          usage = mergeAiUsage(usage, parseAnthropicUsage(json));
          if (json.type === 'message_stop') {
            outcome = full ? 'ok' : 'empty';
            return full;
          }
          if (json.type === 'error') {
            throw new Error(
              `kie claude stream error: ${json.error?.message ?? payload.slice(0, 200)}`,
            );
          }
          if (json.type === 'content_block_delta') {
            if (json.delta?.type === 'thinking_delta' && json.delta.thinking) {
              args.onReasoning?.();
            }
            const delta = json.delta?.type === 'text_delta' ? json.delta.text : undefined;
            if (delta) {
              full += delta;
              args.onDelta(delta);
            }
          }
          // message_start / content_block_start/stop / message_delta / ping carry
          // no visible text — ignored by design.
        } catch (err) {
          // Stream-level provider errors must propagate; malformed frames don't.
          if (err instanceof Error && err.message.startsWith('kie claude')) throw err;
        }
      }
    }
    // Some gateways close without message_stop; content so far is still usable.
    // An empty return is the router's cue to fall back to OpenRouter.
    outcome = full ? 'ok' : 'empty';
    return full;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    args.attempts?.push({
      route: 'kie_claude',
      model: KIE_CLAUDE_PRIMARY_MODEL,
      attempt: (args.attempts?.length ?? 0) + 1,
      outcome,
      usage,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }
}
