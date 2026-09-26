'use client';

import { useEffect, useRef, useState } from 'react';
import { Film, Loader2, X } from '@/components/ui/icons';
import { withProjectContext } from '@/lib/project-context';
import { SCENARIO_SHOT_PLAN_CREDITS } from '@seed/shared';
import {
  formatSeconds,
  sceneSeconds,
  sceneTimingConfirmed,
  type SceneTiming,
} from '../useSceneTimings';
import { useProjectContext } from '../../_components/ProjectContextProvider';

interface ScenePreview {
  ordinal: number;
  heading: string;
  synopsis: string;
}

interface BoardOption {
  id: string;
  title: string;
}

interface Receipt {
  boardId: string;
  title: string;
  created: boolean;
  replayed?: boolean;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  materializedShots?: number;
}

function planErrorCopy(ordinal: number, error: string | undefined): string {
  if (error === 'insufficient_credits') return 'Не хватает токенов на план кадров. Пополни баланс.';
  if (error === 'signup_required') return 'План кадров доступен после входа.';
  if (error === 'shot_plan_daily_quota') return 'Дневной лимит планов исчерпан. Попробуй завтра.';
  if (error === 'shot_plan_in_progress')
    return `План сцены ${ordinal} уже строится. Повтори позже.`;
  return `Не удалось разложить на кадры сцену ${ordinal}. Повтори — готовые сцены не спишутся заново.`;
}

