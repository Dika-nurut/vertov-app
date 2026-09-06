// «Сценарий» — shared client types + the assist SSE reader.
// The API contract is frozen by the Phase B backend (apps/api/src/scripts.ts,
// script-assist.ts). Keep these in sync with those routes.
import type { ScenarioBriefV1, ScenarioFormat, ScenarioOutlineV1 } from '@seed/shared';

/** Compact whole-script summary for the list-card meta line. */
export interface ScriptStats {
  /** Whole-script page estimate (0 only for an empty script). */
  pages: number;
  /** Number of scene headings. */
  scenes: number;
  /** First scene heading (drives the auto-title), or null. */
  firstScene: string | null;
  /** Last scene heading in document order, or null when there are none. */
  lastScene: string | null;
}

/** DB default title — treated as "unset" so the auto-title can take over. */
export const AUTO_TITLE_SENTINEL = 'Новый сценарий';

/** The title shown for a script: an explicit title, else its first scene heading. */
export function displayTitle(title: string, firstScene: string | null): string {
  const t = title.trim();
  if (t && t !== AUTO_TITLE_SENTINEL) return t;
  return firstScene ?? '';
}

/** Card recency: «сегодня» / «вчера» / «DD.MM». */
export function formatRecency(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(then)) / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return then.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

export interface ScriptRow {
  id: string;
  title: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
  /** Present on the list payload (GET /v1/scripts); absent elsewhere. */
  stats?: ScriptStats;
  /** Title-page author, when the script declares one. */
  author?: string | null;
}

export interface ScriptBible {
  /** Current model: a flat notes list (МИР ПРОЕКТА). */
  notes?: Array<string | MemoryNote>;
  /** Legacy typed fields — folded into notes on read via `bibleNotes`. */
  characters?: { name: string; description: string }[];
  tone?: string[];
  rules?: string[];
}

export interface MemoryNote {
  id: string;
  content: string;
  includeInAi: boolean;
}

export interface Script {
  id: string;
  title: string;
  fountain: string;
  rev: number;
  format: ScenarioFormat;
  brief: ScenarioBriefV1;
  outline: ScenarioOutlineV1;
  bible: ScriptBible;
  createdAt: string;
  updatedAt: string;
}

export interface Anchor {
  from: number;
  to: number;
  rev: number;
  quote: string;
}

export interface Proposal {
  before: string;
  after: string;
}

export interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
  proposal?: Proposal;
  tier?: string;
  at: string;
}

export type ThreadStatus = 'open' | 'applied' | 'dismissed' | 'detached';

