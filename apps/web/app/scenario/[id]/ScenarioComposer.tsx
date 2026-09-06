'use client';

import { useEffect, useId, useState } from 'react';
import { ShieldCheck, X } from '@/components/ui/icons';
import { TokenStar } from '@/components/ui/token-star';
import type { AssistScope } from '../_lib';

export function ScenarioComposer({
  selectionQuote,
  ringQuote,
  streaming,
  askCost,
  askPriceRefusal,
  onDetachSelection,
  onAskAnchored,
  onAskChat,
  onQuote,
  onQuoteInvalidated,
  quoteLoading,
  quote,
  currentSceneOrdinal: _currentSceneOrdinal,
  onStop,
}: {
  selectionQuote: string | null;
  ringQuote: boolean;
  streaming: boolean;
  askCost: number | null;
  askPriceRefusal: string | null;
  onDetachSelection: () => void;
  onAskAnchored: (question: string) => void;
  onAskChat: (question: string, scope?: AssistScope) => void;
  onQuote: (question: string, scope?: AssistScope) => void;
  onQuoteInvalidated: () => void;
  quoteLoading: boolean;
  quote: {
    credits: number;
    scope: AssistScope;
    inputBand: string;
    contextReduced: boolean;
    conspectRefreshRequired?: boolean;
  } | null;
  currentSceneOrdinal: number;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<AssistScope>(selectionQuote ? 'span' : 'project');
  const composerId = useId();
  const shortcutId = useId();
  useEffect(() => {
    setScope(selectionQuote ? 'span' : 'project');
    onQuoteInvalidated();
  }, [onQuoteInvalidated, selectionQuote]);
  useEffect(() => {
    const question = draft.trim();
    if (!question || streaming) return;
    const timer = setTimeout(() => onQuote(question, selectionQuote ? 'span' : scope), 250);
    return () => clearTimeout(timer);
  }, [draft, onQuote, scope, selectionQuote, streaming]);
  const send = () => {
    const question = draft.trim();
    if (!question || streaming) return;
    if (selectionQuote) onAskAnchored(question);
    else onAskChat(question, scope);
    setDraft('');
  };

  return (
    <div className="border-t-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 py-3">
      {selectionQuote && (
        <div
          className={`mb-2 flex items-start gap-2 border-l-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-2.5 py-1.5 ${ringQuote ? 'outline outline-[2.5px] outline-[color:var(--color-accent)] outline-offset-2' : ''}`}
          data-testid="scenario-quote-chip"
        >
          <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-screenplay)] text-[13px] text-[color:var(--color-paper-ink)]">
            {selectionQuote}
          </span>
          <button
            onClick={onDetachSelection}
            aria-label="Убрать цитату"
            data-testid="scenario-quote-detach"
            className="shrink-0 cursor-pointer px-1 text-[color:var(--color-paper-ink)]/60 hover:text-[color:var(--color-paper-ink)] focus-visible:outline-none"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      )}
      <textarea
        id={composerId}
        value={draft}
        onChange={(event) => {
          onQuoteInvalidated();
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
        rows={6}
        disabled={streaming}
        aria-describedby={shortcutId}
        placeholder={selectionQuote ? 'Спроси об этом фрагменте…' : 'Спроси о замысле…'}
        data-testid="scenario-chat-input"
        className="min-h-[156px] max-h-[320px] w-full resize-y border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 py-2.5 text-[13px] leading-relaxed text-[color:var(--color-fg)] outline-none focus-visible:border-[color:var(--color-accent)] disabled:opacity-50"
      />
      <div className="mt-2 flex items-center gap-2">
        <span
          className="font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]"
          data-testid="scenario-ask-scope"
        >
          {selectionQuote
            ? 'выбранный фрагмент'
            : scope === 'project'
              ? 'проект'
              : scope === 'scene'
                ? 'текущая сцена'
                : 'весь сценарий'}
        </span>
        {!selectionQuote && (
          <select
            aria-label="Контекст ассистента"
            value={scope}
            onChange={(event) => {
              onQuoteInvalidated();
              setScope(event.target.value as AssistScope);
            }}
            disabled={streaming}
            className="border border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-1 py-1 text-[11px]"
          >
            <option value="project">Проект</option>
            <option value="scene">Текущая сцена</option>
            <option value="script">Весь сценарий</option>
          </select>
        )}
        {quote && !quoteLoading && (
          <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
            {quote.inputBand}
            {quote.contextReduced ? ' · сокращено' : ''}
            {quote.conspectRefreshRequired ? ' · память обновится' : ''}
          </span>
        )}
        <span
          id={shortcutId}
          className="hidden text-[11px] text-[color:var(--color-muted-foreground)] xl:inline"
        >
          Enter — новая строка · Ctrl/⌘ Enter — отправить
        </span>
        {streaming ? (
          <button
            onClick={onStop}
            data-testid="scenario-chat-stop"
            className="sp-btn ml-auto border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-4 py-1.5 text-[13px] font-bold text-[color:var(--color-fg)]"
          >
            Стоп
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!draft.trim() || quoteLoading || askCost === null}
            data-testid="scenario-chat-send"
            className="sp-btn ml-auto border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-1.5 text-[13px] font-bold text-[color:var(--color-primary-foreground)]"
          >
            {quoteLoading ? 'Проверяем цену…' : 'Спросить'}
            {!quoteLoading && askCost !== null && (
              <span className="ml-1.5 inline-flex items-center gap-0.5">
                <TokenStar size={11} />
                {askCost}
              </span>
            )}
          </button>
        )}
      </div>
      {askPriceRefusal && (
        <p className="mt-2 text-[11px] text-[color:var(--color-destructive)]" role="alert">
          {askPriceRefusal}
        </p>
      )}
      <p
        className="mt-2.5 flex items-center gap-1.5 text-[11px] text-[color:var(--color-muted-foreground)]"
        data-testid="scenario-privacy"
      >
        <ShieldCheck size={13} className="text-[color:var(--color-positive)]" aria-hidden />
        Не обучаемся на твоих текстах.
      </p>
    </div>
  );
}
