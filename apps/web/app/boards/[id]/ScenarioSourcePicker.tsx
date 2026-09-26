'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FileText, Loader2, X } from '@/components/ui/icons';
import type { BoardDocument } from '@seed/shared/board-contract';

interface ScriptListItem {
  id: string;
  title: string;
  stats: { scenes: number };
}

interface ScenePreview {
  ordinal: number;
  heading: string;
  synopsis: string;
}

export function ScenarioSourcePicker({
  apiUrl,
  boardId,
  workspaceProjectId,
  onClose,
  beforeApply,
  onApplied,
}: {
  apiUrl: string;
  boardId: string;
  workspaceProjectId: string | null;
  onClose: () => void;
  beforeApply: () => Promise<boolean>;
  onApplied: (
    state: BoardDocument,
    summary: string,
    source: { scriptId: string; ordinals: number[] },
  ) => void;
}) {
  const [scripts, setScripts] = useState<ScriptListItem[] | null>(null);
  const [scriptId, setScriptId] = useState('');
  const [scenes, setScenes] = useState<ScenePreview[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(`board-scenario-${crypto.randomUUID()}`);

  useEffect(() => {
    const suffix = workspaceProjectId ? `?projectId=${encodeURIComponent(workspaceProjectId)}` : '';
    void fetch(`${apiUrl}/v1/scripts${suffix}`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('scripts');
        const body = (await response.json()) as { items: ScriptListItem[] };
        setScripts(body.items.filter((item) => item.stats.scenes > 0));
      })
      .catch(() => setError('Не удалось загрузить сценарии.'));
  }, [apiUrl, workspaceProjectId]);

  const chooseScript = useCallback(
    async (nextId: string) => {
      setScriptId(nextId);
      setScenes(null);
      setSelected(new Set());
      setError(null);
      // A new source script is a new logical handoff — rotate so a retry
      // can't replay the previous selection under the old key.
      idempotencyKey.current = `board-scenario-${crypto.randomUUID()}`;
      try {
        const response = await fetch(
          `${apiUrl}/v1/scripts/${encodeURIComponent(nextId)}/board-handoff`,
          { credentials: 'include' },
        );
        if (!response.ok) throw new Error('preview');
        const body = (await response.json()) as { scenes: ScenePreview[] };
        setScenes(body.scenes);
        setSelected(new Set(body.scenes.map((scene) => scene.ordinal)));
      } catch {
        setError('Не удалось прочитать сцены этого сценария.');
      }
    },
    [apiUrl],
  );

  const apply = useCallback(async () => {
    if (!scriptId || selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    if (!(await beforeApply())) {
      setBusy(false);
      setError('Сначала нужно сохранить изменения борда. Попробуйте ещё раз.');
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
            destination: 'board',
            boardId,
            fullSync: selected.size === scenes?.length,
            idempotencyKey: idempotencyKey.current,
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        state?: BoardDocument;
        added?: number;
        updated?: number;
        removed?: number;
      };
      if (!response.ok || !body.state) throw new Error(body.error ?? 'handoff');
      onApplied(
        body.state,
        `Сцены добавлены: ${body.added ?? 0} · обновлены: ${body.updated ?? 0} · удалены в сценарии: ${body.removed ?? 0}`,
        { scriptId, ordinals: [...selected].sort((a, b) => a - b) },
      );
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === 'board_rev_conflict'
          ? 'Борд изменился параллельно. Повторите после обновления.'
          : cause instanceof Error && cause.message === 'project_mismatch'
            ? 'Сценарий относится к другому проекту.'
            : 'Не удалось добавить сцены на борд.',
      );
    } finally {
      setBusy(false);
    }
  }, [apiUrl, beforeApply, boardId, busy, onApplied, onClose, scenes?.length, scriptId, selected]);

  // WS5 tokens-first-half: this was a centered full-canvas modal
  // (fixed inset-0 z-[100] + scrim) hiding the board it edits. It is now a
  // right-side overlay panel like the shot-list / history / cast panels: the
  // canvas stays visible and interactive behind it, dismissal is the X button
  // (the scrim-click path goes away with the scrim — same as those panels).
  // Non-modal, so `aside` + aria-label like BoardHistoryPanel, not
  // role=dialog/aria-modal. Two-column grid stacks to one: a 420px rail has
  // no room for 220px + 1fr side by side.
  return (
    <aside
      aria-label="Сцены из сценария"
      className="glass-menu seed-scroll pointer-events-auto absolute bottom-3 right-3 top-3 z-40 flex w-[min(420px,calc(100vw-1.5rem))] flex-col overflow-y-auto rounded-[var(--radius-md)] p-4"
      data-testid="board-scenario-picker"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-start gap-3">
          <FileText size={19} className="mt-1 text-[color:var(--color-accent)]" />
          <div className="min-w-0 flex-1">
            <h2
              id="scenario-picker-title"
              className="font-display text-[20px] text-[color:var(--color-fg)]"
            >
              Сцены из сценария
            </h2>
            <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
              Выбери сценарий и сцены. Они станут исходными блоками; генерация не запускается и
              токены не списываются.
            </p>
          </div>
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        <div className="mt-4 grid min-h-0 flex-1 gap-4">
          <section className="min-h-0">
            <p className="mb-2 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-faint)]">
              Сценарий
            </p>
            <div className="seed-scroll max-h-[22dvh] space-y-1 overflow-y-auto">
              {scripts === null ? (
                <Loader2 className="m-4 seed-spin" />
              ) : scripts.length === 0 ? (
                <p className="p-2 text-[13px] text-[color:var(--color-faint)]">
                  Нет сценариев со сценами.
                </p>
              ) : (
                scripts.map((script) => (
                  <button
                    key={script.id}
                    type="button"
                    data-testid={`scenario-source-${script.id}`}
                    onClick={() => void chooseScript(script.id)}
                    className={`w-full rounded-[var(--radius-sm)] border-2 px-3 py-2 text-left ${scriptId === script.id ? 'border-[color:var(--color-accent)] bg-[color:var(--color-surface2)]' : 'border-transparent'}`}
                  >
                    <strong className="block truncate text-[13px]">
                      {script.title || 'Без названия'}
                    </strong>
                    <span className="text-[11px] text-[color:var(--color-faint)]">
                      {script.stats.scenes} сцен
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="flex min-h-0 flex-col">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-faint)]">
                Сцены
              </p>
              {scenes && (
                <button
                  type="button"
                  data-testid="scenario-select-all"
                  onClick={() => {
                    idempotencyKey.current = `board-scenario-${crypto.randomUUID()}`;
                    setSelected(new Set(scenes.map((scene) => scene.ordinal)));
                  }}
                  className="text-[11px] text-[color:var(--color-accent)]"
                >
                  Выбрать все
                </button>
              )}
            </div>
            <div
              className="seed-scroll min-h-[180px] flex-1 space-y-1 overflow-y-auto"
              data-testid="scenario-source-scenes"
            >
              {!scriptId ? (
                <p className="p-3 text-[13px] text-[color:var(--color-faint)]">
                  Сначала выберите сценарий.
                </p>
              ) : scenes === null ? (
                <Loader2 className="m-4 seed-spin" />
              ) : (
                scenes.map((scene) => {
                  const checked = selected.has(scene.ordinal);
                  return (
                    <button
                      key={scene.ordinal}
                      type="button"
                      aria-pressed={checked}
                      onClick={() => {
                        idempotencyKey.current = `board-scenario-${crypto.randomUUID()}`;
                        setSelected((current) => {
                          const next = new Set(current);
                          if (next.has(scene.ordinal)) next.delete(scene.ordinal);
                          else next.add(scene.ordinal);
                          return next;
                        });
                      }}
                      className={`flex w-full gap-2 rounded-[var(--radius-sm)] border-2 p-2 text-left ${checked ? 'border-[color:var(--color-accent)]' : 'border-[color:var(--color-line-soft)]'}`}
                    >
                      <span className="mt-0.5 grid size-5 shrink-0 place-items-center border-2 border-[color:var(--color-line)]">
                        {checked && <Check size={13} />}
                      </span>
                      <span className="min-w-0">
                        <strong className="block truncate text-[13px]">
                          {scene.ordinal}. {scene.heading}
                        </strong>
                        {scene.synopsis && (
                          <span className="line-clamp-2 text-[11px] text-[color:var(--color-faint)]">
                            {scene.synopsis}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-[13px] text-[color:var(--color-destructive)]">
            {error}
          </p>
        )}
        <div className="mt-4 flex items-center justify-between border-t-2 border-[color:var(--color-line)] pt-3">
          <span className="text-[13px] text-[color:var(--color-faint)]">
            Выбрано: {selected.size}
          </span>
          <button
            type="button"
            data-testid="scenario-add-to-board"
            disabled={busy || selected.size === 0}
            onClick={() => void apply()}
            className="press inline-flex items-center gap-2 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] disabled:opacity-40"
          >
            {busy && <Loader2 size={14} className="seed-spin" />}Добавить на борд
          </button>
        </div>
      </div>
    </aside>
  );
}
