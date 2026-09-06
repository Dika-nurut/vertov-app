'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ChevronLeft,
  Clapperboard,
  Film,
  Loader2,
  Lock,
  Maximize,
  Play,
  X,
} from '@/components/ui/icons';
import { TokenStar } from '@/components/ui/token-star';
import { assetSrc } from '@/lib/asset-src';
import { putBoardDocument } from '@/lib/board-persistence';
import { boardRevision, withoutBoardRevision } from '@/lib/board-recovery';
import {
  prepareBoardNodeRun,
  type BoardRunNodeLike,
  type PreparedBoardRun,
} from '@/lib/board-run-request';
import { stashHandoff } from '@/lib/handoff';
import type { ModelLike } from '@/lib/node-settings';
import { estimatePriceToShow, useJobEstimate } from '@/lib/useJobEstimate';
import { tierUpsellLabel } from '@/lib/model-tier';
import { invalidateBalance } from '../../../_components/BalanceWidget';
import { JOB_SUBMITTED_EVENT } from '../../../_components/JobsTray';
import { MOBILE_NODE_TYPES, MobileBoardProjectContext } from './MobileNodes';
import type { BoardState, GenerateData } from './types';
import { isVideoUrl } from './types';
import { normalizeBoardNodeOrder } from '@seed/shared/board-contract';

/**
 * MobileBoard — the phone board experience (≤ md). A SEPARATE, isolated code
 * path from the desktop canvas (../GraphBoard.tsx), mounted by BoardSurface only
 * on small screens. It is intentionally a clean review/run/handoff surface:
 * pannable graph, shot-state sheet, confirmed launch of an already-prepared shot,
 * and completed-video transfer to Studio. Complex graph construction and run
 * setup remain desktop-only.
 */
export interface MobileBoardProps {
  boardId: string;
  initialTitle: string;
  initialState: Record<string, unknown>;
  models: ModelLike[];
  planTier: string | null;
  lockedCtaHref: string;
  apiUrl: string;
  workspaceProjectId?: string | null;
  devTools?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'не снят',
  running: 'идёт…',
  done: 'готово',
  failed: 'ошибка',
};
const STATUS_CLASS: Record<string, string> = {
  idle: 'text-[color:var(--color-faint)]',
  running: 'text-[color:var(--color-accent)]',
  done: 'text-[color:var(--color-accent2)]',
  failed: 'text-[color:var(--color-destructive)]',
};

type Sheet = 'scenes' | null;

type ReadyRun = Extract<PreparedBoardRun, { ok: true }> & { idempotencyKey: string };

