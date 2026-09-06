'use client';

import { useEffect, useRef, useState } from 'react';
import { Film, Loader2, X } from '@/components/ui/icons';
import { withProjectContext } from '@/lib/project-context';
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
}

export function ScenarioBoardHandoff({
  apiUrl,
  scriptId,
  workspaceProjectId,
  saveNow,
}: {
  apiUrl: string;
  scriptId: string;
  workspaceProjectId: string | null;
  saveNow: () => Promise<boolean>;
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
  const idempotencyKey = useRef(`scenario-board-${crypto.randomUUID()}`);

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
        setSelected(new Set(preview.scenes.map((scene) => scene.ordinal)));
        setBoards(boardList.items);
      })
      .catch(() => setError('Не удалось подготовить передачу в борд.'));
  }, [apiUrl, open, scenes, scriptId, workspaceProjectId]);

  async function submit() {
    if (!scenes || selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    if (!(await saveNow())) {
      setError('Сначала сохраните сценарий и разрешите конфликт версии.');
      setBusy(false);
      return;
    }
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
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="sp-btn-ghost inline-flex items-center gap-1.5 border-[2px] border-[color:var(--color-line-soft)] px-2.5 py-1.5 text-[13px] font-semibold"
        data-testid="scenario-board-open"
      >
        <Film size={13} /> В борд
      </button>
      {open && (
        <div className="fixed inset-0 z-[100] grid place-items-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setOpen(false)} />
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
                  Сценарий → Борд
                </h2>
                <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
                  Сцены останутся связаны с исходным сценарием.
                </p>
              </div>
              <button type="button" aria-label="Закрыть" onClick={() => setOpen(false)}>
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
                        <span>
                          <strong>{scene.heading}</strong>
                          {scene.synopsis && (
                            <span className="mt-0.5 block text-[13px] text-[color:var(--color-muted-foreground)]">
                              {scene.synopsis}
                            </span>
                          )}
                        </span>
                      </label>
                    ))
                  )}
                </div>
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
                  Передать сцены
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
