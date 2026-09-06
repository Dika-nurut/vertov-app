'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Anchor,
  type Proposal,
  type Thread,
  type Tier,
  type TierId,
  type AssistQuote,
  type AssistScope,
  fetchAssistQuote,
  streamAssist,
} from './_lib';
import { PlausibleEvent, trackEvent } from '../_components/PlausibleEvents';

export interface StreamState {
  threadId: string | null;
  text: string;
  phase: 'preparing' | 'thinking' | 'typing';
  active: boolean;
  error: string | null;
}

const EMPTY_STREAM: StreamState = {
  threadId: null,
  text: '',
  phase: 'preparing',
  active: false,
  error: null,
};

export interface ApplyResult {
  ok: boolean;
  rev?: number;
  from?: number;
  to?: number;
  error?: 'rev_conflict' | 'anchor_detached' | 'other';
  serverRev?: number;
}

const tierKey = (id: string) => `scenario-tier:${id}`;
function readTier(id: string): TierId {
  try {
    const t = localStorage.getItem(tierKey(id));
    if (t === 'economy' || t === 'standard' || t === 'max') return t;
  } catch {
    /* ignore */
  }
  return 'standard';
}

/** Threads + tiers + the streaming assist call + apply/dismiss/note. */
export function useAssist(apiUrl: string, scriptId: string) {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [tierState, setTierState] = useState<TierId>('standard');
  const tier = tierState;
  // Restore the per-script tier choice after mount (localStorage is client-only).
  useEffect(() => {
    setTierState(readTier(scriptId));
  }, [scriptId]);
  const setTier = useCallback(
    (t: TierId) => {
      setTierState(t);
      try {
        localStorage.setItem(tierKey(scriptId), t);
      } catch {
        /* ignore */
      }
    },
    [scriptId],
  );
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const [quote, setQuote] = useState<AssistQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const quoteAbortRef = useRef<AbortController | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const invalidateQuote = useCallback(() => {
    quoteAbortRef.current?.abort();
    quoteAbortRef.current = null;
    setQuote(null);
    setQuoteLoading(false);
  }, []);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/v1/scripts/${scriptId}/threads`, {
        credentials: 'include',
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) setThreads(((await res.json()) as { items: Thread[] }).items);
    } catch {
      /* transient — the list simply won't refresh */
    }
  }, [apiUrl, scriptId]);

  useEffect(() => {
    void refreshThreads();
    (async () => {
      try {
        const res = await fetch(`${apiUrl}/v1/assist/tiers`, {
          credentials: 'include',
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) setTiers(((await res.json()) as { items: Tier[] }).items);
      } catch {
        /* the picker will just show nothing until reload */
      }
    })();
    return () => abortRef.current?.();
  }, [apiUrl, scriptId, refreshThreads]);

  const chatThread = threads.find((t) => t.kind === 'chat') ?? null;

  const requestQuote = useCallback(
    async (req: {
      question: string;
      anchor?: Anchor;
      threadId?: string;
      scope?: AssistScope;
      sceneOrdinal?: number;
      confirmFullScript?: true;
    }): Promise<AssistQuote | null> => {
      quoteAbortRef.current?.abort();
      const controller = new AbortController();
      quoteAbortRef.current = controller;
      // A quote is valid only for the exact draft/context that produced it.
      // Clear it before the request starts so the composer cannot display or
      // submit a previous amount during the debounce/network window.
      setQuote(null);
      setQuoteLoading(true);
      try {
        const next = await fetchAssistQuote(apiUrl, scriptId, { ...req, tier }, controller.signal);
        setQuote(next);
        return next;
      } catch {
        if (!controller.signal.aborted) setQuote(null);
        return null;
      } finally {
        if (!controller.signal.aborted) setQuoteLoading(false);
      }
    },
    [apiUrl, scriptId, tier],
  );

  const ask = useCallback(
    async (req: {
      question: string;
      anchor?: Anchor;
      threadId?: string;
      scope?: AssistScope;
      sceneOrdinal?: number;
      confirmFullScript?: true;
    }) => {
      abortRef.current?.();
      const nextQuote = await requestQuote(req);
      if (!nextQuote) {
        setStream((s) => ({ ...s, active: false, error: 'quote_unavailable' }));
        return;
      }
      setStream({
        threadId: req.threadId ?? null,
        text: '',
        phase: 'preparing',
        active: true,
        error: null,
      });
      trackEvent(PlausibleEvent.scenarioAssistRequested, {
        tier,
        scope: nextQuote.scope,
      });
      abortRef.current = streamAssist(
        apiUrl,
        scriptId,
        {
          ...req,
          tier,
          expectedCredits: nextQuote.credits,
          quoteFingerprint: nextQuote.quoteFingerprint,
          // One key per deliberate send. If transport certainty is lost, the
          // same request can be replayed without a second paid provider call.
          idempotencyKey:
            globalThis.crypto?.randomUUID?.() ??
            `assist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
        {
          onHead: (head) => setStream((s) => ({ ...s, threadId: head.threadId })),
          onPhase: (phase) => setStream((s) => ({ ...s, phase })),
          onDelta: (delta) => setStream((s) => ({ ...s, text: s.text + delta })),
          onDone: async () => {
            await refreshThreads();
            trackEvent(PlausibleEvent.scenarioAssistCompleted, {
              tier,
              scope: nextQuote.scope,
            });
            setStream(EMPTY_STREAM);
          },
          onError: (e) => {
            trackEvent(PlausibleEvent.scenarioAssistFailed, {
              tier,
              scope: nextQuote.scope,
              result: e.error === 'assist_stopped' ? 'stopped' : 'failure',
            });
            setStream((s) => ({
              ...s,
              active: false,
              error:
                e.error === 'insufficient_credits'
                  ? 'Недостаточно токенов.'
                  : e.error === 'quote_stale'
                    ? 'Контекст сценария изменился. Обновите цену и повторите.'
                    : e.error === 'assist_stopped'
                      ? 'Ответ остановлен.'
                      : e.error === 'assist_timeout'
                        ? 'Ответ не пришёл вовремя. Попробуйте ещё раз.'
                        : 'Не удалось получить ответ. Попробуйте ещё раз.',
            }));
          },
        },
      );
    },
    [apiUrl, scriptId, tier, refreshThreads, requestQuote],
  );

  const applyProposal = useCallback(
    async (threadId: string, baseRev: number): Promise<ApplyResult> => {
      try {
        const res = await fetch(`${apiUrl}/v1/scripts/${scriptId}/threads/${threadId}/apply`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseRev }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const b = (await res.json()) as { rev: number; from: number; to: number };
          await refreshThreads();
          return { ok: true, rev: b.rev, from: b.from, to: b.to };
        }
        const b = (await res.json().catch(() => ({}))) as { error?: string; rev?: number };
        await refreshThreads();
        if (b.error === 'rev_conflict')
          return {
            ok: false,
            error: 'rev_conflict',
            ...(b.rev !== undefined ? { serverRev: b.rev } : {}),
          };
        if (b.error === 'anchor_detached') return { ok: false, error: 'anchor_detached' };
        return { ok: false, error: 'other' };
      } catch {
        return { ok: false, error: 'other' };
      }
    },
    [apiUrl, scriptId, refreshThreads],
  );

  const patchThread = useCallback(
    async (threadId: string, body: Record<string, unknown>) => {
      await fetch(`${apiUrl}/v1/scripts/${scriptId}/threads/${threadId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {});
      await refreshThreads();
    },
    [apiUrl, scriptId, refreshThreads],
  );

  const revertProposal = useCallback(
    async (threadId: string): Promise<ApplyResult> => {
      try {
        const res = await fetch(`${apiUrl}/v1/scripts/${scriptId}/threads/${threadId}/revert`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const b = (await res.json()) as { rev: number; from: number; to: number };
          await refreshThreads();
          return { ok: true, rev: b.rev, from: b.from, to: b.to };
        }
        const b = (await res.json().catch(() => ({}))) as { error?: string; rev?: number };
        await refreshThreads();
        if (b.error === 'rev_conflict')
          return {
            ok: false,
            error: 'rev_conflict',
            ...(b.rev !== undefined ? { serverRev: b.rev } : {}),
          };
        return { ok: false, error: b.error === 'revert_detached' ? 'anchor_detached' : 'other' };
      } catch {
        return { ok: false, error: 'other' };
      }
    },
    [apiUrl, scriptId, refreshThreads],
  );

  const dismissThread = useCallback(
    (threadId: string) => patchThread(threadId, { status: 'dismissed' }),
    [patchThread],
  );

  return {
    tiers,
    threads,
    chatThread,
    tier,
    setTier,
    stream,
    quote,
    quoteLoading,
    invalidateQuote,
    requestQuote,
    ask,
    stop() {
      abortRef.current?.();
      abortRef.current = null;
    },
    applyProposal,
    revertProposal,
    dismissThread,

    refreshThreads,
    lastProposal(thread: Thread): { proposal: Proposal; index: number } | null {
      for (let i = thread.messages.length - 1; i >= 0; i--) {
        const m = thread.messages[i]!;
        if (m.role === 'assistant' && m.proposal) return { proposal: m.proposal, index: i };
      }
      return null;
    },
  };
}