function mobileRunKey(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function Canvas({
  boardId,
  initialTitle,
  initialState,
  models,
  planTier,
  lockedCtaHref,
  apiUrl,
}: MobileBoardProps) {
  const state = initialState as BoardState;
  const initialNodes = useMemo(
    () => normalizeBoardNodeOrder((state.nodes as Node[] | undefined) ?? []),
    [state.nodes],
  );
  const initialEdges = useMemo(() => (state.edges as Edge[] | undefined) ?? [], [state.edges]);

  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [readyRun, setReadyRun] = useState<ReadyRun | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [runUpsell, setRunUpsell] = useState(false);
  const revisionRef = useRef(boardRevision(initialState));
  const rf = useReactFlow();
  const router = useRouter();

  const shots = useMemo(
    () =>
      nodes
        .filter((n) => n.type === 'generate')
        .map((n) => ({ id: n.id, d: n.data as unknown as GenerateData })),
    [nodes],
  );
  const studioUrls = useMemo(
    () =>
      shots.flatMap(({ d }) =>
        d.status === 'done' && d.resultUrl && (d.resultKind === 'video' || isVideoUrl(d.resultUrl))
          ? [d.resultUrl]
          : [],
      ),
    [shots],
  );
  function centerOn(id: string) {
    const n = nodes.find((x) => x.id === id);
    if (!n) return;
    const w = (n.width as number) ?? 150;
    const h = (n.height as number) ?? 90;
    rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: 1, duration: 400 });
  }

  const selNode = selId ? nodes.find((n) => n.id === selId) : null;
  const selectedShot =
    selNode?.type === 'generate' ? (selNode.data as unknown as GenerateData) : null;
  // Bumped when the server refuses a submit with `quote_stale`, so the sheet
  // re-quotes inputs that did not change — the catalogue moved, not the request.
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  const estimate = useJobEstimate({
    apiUrl,
    modelId: readyRun?.request.modelId,
    prompt: readyRun?.request.prompt ?? '',
    params: readyRun?.request.params ?? {},
    source: 'boards',
    enabled: Boolean(readyRun),
    refreshToken: quoteRefresh,
  });
  const quotedCost = estimatePriceToShow(estimate);
  const priceRefusal = estimate.refusal;

  const requestRun = (nodeId: string) => {
    setRunUpsell(false);
    const prepared = prepareBoardNodeRun({
      nodes: nodes as unknown as BoardRunNodeLike[],
      edges: initialEdges,
      nodeId,
      models,
      planTier,
    });
    if (!prepared.ok) {
      setRunUpsell(prepared.reasonCode === 'tier_required');
      setNotice(prepared.reason);
      return;
    }
    setNotice(null);
    setReadyRun({ ...prepared, idempotencyKey: mobileRunKey() });
  };

  const submitRun = async () => {
    if (!readyRun || runBusy || quotedCost === null) return;
    setRunBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiUrl}/v1/jobs`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...readyRun.request,
          idempotencyKey: readyRun.idempotencyKey,
          // Quote binding: `estimate` above quotes THIS exact request, so the number
          // on the sheet is the number bound here. A catalogue change between the two
          // returns 409 `quote_stale` and charges nothing.
          expectedCost: quotedCost,
        }),
      });
      if (response.status === 402) {
        invalidateBalance();
        setNotice('Недостаточно токенов — пополни баланс.');
        return;
      }
      if (response.status === 403) {
        const body = await response.json().catch(() => null);
        if (body?.error === 'signup_required') {
          router.push(`/login?next=${encodeURIComponent(`/boards/${boardId}`)}`);
          return;
        }
        if (body?.error === 'tier_required') {
          setRunUpsell(true);
          setNotice(tierUpsellLabel(models.find((model) => model.id === readyRun.request.modelId)));
        } else {
          setNotice('Эта модель недоступна на вашем тарифе.');
        }
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        // The price moved under the quote on the sheet. Nothing was charged; pull a
        // fresh number and let the user decide again. The server's message names both.
        if (body?.error === 'quote_stale') setQuoteRefresh((n) => n + 1);
        // A 4xx is something the user can act on and the server names it — show
        // that text. A 5xx is NOT: a kill-switch or a spend cap carries no
        // message, and telling someone to «check the frame settings» while
        // generation is switched off platform-wide sends them to fix the one
        // thing that is not broken. Keep the status visible for those.
        setNotice(
          response.status < 500 && typeof body?.message === 'string'
            ? body.message
            : `Не удалось запустить (HTTP ${response.status})`,
        );
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const jobId =
        typeof body === 'object' &&
        body !== null &&
        'jobId' in body &&
        typeof body.jobId === 'string'
          ? body.jobId
          : null;
      if (!jobId) {
        setNotice('Сервер не подтвердил запуск. Попробуйте ещё раз.');
        return;
      }

      const nextNodes = nodes.map((node) =>
        node.id === readyRun.nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                status: 'running',
                jobId,
                failureMessage: undefined,
                failureAction: undefined,
              },
            }
          : node,
      );
      setNodes(nextNodes);
      setReadyRun(null);
      invalidateBalance();
      window.dispatchEvent(new Event(JOB_SUBMITTED_EVENT));

      const saved = await putBoardDocument({
        apiUrl,
        boardId,
        expectedRev: revisionRef.current,
        state: withoutBoardRevision({ ...initialState, nodes: nextNodes, edges: initialEdges }),
      });
      if (saved.kind === 'saved') {
        revisionRef.current = saved.rev;
        setNotice('Кадр запущен. Статус виден здесь и в трее задач.');
      } else if (saved.kind === 'conflict') {
        setNotice('Кадр запущен в трее, но борд изменился в другой вкладке. Обновите страницу.');
      } else {
        setNotice('Кадр запущен в трее, но статус борда пока не сохранён.');
      }
    } catch {
      setNotice('Нет связи с сервером — кадр не был запущен.');
    } finally {
      setRunBusy(false);
    }
  };

  return (
    <div
      data-testid="mobile-board"
      className="relative h-[100dvh] w-full overflow-hidden bg-[color:var(--color-bg)]"
    >
      <ReactFlow
        nodes={nodes}
        edges={initialEdges}
        nodeTypes={MOBILE_NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        zoomOnPinch
        panOnDrag
        panOnScroll={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => setSelId(n.id)}
        onPaneClick={() => setSelId(null)}
        className="bg-[color:var(--color-bg)]"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.4}
          color="rgba(236,238,243,0.12)"
        />
      </ReactFlow>

      {/* Header — back · title · save state. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-2.5 border-b-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 py-2.5">
        <Link
          href="/boards"
          aria-label="К бордам"
          className="press-inset pointer-events-auto grid h-8 w-8 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] text-[color:var(--color-fg)]"
        >
          <ChevronLeft size={16} />
        </Link>
        <h1 className="font-display flex-1 truncate text-[15px] font-black tracking-tight text-[color:var(--color-fg)]">
          {initialTitle || 'Борд'}
        </h1>
        <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-accent2)]">
          синхр.
        </span>
      </header>

      {/* Contextual review bar — appears on node select and locates the node. */}
      {selNode && (
        <div className="absolute bottom-[84px] left-1/2 z-20 flex -translate-x-1/2 overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] shadow-[3px_3px_0_0_var(--color-shadow)]">
          <span className="flex items-center border-r-2 border-[color:var(--color-line)] px-3 font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            {nodeLabel(selNode.type)}
          </span>
          <button
            type="button"
            onClick={() => centerOn(selNode.id)}
            className="press-inset flex flex-col items-center gap-0.5 px-4 py-2 font-mono text-[11px] font-bold uppercase text-[color:var(--color-fg)]"
          >
            <Maximize size={15} />В центр
          </button>
          {selectedShot && (
            <button
              type="button"
              data-testid="mobile-board-run"
              disabled={selectedShot.status === 'running'}
              onClick={() => requestRun(selNode.id)}
              className="press-inset flex flex-col items-center gap-0.5 border-l-2 border-[color:var(--color-line)] px-3 py-2 font-mono text-[11px] font-bold uppercase text-[color:var(--color-fg)] disabled:opacity-45"
            >
              <Play size={15} />
              {selectedShot.status === 'running'
                ? 'Идёт'
                : selectedShot.status === 'done'
                  ? 'Переснять'
                  : selectedShot.status === 'failed'
                    ? 'Повторить'
                    : 'Запустить'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setSelId(null)}
            aria-label="Снять выделение"
            className="press-inset grid place-items-center border-l-2 border-[color:var(--color-line)] px-3 text-[color:var(--color-muted-foreground)]"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {/* Floating review dock — status, fit, and completed-video handoff. */}
      <nav className="absolute inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-20 grid grid-cols-3 overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] shadow-[4px_4px_0_0_var(--color-shadow)]">
        <DockBtn
          label="Кадры"
          icon={<Clapperboard size={19} />}
          onClick={() => setSheet('scenes')}
        />
        <DockBtn
          label="Вписать"
          icon={<Maximize size={19} />}
          onClick={() => rf.fitView({ padding: 0.2, duration: 400 })}
          divider
        />
        <DockBtn
          testid="mobile-board-studio"
          label="В Studio"
          icon={<Film size={19} />}
          disabled={studioUrls.length === 0}
          onClick={() => {
            if (!stashHandoff('studio', studioUrls)) return;
            router.push('/studio');
          }}
        />
      </nav>

      {notice && !readyRun && (
        <div
          data-testid="mobile-board-notice"
          role="alert"
          className="absolute inset-x-3 top-16 z-30 flex items-start gap-2 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 py-2 text-[11px] leading-snug text-[color:var(--color-fg)] shadow-[3px_3px_0_0_var(--color-shadow)]"
        >
          {runUpsell ? (
            <Link
              data-testid="mobile-board-run-upsell"
              href={lockedCtaHref}
              className="flex flex-1 items-center gap-1.5 font-semibold underline underline-offset-2"
            >
              <Lock size={13} /> {notice}
            </Link>
          ) : (
            <span className="flex-1">{notice}</span>
          )}
          <button type="button" aria-label="Закрыть сообщение" onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {readyRun && (
        <div className="fixed inset-0 z-40 grid items-end" data-testid="mobile-run-confirm">
          <button
            type="button"
            aria-label="Отменить запуск"
            className="absolute inset-0 bg-black/65"
            onClick={() => setReadyRun(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-run-title"
            className="relative rounded-t-[var(--radius-md)] border-t-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
          >
            <h2 id="mobile-run-title" className="font-display text-[18px] font-black">
              Запустить подготовленный кадр?
            </h2>
            <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
              {readyRun.modelLabel} · <TokenStar size={11} className="inline-block align-[-1px]" />
              {quotedCost ?? '—'}. Настройки и связи меняются только на компьютере.
            </p>
            {priceRefusal && (
              <p
                data-testid="mobile-board-price-refusal"
                role="alert"
                className="mt-3 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-destructive)] bg-destructive/10 px-3 py-2 text-[11px] leading-snug text-[color:var(--color-fg)]"
              >
                {priceRefusal.message ??
                  'Эту конфигурацию нельзя оценить. Измените настройки кадра.'}
              </p>
            )}
            {notice && (
              <div
                data-testid="mobile-board-notice"
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-destructive)] bg-destructive/10 px-3 py-2 text-[11px] leading-snug text-[color:var(--color-fg)]"
              >
                <span className="flex-1">{notice}</span>
                <button
                  type="button"
                  aria-label="Закрыть сообщение"
                  onClick={() => setNotice(null)}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={runBusy}
                onClick={() => setReadyRun(null)}
                className="press-inset rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] px-3 py-2.5 text-[13px] font-semibold"
              >
                Отмена
              </button>
              <button
                type="button"
                data-testid="mobile-run-submit"
                disabled={runBusy || quotedCost === null}
                onClick={() => void submitRun()}
                className="press rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3 py-2.5 text-[13px] font-semibold text-[color:var(--color-primary-foreground)]"
              >
                {runBusy ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 size={13} className="seed-spin" /> Запуск…
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-0.5">
                    Запустить · <TokenStar size={12} />
                    {quotedCost ?? '—'}
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom sheet host — one at a time, dismissible. */}
      {sheet && (
        <BottomSheet title="Кадры" onClose={() => setSheet(null)}>
          {sheet === 'scenes' &&
            (shots.length ? (
              shots.map((s, i) => {
                const cover = s.d.resultUrl;
                const vid = cover && (s.d.resultKind === 'video' || isVideoUrl(cover));
                return (
                  <SheetRow
                    key={s.id}
                    onClick={() => {
                      centerOn(s.id);
                      setSelId(s.id);
                      setSheet(null);
                    }}
                    thumb={cover && !vid ? assetSrc(cover) : undefined}
                    title={`Кадр ${i + 1}${s.d.mode === 'image' ? ' · изображение' : ''}`}
                    sub={s.d.prompt?.slice(0, 40) || '—'}
                    badge={STATUS_LABEL[s.d.status ?? 'idle']}
                    badgeClass={STATUS_CLASS[s.d.status ?? 'idle']}
                  />
                );
              })
            ) : (
              <Empty text="Пока нет кадров." />
            ))}
        </BottomSheet>
      )}
    </div>
  );
}

function nodeLabel(type?: string): string {
  switch (type) {
    case 'generate':
      return 'Кадр';
    case 'prompt':
    case 'aiprompt':
      return 'Промпт';
    case 'media':
      return 'Медиа';
    case 'note':
      return 'Заметка';
    case 'text':
      return 'Текст';
    case 'frame':
      return 'Рамка';
    default:
      return 'Узел';
  }
}

function DockBtn({
  label,
  icon,
  onClick,
  divider,
  disabled,
  testid,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  divider?: boolean;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      className={
        'press-inset flex h-[58px] flex-col items-center justify-center gap-1 font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-fg)] disabled:opacity-35 ' +
        (divider ? 'border-x-2 border-[color:var(--color-line)]' : '')
      }
    >
      {icon}
      {label}
    </button>
  );
}

function BottomSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className="absolute inset-0 z-30 bg-black/55"
      />
      <div className="seed-pop-in absolute inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-[12px] border-[2.5px] border-b-0 border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-2.5">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[color:var(--color-muted-foreground)]" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-[17px] font-black tracking-tight text-[color:var(--color-fg)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] text-[color:var(--color-muted-foreground)]"
          >
            <X size={14} />
          </button>
        </div>
        <div className="space-y-2">{children}</div>
      </div>
    </>
  );
}

function SheetRow({
  thumb,
  round,
  title,
  sub,
  badge,
  badgeClass,
  onClick,
}: {
  thumb?: string | undefined;
  round?: boolean | undefined;
  title: string;
  sub: string;
  badge?: string | undefined;
  badgeClass?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press-inset flex w-full items-center gap-3 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] p-2.5 text-left"
    >
      <span
        className={
          'grid h-9 w-12 shrink-0 place-items-center overflow-hidden border-2 border-[color:var(--color-line)] bg-[color:var(--color-bg)] ' +
          (round ? 'h-9 w-9 rounded-[var(--radius-sm)]' : 'rounded-[var(--radius-xs)]')
        }
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <Clapperboard size={14} className="text-[color:var(--color-faint)]" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-[color:var(--color-fg)]">
          {title}
        </span>
        <span className="block truncate text-[11px] text-[color:var(--color-faint)]">{sub}</span>
      </span>
      {badge && (
        <span
          className={'shrink-0 font-mono text-[11px] font-bold uppercase ' + (badgeClass ?? '')}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="px-1 py-6 text-center text-[13px] text-[color:var(--color-faint)]">{text}</p>
  );
}

export function MobileBoard(props: MobileBoardProps) {
  return (
    <MobileBoardProjectContext.Provider value={props.workspaceProjectId ?? null}>
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </MobileBoardProjectContext.Provider>
  );
}