export interface Thread {
  id: string;
  scriptId: string;
  kind: 'chat' | 'thread';
  anchor: Anchor | null;
  messages: ThreadMessage[];
  conspect: string;
  conspectUpto: number;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialRow {
  id: string;
  name: string;
  chars: number;
  includeInAi: number;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialsList {
  items: MaterialRow[];
  totalChars: number;
  /** Present only after the materials endpoint has supplied server-side limits. */
  maxTotalChars?: number;
  maxFiles?: number;
  maxFileChars?: number;
}

/** Number shown for the project's complete canon: notes and attached files. */
export function canonCount(notes: MemoryNote[], materials: MaterialsList): number {
  return notes.length + materials.items.length;
}

export type TierId = 'economy' | 'standard' | 'max';
export type AssistScope = 'project' | 'span' | 'scene' | 'script';

export interface Tier {
  id: TierId;
  labelRu: string;
  /** OpenRouter model slug (present on the tiers endpoint). */
  model?: string;
  creditsPerCall: Record<AssistScope, number>;
  materialsSurcharge: number;
  /** Admin ON/OFF (assist_tier_states); absent on older payloads ⇒ active. */
  isActive?: boolean;
}

/** Friendly display name for a model slug, e.g. «GEMINI 3 FLASH». */
export function modelLabel(slug: string | undefined): string {
  if (!slug) return '';
  const name = slug.split('/').pop() ?? slug;
  return name
    .replace(/-preview$/i, '')
    .replace(/[-.]/g, ' ')
    .trim()
    .toUpperCase();
}

/** Pull the optional generalizable-rule the model attached (spec §5), or null. */
export function extractRule(content: string): string | null {
  const m = /<rule>([\s\S]*?)<\/rule>/.exec(content);
  const r = m?.[1]?.trim();
  return r && r.length <= 200 ? r : null;
}

// ---- assist SSE frames (from apps/api/src/script-assist.ts) ----

export interface AssistHead {
  threadId: string;
  tier: TierId;
  credits: number;
  scope: AssistScope;
  materials: boolean;
  detached: boolean;
  inputBand?: string;
  maxOutputTokens?: number;
  contextReduced?: boolean;
  conspectIncluded?: boolean;
  conspectRefreshRequired?: boolean;
  quoteFingerprint?: string;
  scriptRev?: number;
}

export interface AssistQuote {
  tier: TierId;
  scope: AssistScope;
  credits: number;
  inputBand: string;
  maxOutputTokens: number;
  contextReduced: boolean;
  conspectIncluded: boolean;
  conspectRefreshRequired?: boolean;
  quoteFingerprint: string;
  scriptRev: number;
}

export interface AssistHandlers {
  onHead: (head: AssistHead) => void;
  onPhase: (phase: 'thinking' | 'typing') => void;
  onDelta: (delta: string) => void;
  onDone: (done: { threadId: string; proposal: Proposal | null; credits: number }) => void;
  onError: (error: { error: string; message?: string }) => void;
}

/** Whole-stream deadline — no-infinite-loading doctrine (visible failure). */
export const ASSIST_STREAM_DEADLINE_MS = 125_000;

export interface AssistRequest {
  /** Stable for one logical send attempt; server uses it to dedupe paid retries. */
  idempotencyKey: string;
  question: string;
  /** Present → span (fragment) scope. Absent → project chat by default; whole-script is explicit. */
  anchor?: Anchor;
  threadId?: string;
  tier: TierId;
  scope?: AssistScope;
  sceneOrdinal?: number;
  confirmFullScript?: true;
  expectedCredits?: number;
  quoteFingerprint?: string;
}

export async function fetchAssistQuote(
  apiUrl: string,
  scriptId: string,
  req: Omit<AssistRequest, 'idempotencyKey' | 'expectedCredits' | 'quoteFingerprint'>,
  signal?: AbortSignal,
): Promise<AssistQuote> {
  const res = await fetch(`${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/assist/quote`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    ...(signal ? { signal } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<AssistQuote> & { error?: string };
  if (!res.ok || !body.quoteFingerprint) {
    throw new Error(body.error ?? `quote_failed_${res.status}`);
  }
  return body as AssistQuote;
}

/**
 * POST the assist request and read the SSE body (fetch + getReader — the API
 * needs a POST body, so EventSource won't do). Obeys the no-infinite-loading
 * spirit: a whole-stream deadline via AbortSignal.timeout and a visible error
 * on any failure (never an endless spinner). Returns a function to abort.
 */
export function streamAssist(
  apiUrl: string,
  scriptId: string,
  req: AssistRequest,
  handlers: AssistHandlers,
): () => void {
  const controller = new AbortController();
  let stoppedByUser = false;
  const deadline = setTimeout(() => controller.abort(), ASSIST_STREAM_DEADLINE_MS);

  (async () => {
    let dispatchedTerminal = false;
    try {
      const res = await fetch(`${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/assist`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (res.status === 402) {
        dispatchedTerminal = true;
        handlers.onError({ error: 'insufficient_credits' });
        return;
      }
      if (res.status === 403) {
        // Pre-paywall anonymous browsing (2026-07-07): the hard wall — an
        // anonymous session reached the actual AI-assistant call (plain
        // script writing stays free, so this is the one gated invocation).
        const body = await res.json().catch(() => ({}));
        if (body?.error === 'signup_required') {
          dispatchedTerminal = true;
          window.location.href = `/login?next=${encodeURIComponent(`/scenario/${scriptId}`)}`;
          return;
        }
      }
      if (!res.ok || !res.body) {
        dispatchedTerminal = true;
        const body = await res.json().catch(() => ({}));
        handlers.onError({
          error: typeof body?.error === 'string' ? body.error : 'assist_failed',
          message: `HTTP ${res.status}`,
        });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 2);
          if (!frame.startsWith('data:')) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(frame.slice(5).trim());
          } catch {
            continue;
          }
          if (payload.phase === 'thinking' || payload.phase === 'typing') {
            handlers.onPhase(payload.phase);
          } else if (typeof payload.delta === 'string') {
            handlers.onDelta(payload.delta);
          } else if (payload.done) {
            dispatchedTerminal = true;
            handlers.onDone({
              threadId: String(payload.threadId),
              proposal: (payload.proposal as Proposal | null) ?? null,
              credits: Number(payload.credits ?? 0),
            });
          } else if (payload.error) {
            dispatchedTerminal = true;
            handlers.onError({
              error: String(payload.error),
              ...(payload.message ? { message: String(payload.message) } : {}),
            });
          } else if ('threadId' in payload) {
            handlers.onHead(payload as unknown as AssistHead);
          }
        }
      }
      if (!dispatchedTerminal) {
        handlers.onError({ error: 'assist_incomplete' });
      }
    } catch (err) {
      if (!dispatchedTerminal) {
        handlers.onError({
          error: controller.signal.aborted
            ? stoppedByUser
              ? 'assist_stopped'
              : 'assist_timeout'
            : 'assist_failed',
          ...(err instanceof Error ? { message: err.message } : {}),
        });
      }
    } finally {
      clearTimeout(deadline);
    }
  })();

  return () => {
    clearTimeout(deadline);
    stoppedByUser = true;
    controller.abort();
  };
}