export function ScenarioBoardHandoff({
  apiUrl,
  scriptId,
  workspaceProjectId,
  saveNow,
  isAnonymous,
  reloadTimings,
  setSeconds,
}: {
  apiUrl: string;
  scriptId: string;
  workspaceProjectId: string | null;
  saveNow: () => Promise<boolean>;
  isAnonymous: boolean;
  reloadTimings: () => Promise<SceneTiming[] | null>;
  setSeconds: (sourceUnitId: string, seconds: number) => Promise<boolean>;
}) {
  const projectContext = useProjectContext();
  const destinationProjectTitle =
    workspaceProjectId &&
    projectContext.mode === 'valid' &&
    projectContext.project.id === workspaceProjectId
      ? projectContext.project.title
      : null;
  const [open, setOpen] = useState(false);
  const [scenes, setScenes] = useState<ScenePreview[] | null>(null);
  const [boards, setBoards] = useState<BoardOption[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [boardId, setBoardId] = useState('new');
  const [busy, setBusy] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  // «Раскадровать» means shots, not just scene cards; guests can't plan yet.
  const [withPlans, setWithPlans] = useState(!isAnonymous);
  const [timings, setTimings] = useState<SceneTiming[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const idempotencyKey = useRef(`scenario-board-${crypto.randomUUID()}`);

  // Each opening is a fresh look at the script (the author edits between runs),
  // so reload the scenes. The dialog cannot close mid-run: paid planning and the
  // handoff would carry on unseen. The key survives a close unless the handoff
  // landed, so a retry after a lost response still replays the same board; a
  // changed payload is caught server-side as idempotency_payload_mismatch.
  const close = () => {
    if (busy) return;
    setOpen(false);
    setScenes(null);
    setTimings(null);
    if (receipt) idempotencyKey.current = `scenario-board-${crypto.randomUUID()}`;
    setReceipt(null);
    setError(null);
  };

  useEffect(() => {
    if (!open || scenes !== null) return;
    const projectSuffix = workspaceProjectId
      ? `?projectId=${encodeURIComponent(workspaceProjectId)}`
      : '';
    void Promise.all([
      fetch(`${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/board-handoff`, {
        credentials: 'include',
      }),
      fetch(`${apiUrl}/v1/boards${projectSuffix}`, { credentials: 'include' }),
    ])
      .then(async ([previewResponse, boardsResponse]) => {
        if (!previewResponse.ok || !boardsResponse.ok) throw new Error('load');
        const preview = (await previewResponse.json()) as { scenes: ScenePreview[] };
        const boardList = (await boardsResponse.json()) as { items: BoardOption[] };
        setScenes(preview.scenes);
        setTimings(await reloadTimings());
        setSelected(new Set(preview.scenes.map((scene) => scene.ordinal)));
        setBoards(boardList.items);
      })
      .catch(() => setError('Не удалось подготовить передачу в борд.'));
  }, [apiUrl, open, scenes, scriptId, workspaceProjectId, reloadTimings]);

  /** Confirm each selected scene's seconds, then plan its shots (cached plans are free). */
  async function planShots(): Promise<boolean> {
    const fresh = await reloadTimings();
    const byOrdinal = new Map((fresh ?? []).map((scene) => [scene.ordinal, scene]));
    const ordinals = [...selected].sort((a, b) => a - b);
    for (const ordinal of ordinals) {
      const scene = byOrdinal.get(ordinal);
      const seconds = scene ? sceneSeconds(scene) : null;
      if (!scene || !seconds) {
        setError(`Задай длительность сцены ${ordinal} — без неё кадры не разложить.`);
        return false;
      }
      if (!sceneTimingConfirmed(scene) && !(await setSeconds(scene.sourceUnitId, seconds))) {
        setError('Не удалось сохранить хронометраж. Повтори ещё раз.');
        return false;
      }
    }
    for (const [index, ordinal] of ordinals.entries()) {
      const scene = byOrdinal.get(ordinal)!;
      setProgress(`Раскладываем на кадры: сцена ${index + 1} из ${ordinals.length}…`);
      const response = await fetch(
        `${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/scenes/${encodeURIComponent(scene.sourceUnitId)}/shot-plan`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      ).catch(() => null);
      if (!response?.ok) {
        const body = (await response?.json().catch(() => ({}))) as { error?: string } | undefined;
        setError(planErrorCopy(ordinal, body?.error));
        return false;
      }
    }
    return true;
  }

  async function submit() {
    if (!scenes || selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    if (!(await saveNow())) {
      setError('Сначала сохраните сценарий и разрешите конфликт версии.');
      setBusy(false);
      return;
    }
    if (withPlans && !(await planShots())) {
      setProgress(null);
      setBusy(false);
      return;
    }
    setProgress('Собираем борд…');
    try {
      const response = await fetch(
        `${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/board-handoff`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ordinals: [...selected].sort((a, b) => a - b),
            destination: boardId === 'new' ? 'new' : 'board',
            ...(boardId === 'new' ? {} : { boardId }),
            fullSync: selected.size === scenes.length,
            idempotencyKey: idempotencyKey.current,
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as Receipt & { error?: string };
      if (!response.ok) {
        if (body.error === 'project_mismatch') {
          throw new Error('Выбранный борд относится к другому проекту.');
        }
        if (body.error === 'board_rev_conflict') {
          throw new Error(body.error);
        }
        if (body.error === 'shot_plan_unreconcilable') {
          throw new Error(body.error);
        }
        if (body.error === 'board_capacity_exceeded' || body.error === 'board_state_too_large') {
          throw new Error(body.error);
        }
        if (body.error === 'idempotency_payload_mismatch') {
          // The request changed after a lost response — auto-rotate so the
          // next deliberate press is a fresh logical handoff, then hint retry.
          idempotencyKey.current = `scenario-board-${crypto.randomUUID()}`;
          throw new Error(body.error);
        }
        throw new Error(body.error ?? 'handoff');
      }
      setReceipt(body);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      if (code.includes('другому проекту')) {
        setError(code);
      } else if (code === 'board_rev_conflict') {
        setError('Борд изменился, пока вы выбирали сцены. Обновите предпросмотр и повторите.');
      } else if (code === 'shot_plan_unreconcilable') {
        setError('Не удалось согласовать тайминги сцен. Подтвердите тайминги ещё раз и повторите.');
      } else if (code === 'board_capacity_exceeded' || code === 'board_state_too_large') {
        setError('Сцены не помещаются в борд. Уберите часть сцен и повторите.');
      } else if (code === 'idempotency_payload_mismatch') {
        setError(
          'Запрос изменился после сбоя. Ключ уже обновлён — нажмите «Передать сцены» ещё раз.',
        );
      } else {
        setError('Передача не завершена. Повторите — тот же запрос не создаст дубль.');
      }
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  const planCredits = selected.size * SCENARIO_SHOT_PLAN_CREDITS;
  const totalSeconds = (timings ?? [])
    .filter((scene) => selected.has(scene.ordinal))
    .reduce((sum, scene) => sum + (sceneSeconds(scene) ?? 0), 0);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="sp-btn inline-flex items-center gap-1.5 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3 py-1.5 text-[13px] font-extrabold text-[color:var(--color-primary-foreground)]"
        data-testid="scenario-board-open"
      >
        <Film size={13} /> Раскадровать
      </button>
      {open && (
        <div className="fixed inset-0 z-[100] grid place-items-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={close} />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="scenario-board-title"
            className="glass-menu relative flex max-h-[88dvh] w-full max-w-[680px] flex-col p-5"
            data-testid="scenario-board-dialog"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="scenario-board-title" className="font-display text-xl font-black">
                  Раскадровка
                </h2>
                <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
                  {selected.size} сцен{totalSeconds > 0 ? ` · ${formatSeconds(totalSeconds)}` : ''}{' '}
                  → борд с кадрами и готовыми промптами. Сцены останутся связаны со сценарием.
                </p>
              </div>
              <button type="button" aria-label="Закрыть" onClick={close} disabled={busy}>
                <X size={17} />
              </button>
            </div>

            {receipt ? (
              <div className="mt-5" data-testid="scenario-board-receipt">
                <p className="font-semibold">
                  {receipt.replayed
                    ? `Передача уже была выполнена: «${receipt.title}»`
                    : receipt.created
                      ? `Создан борд «${receipt.title}»`
                      : `Обновлён борд «${receipt.title}»`}
                </p>
                <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
                  Добавлено {receipt.added} · обновлено {receipt.updated} · помечено удалёнными{' '}
                  {receipt.removed}
                  {receipt.skipped > 0 ? ` · пропущено ${receipt.skipped}` : ''}
                  {receipt.materializedShots ? ` · кадров ${receipt.materializedShots}` : ''}
                </p>
                {workspaceProjectId && (
                  <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
                    Борд открыт в проекте «{destinationProjectTitle ?? 'Среда'}».
                  </p>
                )}
                <button
                  type="button"
                  disabled={navigating}
                  onClick={() => {
                    setNavigating(true);
                    const href = workspaceProjectId
                      ? withProjectContext(`/boards/${receipt.boardId}`, workspaceProjectId)
                      : `/boards/${receipt.boardId}`;
                    window.location.assign(href);
                  }}
                  className="mt-4 inline-block font-semibold underline decoration-2 underline-offset-4 disabled:opacity-60"
                  data-testid="scenario-board-open-result"
                >
                  {navigating ? 'Открываем борд…' : 'Открыть в борде →'}
                </button>
              </div>
            ) : (
              <>
                <label className="mt-5 text-[13px] font-semibold">
                  Куда передать
                  <select
                    value={boardId}
                    onChange={(event) => {
                      setBoardId(event.target.value);
                      idempotencyKey.current = `scenario-board-${crypto.randomUUID()}`;
                    }}
                    className="mt-2 block h-10 w-full border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3"
                    data-testid="scenario-board-destination"
                  >
                    <option value="new">Новый борд в этом проекте</option>
                    {boards.map((board) => (
                      <option key={board.id} value={board.id}>
                        {board.title}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="seed-scroll mt-4 max-h-64 space-y-1 overflow-y-auto">
                  {scenes === null ? (
                    <Loader2 className="m-5 seed-spin" />
                  ) : scenes.length === 0 ? (
                    <p className="text-[13px]">В сценарии пока нет сцен.</p>
                  ) : (
                    scenes.map((scene) => (
                      <label
                        key={scene.ordinal}
                        className="flex gap-3 border-b border-[color:var(--color-line-soft)] py-2 text-[13px]"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(scene.ordinal)}
                          onChange={() =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (next.has(scene.ordinal)) next.delete(scene.ordinal);
                              else next.add(scene.ordinal);
                              idempotencyKey.current = `scenario-board-${crypto.randomUUID()}`;
                              return next;
                            })
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <strong>{scene.heading}</strong>
                          {scene.synopsis && (
                            <span className="mt-0.5 block text-[13px] text-[color:var(--color-muted-foreground)]">
                              {scene.synopsis}
                            </span>
                          )}
                        </span>
                        {(() => {
                          const timing = timings?.find((item) => item.ordinal === scene.ordinal);
                          const seconds = timing ? sceneSeconds(timing) : null;
                          return seconds ? (
                            <span className="shrink-0 font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
                              {formatSeconds(seconds)}
                            </span>
                          ) : null;
                        })()}
                      </label>
                    ))
                  )}
                </div>
                <label className="mt-4 flex items-start gap-3 text-[13px]">
                  <input
                    type="checkbox"
                    checked={withPlans}
                    disabled={isAnonymous || busy}
                    onChange={(event) => {
                      setWithPlans(event.target.checked);
                      idempotencyKey.current = `scenario-board-${crypto.randomUUID()}`;
                    }}
                    className="mt-0.5"
                    data-testid="scenario-board-plan"
                  />
                  <span>
                    <strong>Сразу разложить на кадры</strong>
                    <span className="mt-0.5 block text-[color:var(--color-muted-foreground)]">
                      {isAnonymous
                        ? 'Доступно после входа. Без этого в борд уйдут карточки сцен.'
                        : `${SCENARIO_SHOT_PLAN_CREDITS} ток за сцену · уже разложенные сцены бесплатно. Картинки и видео — отдельно, в борде.`}
                    </span>
                  </span>
                </label>
                {error && (
                  <p
                    className="mt-3 text-[13px] text-[color:var(--color-destructive)]"
                    role="alert"
                  >
                    {error}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy || selected.size === 0}
                  className="mt-4 inline-flex h-10 items-center justify-center gap-2 border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 font-semibold text-[color:var(--color-primary-foreground)] disabled:opacity-50"
                  data-testid="scenario-board-submit"
                >
                  {busy && <Loader2 size={14} className="seed-spin" />}
                  {withPlans ? `Раскадровать · до ${planCredits} ток` : 'Передать сцены'}
                </button>
                {progress && (
                  <p
                    className="mt-2 font-mono text-[11px] uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]"
                    data-testid="scenario-board-progress"
                  >
                    {progress}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
