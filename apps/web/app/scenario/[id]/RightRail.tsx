'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, X, Zap } from '@/components/ui/icons';
import {
  extractRule,
  modelLabel,
  type Proposal,
  type Thread,
  type Tier,
  type TierId,
  type AssistScope,
} from '../_lib';
import { CANON_ACCRETION_ENABLED } from '../canon-flags';
import { ScenarioComposer } from './ScenarioComposer';
import { firstUser, lastAssistant, stripRewrite } from '../scenario-thread';

// Discoverability coach-mark (R2): the first 2 times the writer ever selects
// text, briefly ring the quote chip so they notice it docked into the composer.
// Replaces the deleted floating «✦ Спросить» pill — no UI over the paper.
const SELECT_COACH_KEY = 'scenario-select-coach';
function selectCoachCount(): number {
  try {
    return Number(localStorage.getItem(SELECT_COACH_KEY) ?? '0') || 0;
  } catch {
    return 99; // storage blocked → never nag
  }
}
function bumpSelectCoach(n: number): void {
  try {
    localStorage.setItem(SELECT_COACH_KEY, String(n));
  } catch {
    /* ignore */
  }
}

const RULE_DECLINED_KEY = 'scenario-rule-declined';
function ruleDeclined(rule: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(RULE_DECLINED_KEY) ?? '[]') as string[]).includes(rule);
  } catch {
    return false;
  }
}
function declineRule(rule: string): void {
  try {
    const set = new Set(JSON.parse(localStorage.getItem(RULE_DECLINED_KEY) ?? '[]') as string[]);
    set.add(rule);
    localStorage.setItem(RULE_DECLINED_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

interface RightRailProps {
  tiers: Tier[];
  tier: TierId;
  onTier: (t: TierId) => void;
  threads: Thread[];
  chatThread: Thread | null;
  stream: {
    threadId: string | null;
    text: string;
    phase: 'preparing' | 'thinking' | 'typing';
    active: boolean;
    error: string | null;
  };
  hasScenes: boolean;
  /** Current selection quote (docks into the composer as a chip), or null. */
  selectionQuote: string | null;
  onDetachSelection: () => void;
  /** Ask about the current selection (anchored note). */
  onAskAnchored: (question: string) => void;
  /** Ask about project context or the explicitly selected whole-script scope. */
  onAskChat: (question: string, scope?: AssistScope) => void;
  onQuote: (question: string, scope?: AssistScope) => void;
  onQuoteInvalidated: () => void;
  quote: {
    credits: number;
    scope: AssistScope;
    inputBand: string;
    contextReduced: boolean;
    conspectRefreshRequired?: boolean;
  } | null;
  quoteLoading: boolean;
  currentSceneOrdinal: number;
  onStop: () => void;
  /** «Обсудить» a note in place: a follow-up ask on the note's own thread (R4). */
  onDiscuss: (threadId: string, question: string) => void;
  onApply: (thread: Thread) => void;
  onRevert?: ((threadId: string) => void) | undefined;
  onDismiss: (threadId: string) => void;
  onReveal: (thread: Thread) => void;
  /** Ghost-preview the proposal at its anchor (quote-strip click; R4). */
  onPreview: (thread: Thread) => void;
  /** «Записать в мир» — persist a generalizable rule the model proposed (§5). */
  onAddNote: (text: string) => void;
  /** Open the snapshots/restore sheet (ИСТОРИЯ footer, R5). */
  onOpenVersions: () => void;
  applyErrors: Record<string, 'rev_conflict' | 'anchor_detached'>;
  lastProposal: (thread: Thread) => { proposal: Proposal; index: number } | null;
  /** Rendered inside the mobile full-screen drawer: fill the container instead of
   *  the fixed 380px `hidden lg:flex` side column. Desktop leaves this unset. */
  mobile?: boolean;
}

// Deliberate 4th face (design bible §Type) — screenplay page-timing math only
// holds at a true fixed character width, so this one preview uses the real
// screenplay convention font instead of Martian Mono.
//
// Border width note (design bible §Borders): this whole rail deliberately
// uses the quiet-nested 2px width throughout (tabs, note cards, dividers)
// instead of the app's 2.5px signature — it's a rail nested inside the
// already-2.5px-bordered Scenario canvas frame, so a lighter internal weight
// keeps the hierarchy readable. Consistent 2px everywhere in this file, not
// an accident.
const COURIER = 'var(--font-screenplay)';
type RailView = 'chat' | 'history';

/** «01.07 14:32» — the ledger timestamp (client-only; ru locale). */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function RightRail(props: RightRailProps) {
  const {
    tiers,
    tier,
    onTier,
    threads,
    chatThread,
    stream,
    hasScenes,
    selectionQuote,
    onDetachSelection,
    onAskAnchored,
    onAskChat,
    onQuote,
    onQuoteInvalidated,
    quote,
    quoteLoading,
    currentSceneOrdinal,
    onStop,
    onDiscuss,
    onApply,
    onRevert,
    onDismiss,
    onReveal,
    onPreview,
    onAddNote,
    onOpenVersions,
    applyErrors,
    lastProposal,
  } = props;

  const [view, setView] = useState<RailView>('chat');
  const feedRef = useRef<HTMLDivElement>(null);

  // First-use chip ring (R2): fire when a selection first appears, at most twice.
  const [ringChip, setRingChip] = useState(false);
  const hadQuote = useRef(false);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const has = !!selectionQuote;
    if (has && !hadQuote.current) {
      const n = selectCoachCount();
      if (n < 2) {
        bumpSelectCoach(n + 1);
        setRingChip(true);
        if (ringTimer.current) clearTimeout(ringTimer.current);
        ringTimer.current = setTimeout(() => setRingChip(false), 1400);
      }
    }
    hadQuote.current = has;
  }, [selectionQuote]);
  useEffect(() => () => void (ringTimer.current && clearTimeout(ringTimer.current)), []);

  const activeTier = tiers.find((t) => t.id === tier) ?? null;
  const tierModel = modelLabel(activeTier?.model);
  const streamStatus =
    stream.phase === 'thinking'
      ? 'Обдумывает ответ…'
      : stream.phase === 'typing'
        ? 'Печатает…'
        : 'Готовит ответ…';
  // Price is a server-supplied quote from /v1/scripts/:id/assist/quote. Never
  // reproduce the workbook calculator in the client.
  const askCost =
    activeTier && activeTier.isActive !== false && !quoteLoading ? (quote?.credits ?? null) : null;
  const askPriceRefusal =
    activeTier?.isActive === false ? 'Этот режим ассистента сейчас отключён.' : null;

  // ЧАТ = the live surface: chat bubbles + notes still awaiting a decision.
  // ИСТОРИЯ = the ledger: applied / rejected proposals, read-only.
  const openNotes = threads
    .filter((t) => t.kind === 'thread' && (t.status === 'open' || t.status === 'detached'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const ledger = threads
    .filter((t) => t.kind === 'thread' && (t.status === 'applied' || t.status === 'dismissed'))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const chatMsgs = chatThread?.messages ?? [];
  const chatEmpty = openNotes.length === 0 && chatMsgs.length === 0;

  type Item =
    | { kind: 'chat'; at: string; role: 'user' | 'assistant'; content: string; tierId?: string }
    | { kind: 'note'; at: string; thread: Thread };
  const items: Item[] = [
    ...chatMsgs.map((m) => ({
      kind: 'chat' as const,
      at: m.at,
      role: m.role,
      content: m.content,
      ...(m.tier ? { tierId: m.tier } : {}),
    })),
    ...openNotes.map((t) => ({ kind: 'note' as const, at: t.createdAt, thread: t })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  useEffect(() => {
    if (view === 'chat') feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [items.length, stream.text, view]);

  // A stream belongs INSIDE an open note when its threadId matches one (a fresh
  // anchored ask streams into a provisional bottom card until refresh, because
  // its new thread isn't in `openNotes` yet — see below). C4 fix: route by
  // stream.threadId, not by selectionQuote.
  const streamNoteId =
    stream.active && stream.threadId && openNotes.some((n) => n.id === stream.threadId)
      ? stream.threadId
      : null;
  // The bottom provisional block: a fresh anchored ask (quote) → note card;
  // otherwise (chat/script) → a chat bubble. Suppressed when the stream is
  // being rendered inside an existing note.
  const showProvisional = stream.active && !streamNoteId;
  const provisionalNote = showProvisional && !!selectionQuote;

  return (
    <aside
      aria-label="Редактор сценария"
      className={
        props.mobile
          ? 'flex h-full w-full min-h-0 flex-col bg-[color:var(--color-surface)]'
          : 'hidden w-[380px] shrink-0 flex-col border-l-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] lg:flex'
      }
      data-testid="scenario-rail"
    >
      <div className="flex flex-col gap-2 border-b-[2.5px] border-[color:var(--color-line)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-widest text-[color:var(--color-fg)]">
            Архитектор истории
          </span>
          <div className="ml-auto flex gap-1" data-testid="scenario-rail-tabs">
            {(
              [
                ['chat', 'Чат'],
                ['history', 'История'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                data-testid={`scenario-tab-${v}`}
                aria-pressed={view === v}
                className={`cursor-pointer border-[2px] px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] ${
                  view === v
                    ? 'border-[color:var(--color-line)] bg-[color:var(--color-fg)] text-[color:var(--color-bg)]'
                    : 'border-[color:var(--color-line-soft)] text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-line)] hover:text-[color:var(--color-fg)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* model selector lives in the header (owner ask): its own row, room to breathe */}
        <label className="flex cursor-pointer items-center gap-2 border-[2px] border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2.5 py-1.5 focus-within:border-[color:var(--color-accent)]">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-muted-foreground)]">
            Модель
          </span>
          <select
            value={tier}
            onChange={(e) => onTier(e.target.value as TierId)}
            data-testid="scenario-tier"
            className="min-w-0 flex-1 cursor-pointer bg-transparent text-[13px] font-bold text-[color:var(--color-fg)] outline-none"
          >
            {tiers.map((t) => (
              <option key={t.id} value={t.id} disabled={t.isActive === false}>
                {t.labelRu} — {modelLabel(t.model)}
                {t.isActive === false ? ' (выкл)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {view === 'history' ? (
        <HistoryLedger
          rows={ledger}
          tiers={tiers}
          lastProposal={lastProposal}
          onReveal={onReveal}
          onRevert={onRevert}
          onOpenVersions={onOpenVersions}
        />
      ) : (
        <>
          <div ref={feedRef} className="flex flex-1 flex-col gap-3 overflow-auto p-4">
            {chatEmpty && !stream.active ? (
              <EmptyState hasScenes={hasScenes} onPrompt={onAskChat} streaming={stream.active} />
            ) : (
              items.map((it, i) =>
                it.kind === 'chat' ? (
                  <ChatBubble
                    key={`c${i}`}
                    role={it.role}
                    content={stripRewrite(it.content)}
                    tierName={
                      it.tierId ? modelLabel(tiers.find((t) => t.id === it.tierId)?.model) : ''
                    }
                  />
                ) : (
                  <NoteCard
                    key={it.thread.id}
                    thread={it.thread}
                    proposal={lastProposal(it.thread)?.proposal ?? null}
                    error={applyErrors[it.thread.id] ?? null}
                    tiers={tiers}
                    streaming={streamNoteId === it.thread.id ? stripRewrite(stream.text) : null}
                    streamPhase={stream.phase}
                    streamTierName={tierModel}
                    streamActive={stream.active}
                    onApply={() => onApply(it.thread)}
                    onDismiss={() => onDismiss(it.thread.id)}
                    onReveal={() => onReveal(it.thread)}
                    onPreview={() => onPreview(it.thread)}
                    onDiscuss={(q) => onDiscuss(it.thread.id, q)}
                    onAddNote={onAddNote}
                  />
                ),
              )
            )}

            {showProvisional &&
              (provisionalNote ? (
                <div
                  className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)]"
                  data-testid="scenario-streaming"
                >
                  {selectionQuote && <QuoteStrip text={selectionQuote} />}
                  <p
                    aria-live="polite"
                    className="px-3 py-3 text-[13px] leading-relaxed text-[color:var(--color-fg)]"
                  >
                    {stripRewrite(stream.text) || streamStatus}
                    <span className="ml-1 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                      {tierModel}
                    </span>
                  </p>
                </div>
              ) : (
                <ChatBubble
                  role="assistant"
                  content={stripRewrite(stream.text) || streamStatus}
                  tierName={tierModel}
                  streaming
                />
              ))}

            {stream.error && (
              <p
                className="text-[13px] text-[color:var(--color-destructive)]"
                data-testid="scenario-stream-error"
              >
                {stream.error}
              </p>
            )}
          </div>

          <ScenarioComposer
            selectionQuote={selectionQuote}
            ringQuote={ringChip}
            streaming={stream.active}
            askCost={askCost}
            askPriceRefusal={askPriceRefusal}
            onDetachSelection={onDetachSelection}
            onAskAnchored={onAskAnchored}
            onAskChat={onAskChat}
            onQuote={onQuote}
            onQuoteInvalidated={onQuoteInvalidated}
            quoteLoading={quoteLoading}
            quote={quote}
            currentSceneOrdinal={currentSceneOrdinal}
            onStop={onStop}
          />
        </>
      )}
    </aside>
  );
}

function EmptyState({
  hasScenes,
  onPrompt,
  streaming,
}: {
  hasScenes: boolean;
  onPrompt: (prompt: string) => void;
  streaming: boolean;
}) {
  const prompts = hasScenes
    ? [
        {
          label: 'Разобрать структуру',
          prompt:
            'Разбери структуру сценария по поворотным точкам. Покажи завязку, первый поворот, середину, кризис и кульминацию; отметь отсутствующие или слабые звенья. Не переписывай текст без моего решения.',
        },
        {
          label: 'Построить карту сцен',
          prompt:
            'Составь карту существующих сцен: цель героя, конфликт, изменение и функция каждой сцены. Затем найди повторы, пропуски и сцены без драматического изменения.',
        },
        {
          label: 'Проверить арку героя',
          prompt:
            'Проверь арку главного героя: желание, потребность, ложное убеждение, ключевые решения и итоговое изменение. Укажи, где мотивация или причинность слабеют.',
        },
        {
          label: 'Найти проблемы логики',
          prompt:
            'Проверь причинно-следственную связь, хронологию, знания персонажей и непрерывность деталей. Перечисли только конкретные проблемы со ссылкой на сцену и предложи варианты решения.',
        },
      ]
    : [
        {
          label: 'Развить мою идею',
          prompt:
            'Помоги развить идею сценария. Сначала задай мне по одному самые важные вопросы о герое, цели, препятствии и ставках. Не пиши сценарий вместо меня.',
        },
        {
          label: 'Найти конфликт',
          prompt:
            'Помоги найти центральный конфликт. Спроси, что уже известно о герое и мире, затем предложи три разных направления.',
        },
        {
          label: 'Сформулировать логлайн',
          prompt:
            'Помоги сформулировать логлайн. Сначала выясни недостающие факты, потом предложи три коротких варианта.',
        },
      ];
  return (
    <div className="flex flex-col gap-4" data-testid="scenario-rail-empty">
      <div>
        <p className="text-[13px] font-semibold text-[color:var(--color-fg)]">
          {hasScenes ? 'Инструменты архитектора' : 'Соберём основу истории'}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          {hasScenes
            ? 'Запусти разбор или поставь собственную драматургическую задачу ниже.'
            : 'Расскажи идею как есть. Архитектор задаст важные вопросы по одному, а решения останутся за тобой.'}
        </p>
      </div>
      <div className="flex flex-col gap-2" data-testid="scenario-starter-prompts">
        {prompts.map(({ label, prompt }, index) => (
          <button
            key={label}
            type="button"
            onClick={() => onPrompt(prompt)}
            disabled={streaming}
            data-testid={
              index === 0 && hasScenes ? 'scenario-analyze' : `scenario-starter-${index}`
            }
            className="sp-btn-ghost flex items-center gap-2 border-[2px] border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-3 py-2.5 text-left text-[13px] font-semibold text-[color:var(--color-fg)] hover:border-[color:var(--color-line)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Zap size={12} className="shrink-0" aria-hidden />
            <span>{label}</span>
            <span className="ml-auto" aria-hidden>
              →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatBubble({
  role,
  content,
  tierName,
  streaming,
}: {
  role: 'user' | 'assistant';
  content: string;
  tierName: string;
  streaming?: boolean;
}) {
  const user = role === 'user';
  return (
    <div
      data-testid={`scenario-chat-${role}`}
      aria-live={streaming ? 'polite' : undefined}
      className={`max-w-[88%] px-3 py-2 ${
        user
          ? 'self-end bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
          : 'self-start bg-[color:var(--color-surface2)] text-[color:var(--color-fg)]'
      }`}
    >
      <span className="mb-1 block font-mono text-[11px] uppercase tracking-widest opacity-70">
        {user ? 'Вы' : tierName ? `Редактор · ${tierName}` : 'Редактор'}
      </span>
      <span className="whitespace-pre-wrap text-[13px] leading-relaxed">{content}</span>
      {streaming && <span className="seed-caret">▮</span>}
    </div>
  );
}

/** The anchored fragment. In a note card it's a button: click = show on the sheet
 *  + ghost-preview the rewrite at the anchor (replaces the «К месту» button, R4). */
function QuoteStrip({ text, onClick }: { text: string; onClick?: () => void }) {
  const body = (
    <span
      className="block truncate text-[13px] text-[color:var(--color-paper-ink)]"
      style={{ fontFamily: COURIER }}
    >
      {text}
    </span>
  );
  if (!onClick)
    return (
      <div className="border-b-[2px] border-[color:var(--color-line-soft)] border-l-[2.5px] border-l-[color:var(--color-line)] bg-[color:var(--color-paper)] px-3 py-2">
        {body}
      </div>
    );
  return (
    <button
      onClick={onClick}
      title="Показать на листе"
      data-testid="scenario-preview"
      className="group block w-full cursor-pointer border-b-[2px] border-[color:var(--color-line-soft)] border-l-[2.5px] border-l-[color:var(--color-line)] bg-[color:var(--color-paper)] px-3 py-2 text-left transition-colors hover:bg-[color:var(--color-paper-hover)] focus-visible:bg-[color:var(--color-paper-hover)] focus-visible:outline-none"
    >
      <span className="flex items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--color-paper-ink)]"
          style={{ fontFamily: COURIER }}
        >
          {text}
        </span>
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-paper-ink)]/40 group-hover:text-[color:var(--color-paper-ink)]/80">
          на листе →
        </span>
      </span>
    </button>
  );
}

function NoteCard(props: {
  thread: Thread;
  proposal: Proposal | null;
  error: 'rev_conflict' | 'anchor_detached' | null;
  tiers: Tier[];
  /** Live streamed reply text when this note is the active stream target (R4). */
  streaming: string | null;
  streamPhase: 'preparing' | 'thinking' | 'typing';
  streamTierName: string;
  /** A stream is active anywhere — disables «Обсудить» send to avoid abort races. */
  streamActive: boolean;
  onApply: () => void;
  onDismiss: () => void;
  onReveal: () => void;
  onPreview: () => void;
  onDiscuss: (question: string) => void;
  onAddNote: (text: string) => void;
}) {
  const {
    thread,
    proposal,
    error,
    tiers,
    streaming,
    streamPhase,
    streamTierName,
    streamActive,
    onApply,
    onDismiss,
    onReveal,
    onPreview,
    onDiscuss,
    onAddNote,
  } = props;
  const detached = error === 'anchor_detached' || thread.status === 'detached';
  const reply = lastAssistant(thread);
  // Trigger 2 (§5): a generalizable <rule> the model attached — nudge only when
  // the tag came back, only after apply, never on every message.
  const rawReply =
    [...thread.messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
  const rule = CANON_ACCRETION_ENABLED ? extractRule(rawReply) : null;
  const [nudgeHidden, setNudgeHidden] = useState(false);
  const applied = thread.status === 'applied';
  const showRuleNudge =
    CANON_ACCRETION_ENABLED && applied && !!rule && !nudgeHidden && !ruleDeclined(rule);
  const quote = thread.anchor?.quote?.trim() || (thread.anchor ? '' : null);
  const sig = modelLabel(tiers.find((t) => t.id === reply?.tier)?.model);

  // «Обсудить» inline comment box (R4).
  const [discussing, setDiscussing] = useState(false);
  const [comment, setComment] = useState('');
  const sendDiscuss = () => {
    const q = comment.trim();
    if (!q || streamActive) return;
    onDiscuss(q);
    setComment('');
    setDiscussing(false);
  };

  return (
    <div
      className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)]"
      data-testid="scenario-note"
    >
      {/* quote strip (anchored, click = show on sheet) or a whole-script label */}
      {quote ? (
        <QuoteStrip text={quote} onClick={onPreview} />
      ) : (
        <div className="border-b-[2px] border-[color:var(--color-line-soft)] px-3 py-1.5">
          <span className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted-foreground)]">
            <Zap size={10} aria-hidden />
            Разбор сценария
          </span>
        </div>
      )}

      {/* the user's ask + reply */}
      <div className="px-3 pt-2.5">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted-foreground)]">
          {firstUser(thread)}
        </p>
        {streaming !== null ? (
          <p className="text-[13px] leading-relaxed text-[color:var(--color-fg)]">
            {streaming ||
              (streamPhase === 'thinking'
                ? 'Обдумывает ответ…'
                : streamPhase === 'typing'
                  ? 'Печатает…'
                  : 'Готовит ответ…')}
            <span className="ml-1 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              {streamTierName}
            </span>
          </p>
        ) : (
          <>
            {reply?.content && (
              <p className="text-[13px] leading-relaxed text-[color:var(--color-fg)]">
                {reply.content}
              </p>
            )}
            {sig && (
              <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                Редактор · {sig}
              </p>
            )}
          </>
        )}
      </div>

      {/* proposal — hidden while streaming a fresh reply into the card */}
      {proposal && streaming === null && !detached && !applied && (
        <div className="px-3">
          <p className="mt-2 font-mono text-[11px] uppercase tracking-widest text-[color:var(--color-positive)]">
            Станет
          </p>
          <pre
            className="mt-1 overflow-x-auto border-l-[2.5px] border-[color:var(--color-positive)] bg-[color:var(--color-paper)] px-3 py-2 text-[13px] leading-relaxed text-[color:var(--color-paper-ink)]"
            style={{ fontFamily: COURIER, whiteSpace: 'pre-wrap' }}
          >
            {proposal.after}
          </pre>
          <details className="mt-1.5">
            <summary className="inline-flex cursor-pointer items-center gap-1 font-mono text-[11px] tracking-wide text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]">
              <ChevronRight size={12} aria-hidden />
              Показать было
            </summary>
            <pre
              className="mt-1 overflow-x-auto border-l-[2.5px] border-[color:var(--color-line-soft)] bg-[color:var(--color-surface)] px-3 py-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]"
              style={{ fontFamily: COURIER, whiteSpace: 'pre-wrap' }}
            >
              {proposal.before}
            </pre>
          </details>
        </div>
      )}

      {/* «Обсудить» inline comment box */}
      {discussing && streaming === null && (
        <div className="px-3 pt-2">
          <textarea
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setDiscussing(false);
                setComment('');
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendDiscuss();
              }
            }}
            rows={2}
            placeholder="Что не так? Редактор перепишет…"
            data-testid="scenario-discuss-input"
            className="w-full resize-none border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-2.5 py-1.5 text-[13px] text-[color:var(--color-fg)] outline-none focus-visible:border-[color:var(--color-accent)]"
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button
              onClick={() => {
                setDiscussing(false);
                setComment('');
              }}
              className="sp-btn-ghost px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]"
            >
              Отмена
            </button>
            <button
              onClick={sendDiscuss}
              disabled={streamActive || comment.trim() === ''}
              data-testid="scenario-discuss-send"
              className="sp-btn border-[2px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-primary-foreground)]"
            >
              Отправить
            </button>
          </div>
        </div>
      )}

      {/* actions — [Применить] [Отклонить] [Обсудить] (R4) */}
      {streaming === null && !discussing && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-3">
          {detached ? (
            <>
              <span className="font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
                Фрагмент изменился
              </span>
              <button
                onClick={onReveal}
                className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-2 py-1 text-[13px] font-semibold text-[color:var(--color-muted-foreground)]"
              >
                Показать место
              </button>
              <button
                onClick={() => setDiscussing(true)}
                data-testid="scenario-discuss"
                className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-2 py-1 text-[13px] font-semibold text-[color:var(--color-muted-foreground)]"
              >
                Обсудить
              </button>
            </>
          ) : error === 'rev_conflict' ? (
            <>
              <span className="font-mono text-[11px] text-[color:var(--color-accent2)]">
                Текст изменился после ответа
              </span>
              <button
                onClick={onReveal}
                className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-2 py-1 text-[13px] font-semibold text-[color:var(--color-muted-foreground)]"
              >
                Показать место
              </button>
            </>
          ) : (
            <>
              {proposal && (
                <button
                  onClick={onApply}
                  data-testid="scenario-apply"
                  className="sp-btn border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3 py-1.5 text-[13px] font-bold text-[color:var(--color-primary-foreground)]"
                >
                  Применить
                </button>
              )}
              <button
                onClick={onDismiss}
                data-testid="scenario-dismiss"
                className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-3 py-1.5 text-[13px] font-semibold text-[color:var(--color-muted-foreground)]"
              >
                Отклонить
              </button>
              <button
                onClick={() => setDiscussing(true)}
                data-testid="scenario-discuss"
                className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-3 py-1.5 text-[13px] font-semibold text-[color:var(--color-muted-foreground)]"
              >
                Обсудить
              </button>
            </>
          )}
        </div>
      )}

      {/* rule nudge — only when the model attached a <rule> (§5) */}
      {showRuleNudge && rule && (
        <div
          className="m-3 mt-0 border-[2.5px] border-[color:var(--color-accent2)] bg-[rgba(var(--accent2-rgb),0.07)] px-3 py-2"
          data-testid="scenario-rule-nudge"
        >
          <p className="text-[13px] leading-relaxed text-[color:var(--color-fg)]">
            Записать в мир: «<span className="text-[color:var(--color-accent2)]">{rule}</span>»?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                onAddNote(rule);
                setNudgeHidden(true);
              }}
              data-testid="scenario-rule-write"
              className="sp-btn border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent2)] px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-accent2-foreground)]"
            >
              Записать
            </button>
            <button
              onClick={() => {
                declineRule(rule);
                setNudgeHidden(true);
              }}
              className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]"
            >
              Позже
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** ИСТОРИЯ (R5): the read-only ledger of what happened to the text — one row per
 *  applied/rejected proposal, newest first. Footer opens the snapshots sheet. */
function HistoryLedger({
  rows,
  tiers,
  lastProposal,
  onReveal,
  onRevert,
  onOpenVersions,
}: {
  rows: Thread[];
  tiers: Tier[];
  lastProposal: (thread: Thread) => { proposal: Proposal; index: number } | null;
  onReveal: (thread: Thread) => void;
  onRevert?: ((threadId: string) => void) | undefined;
  onOpenVersions: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="scenario-history">
      <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
        {rows.length === 0 ? (
          <p
            className="my-6 text-center text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]"
            data-testid="scenario-history-empty"
          >
            Здесь появится всё, что вы применили или отклонили — с текстом «было → станет» и
            возможностью вернуться на место.
          </p>
        ) : (
          rows.map((t) => (
            <HistoryRow
              key={t.id}
              thread={t}
              proposal={lastProposal(t)?.proposal ?? null}
              tiers={tiers}
              onReveal={() => onReveal(t)}
              onRevert={onRevert}
            />
          ))
        )}
      </div>
      <div className="border-t-[2.5px] border-[color:var(--color-line)] px-4 py-3">
        <button
          onClick={onOpenVersions}
          data-testid="scenario-open-versions"
          className="sp-btn-ghost flex w-full items-center justify-between border-[2px] border-[color:var(--color-line-soft)] px-3 py-2 text-[13px] font-semibold text-[color:var(--color-fg)]"
        >
          <span>Все версии листа</span>
          <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  );
}

function HistoryRow({
  thread,
  proposal,
  tiers,
  onReveal,
  onRevert,
}: {
  thread: Thread;
  proposal: Proposal | null;
  tiers: Tier[];
  onReveal: () => void;
  onRevert?: ((threadId: string) => void) | undefined;
}) {
  const applied = thread.status === 'applied';
  const reply = lastAssistant(thread);
  const sig = modelLabel(tiers.find((t) => t.id === reply?.tier)?.model);
  const quote = thread.anchor?.quote?.trim();

  return (
    <div
      className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)]"
      data-testid="scenario-history-row"
    >
      <div className="flex items-center gap-2 border-b-[2px] border-[color:var(--color-line-soft)] px-3 py-1.5">
        {applied ? (
          <span className="inline-flex items-center gap-1 border-[2px] border-[color:var(--color-positive)] px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-positive)]">
            <Check size={12} aria-hidden />
            применено
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 border-[2px] border-[color:var(--color-line-soft)] px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            <X size={12} aria-hidden />
            отклонено
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] tracking-wider text-[color:var(--color-muted-foreground)]">
          {fmtWhen(thread.updatedAt)}
        </span>
      </div>

      <div className="px-3 py-2">
        {quote ? (
          <p
            className="truncate text-[13px] text-[color:var(--color-muted-foreground)]"
            style={{ fontFamily: COURIER }}
          >
            {quote}
          </p>
        ) : (
          <p className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted-foreground)]">
            <Zap size={10} aria-hidden />
            Разбор сценария
          </p>
        )}

        {proposal ? (
          <details className="mt-1.5">
            <summary className="inline-flex cursor-pointer items-center gap-1 font-mono text-[11px] tracking-wide text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]">
              <ChevronRight size={12} aria-hidden />
              было → станет
            </summary>
            <pre
              className="mt-1 overflow-x-auto border-l-[2.5px] border-[color:var(--color-line-soft)] bg-[color:var(--color-surface)] px-3 py-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]"
              style={{ fontFamily: COURIER, whiteSpace: 'pre-wrap' }}
            >
              {proposal.before}
            </pre>
            <pre
              className="mt-1 overflow-x-auto border-l-[2.5px] border-[color:var(--color-positive)] bg-[color:var(--color-paper)] px-3 py-2 text-[13px] leading-relaxed text-[color:var(--color-paper-ink)]"
              style={{ fontFamily: COURIER, whiteSpace: 'pre-wrap' }}
            >
              {proposal.after}
            </pre>
          </details>
        ) : (
          reply?.content && (
            <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              {reply.content}
            </p>
          )
        )}

        <div className="mt-2 flex items-center gap-2">
          {thread.anchor && (
            <button
              onClick={onReveal}
              data-testid="scenario-history-reveal"
              className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]"
            >
              показать место
            </button>
          )}
          {applied && onRevert && (
            <button
              onClick={() => onRevert(thread.id)}
              data-testid="scenario-history-revert"
              className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-destructive)]"
            >
              Отменить
            </button>
          )}
          {sig && (
            <span className="ml-auto font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              {sig}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
