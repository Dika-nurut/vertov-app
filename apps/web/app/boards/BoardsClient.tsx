'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Archive, Copy, Loader2, Pencil, Plus, Trash2, X } from '@/components/ui/icons';
import { cardVisual } from '../../lib/visual-hash';
import { useProjectContext } from '../_components/ProjectContextProvider';
import { FeatureHint } from '../_components/FeatureHint';
import { withProjectContext } from '@/lib/project-context';
import { appendUniquePage, projectListPageUrl } from '@/lib/project-list-pagination';

export interface BoardRow {
  id: string;
  projectId?: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl?: string | null;
  trashedAt?: string | null;
  purgeAfter?: string | null;
}

type ActionDialog = { kind: 'trash' | 'permanent'; board: BoardRow } | null;

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; max?: number };
  if (body.error === 'too_many_boards') {
    return `Достигнут лимит: не больше ${body.max ?? 50} бордов. Переместите ненужный борд в корзину и попробуйте снова.`;
  }
  return fallback;
}

/** Борды — project workspaces with reversible trash and independent copies. */
export function BoardsClient({
  initial,
  initialCursor,
  apiUrl,
  projectContextRequested,
  requestedWorkspaceProjectId,
}: {
  initial: BoardRow[];
  initialCursor: string | null;
  apiUrl: string;
  projectContextRequested: boolean;
  requestedWorkspaceProjectId: string | null;
}) {
  const router = useRouter();
  const projectContext = useProjectContext();
  const workspaceProject =
    projectContext.mode === 'valid' && projectContext.project.id === requestedWorkspaceProjectId
      ? projectContext.project
      : null;
  const [items, setItems] = useState<BoardRow[]>(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [trashItems, setTrashItems] = useState<BoardRow[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [loadingTrash, setLoadingTrash] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dialog, setDialog] = useState<ActionDialog>(null);
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const boardHref = (id: string) =>
    workspaceProject ? withProjectContext(`/boards/${id}`, workspaceProject.id) : `/boards/${id}`;

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/boards`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: `Проект ${items.length + 1}`,
          ...(workspaceProject ? { projectId: workspaceProject.id } : {}),
        }),
      });
      if (res.ok) {
        const board = (await res.json()) as BoardRow;
        router.push(boardHref(board.id));
        return;
      }
      setError(
        await responseError(
          res,
          'Не удалось создать борд. Проверьте соединение и попробуйте снова.',
        ),
      );
    } catch {
      setError('Не удалось создать борд. Проверьте соединение и попробуйте снова.');
    } finally {
      setCreating(false);
    }
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await fetch(
        projectListPageUrl(apiUrl, '/v1/boards', workspaceProject?.id ?? null, cursor),
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { items: BoardRow[]; nextCursor: string | null };
      setItems((current) => appendUniquePage(current, body.items));
      setCursor(body.nextCursor);
    } catch {
      setError('Не удалось загрузить остальные борды.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadTrash() {
    setLoadingTrash(true);
    setError(null);
    try {
      const project = workspaceProject
        ? `?projectId=${encodeURIComponent(workspaceProject.id)}`
        : '';
      const response = await fetch(`${apiUrl}/v1/boards/trash${project}`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { items: BoardRow[] };
      setTrashItems(body.items);
    } catch {
      setError('Не удалось загрузить корзину бордов.');
    } finally {
      setLoadingTrash(false);
    }
  }

  function openTrash(board: BoardRow) {
    setDialog({ kind: 'trash', board });
  }

  async function moveToTrash(board: BoardRow) {
    setWorkingId(board.id);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/v1/boards/${board.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) throw new Error(await responseError(response, 'trash'));
      setItems((prev) => prev.filter((item) => item.id !== board.id));
      setDialog(null);
      if (showTrash) await loadTrash();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message !== 'trash'
          ? cause.message
          : 'Не удалось переместить борд в корзину.',
      );
    } finally {
      setWorkingId(null);
    }
  }

  async function restore(board: BoardRow) {
    setWorkingId(board.id);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/v1/boards/${board.id}/restore`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('restore');
      setTrashItems((prev) => prev.filter((item) => item.id !== board.id));
      setItems((prev) => [board, ...prev.filter((item) => item.id !== board.id)]);
    } catch {
      setError('Не удалось восстановить борд.');
    } finally {
      setWorkingId(null);
    }
  }

  async function permanentlyDelete(board: BoardRow) {
    setWorkingId(board.id);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/v1/boards/${board.id}/permanent`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('permanent');
      setTrashItems((prev) => prev.filter((item) => item.id !== board.id));
      setDialog(null);
    } catch {
      setError('Не удалось удалить борд навсегда.');
    } finally {
      setWorkingId(null);
    }
  }

  async function duplicate(board: BoardRow) {
    setWorkingId(board.id);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/v1/boards/${board.id}/duplicate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(await responseError(response, 'copy'));
      const copy = (await response.json()) as BoardRow;
      setItems((prev) => [copy, ...prev]);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message !== 'copy'
          ? cause.message
          : 'Не удалось создать копию борда.',
      );
    } finally {
      setWorkingId(null);
    }
  }

  function startRename(board: BoardRow) {
    setRenameId(board.id);
    setRenameValue(board.title);
  }

  async function rename(board: BoardRow) {
    const title = renameValue.trim();
    if (!title || title === board.title) {
      setRenameId(null);
      return;
    }
    setWorkingId(board.id);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/v1/boards/${board.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error('rename');
      setItems((prev) => prev.map((item) => (item.id === board.id ? { ...item, title } : item)));
      setRenameId(null);
    } catch {
      setError('Не удалось переименовать борд.');
    } finally {
      setWorkingId(null);
    }
  }

  async function importBoard(file: File) {
    setWorkingId('import');
    setError(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const response = await fetch(`${apiUrl}/v1/boards/import`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          export: parsed,
          ...(workspaceProject ? { projectId: workspaceProject.id } : {}),
        }),
      });
      if (!response.ok) throw new Error('import');
      const board = (await response.json()) as BoardRow;
      router.push(boardHref(board.id));
    } catch {
      setError('Не удалось импортировать борд. Проверьте JSON-файл и попробуйте снова.');
    } finally {
      setWorkingId(null);
      if (importRef.current) importRef.current.value = '';
    }
  }

  if (projectContextRequested && !workspaceProject) {
    return (
      <div className="w-full px-6 py-10" data-testid="boards-project-blocked">
        <h1 className="font-display text-2xl font-black">Борды проекта</h1>
        <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">
          {projectContext.mode === 'loading'
            ? 'Проверяем проект…'
            : 'Контекст проекта недоступен. Борды не загружены.'}
        </p>
      </div>
    );
  }

  const renderCard = (board: BoardRow, trashed = false) => {
    const visual = cardVisual(board.id);
    return (
      <div
        key={board.id}
        className="group relative"
        data-testid={trashed ? `board-trash-card-${board.id}` : `board-card-wrap-${board.id}`}
      >
        {!trashed ? (
          <Link
            href={boardHref(board.id)}
            data-testid="board-card"
            className="lift-card group relative flex aspect-[16/10] flex-col justify-end overflow-hidden rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] shadow-[3px_3px_0_0_var(--color-shadow)]"
          >
            <div className="absolute inset-0" style={{ background: visual.background }} />
            {board.thumbnailUrl ? (
              <img
                src={board.thumbnailUrl}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : null}
            <div className="relative z-10 bg-gradient-to-t from-black/80 to-transparent px-4 pb-3.5 pt-10">
              {renameId === board.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  maxLength={80}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => void rename(board)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void rename(board);
                    if (event.key === 'Escape') setRenameId(null);
                  }}
                  onClick={(event) => event.preventDefault()}
                  className="w-full border-b-2 border-white bg-transparent text-[15px] font-semibold text-white outline-none"
                  aria-label="Название борда"
                />
              ) : (
                <p className="truncate text-[15px] font-semibold text-white">{board.title}</p>
              )}
              <p className="mt-0.5 text-[11px] text-white/55">
                обновлено {new Date(board.updatedAt).toLocaleDateString('ru-RU')}
              </p>
            </div>
          </Link>
        ) : (
          <div className="glass flex aspect-[16/10] flex-col justify-between overflow-hidden rounded-[var(--radius-md)] border-[2.5px] border-dashed border-[color:var(--color-line)] p-4">
            <div className="flex items-center justify-between">
              <Archive size={17} />
              <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
                В корзине
              </span>
            </div>
            <div>
              <p className="truncate text-[15px] font-semibold">{board.title}</p>
              <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
                удалится{' '}
                {board.purgeAfter
                  ? new Date(board.purgeAfter).toLocaleDateString('ru-RU')
                  : 'через 30 дней'}
              </p>
            </div>
          </div>
        )}
        <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 touch:opacity-100">
          {trashed ? (
            <>
              <button
                type="button"
                data-testid={`board-restore-${board.id}`}
                aria-label={`Восстановить ${board.title}`}
                onClick={() => void restore(board)}
                disabled={workingId === board.id}
                className="grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/70 text-white hover:bg-[color:var(--color-accent)]"
              >
                {workingId === board.id ? (
                  <Loader2 size={13} className="seed-spin" />
                ) : (
                  <Archive size={13} />
                )}
              </button>
              <button
                type="button"
                data-testid={`board-permanent-${board.id}`}
                aria-label={`Удалить ${board.title} навсегда`}
                onClick={() => setDialog({ kind: 'permanent', board })}
                className="grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/70 text-white hover:bg-destructive"
              >
                <Trash2 size={13} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                data-testid={`board-rename-${board.id}`}
                aria-label={`Переименовать ${board.title}`}
                onClick={(event) => {
                  event.preventDefault();
                  startRename(board);
                }}
                className="grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/70 text-white hover:bg-[color:var(--color-accent)]"
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                data-testid={`board-duplicate-${board.id}`}
                aria-label={`Создать копию ${board.title}`}
                onClick={(event) => {
                  event.preventDefault();
                  void duplicate(board);
                }}
                disabled={workingId === board.id}
                className="grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/70 text-white hover:bg-[color:var(--color-accent)]"
              >
                <Copy size={13} />
              </button>
              <button
                type="button"
                data-testid={`board-delete-${board.id}`}
                aria-label={`Переместить ${board.title} в корзину`}
                onClick={(event) => {
                  event.preventDefault();
                  openTrash(board);
                }}
                disabled={workingId === board.id}
                className="grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/70 text-white hover:bg-destructive"
              >
                {workingId === board.id ? (
                  <Loader2 size={13} className="seed-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="w-full px-6 py-6 pb-16">
      <FeatureHint surface="boards" target="feature-boards" />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-eyebrow mb-2.5">
            {workspaceProject ? 'Борды проекта' : 'Проекты · Vertov'}
          </p>
          <h1 className="font-display text-[clamp(30px,4vw,44px)] font-black uppercase leading-[0.98] tracking-[-0.02em] text-[color:var(--color-fg)]">
            {workspaceProject ? workspaceProject.title : 'Твои'}{' '}
            <span
              className="box-decoration-clone px-1.5"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-primary-foreground)',
              }}
            >
              борды
            </span>
          </h1>
          <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Борд — рабочее пространство проекта: генерируй прямо на холсте, ветви варианты, собирай
            сцены и монтируй ролик, не покидая экран.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            data-testid="board-import-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importBoard(file);
            }}
          />
          <button
            type="button"
            data-testid="board-import"
            onClick={() => importRef.current?.click()}
            disabled={workingId === 'import'}
            className="glass inline-flex h-11 items-center gap-2 px-4 text-[13px] font-bold disabled:opacity-50"
          >
            <Archive size={16} /> Импорт борда
          </button>
          <button
            type="button"
            data-testid="board-create"
            data-tour-target="feature-boards"
            onClick={() => void create()}
            disabled={creating}
            className="glass-accent inline-flex h-11 items-center gap-2 px-6 text-[13px] font-bold disabled:bg-[color:var(--color-surface2)] disabled:text-[color:var(--color-faint)] disabled:shadow-none disabled:cursor-not-allowed"
          >
            {creating ? <Loader2 size={16} className="seed-spin" /> : <Plus size={16} />} Новый борд
          </button>
        </div>
      </div>
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          data-testid="boards-trash-toggle"
          onClick={() => {
            const next = !showTrash;
            setShowTrash(next);
            if (next && trashItems.length === 0) void loadTrash();
          }}
          className="inline-flex items-center gap-2 border-2 border-[color:var(--color-line)] px-3 py-2 text-[13px] font-bold hover:bg-[color:var(--color-surface2)]"
        >
          <Archive size={15} /> {showTrash ? 'Скрыть корзину' : 'Корзина'}
        </button>
        {showTrash && (
          <span className="text-[13px] text-[color:var(--color-muted-foreground)]">
            Борды хранятся 30 дней
          </span>
        )}
      </div>
      {error && (
        <div
          role="alert"
          data-testid="boards-error"
          className="mb-4 rounded-[var(--radius-sm)] border-2 border-destructive/50 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
        >
          {error}
        </div>
      )}
      {showTrash && (
        <section aria-label="Корзина бордов" data-testid="boards-trash-section" className="mb-8">
          <h2 className="mb-3 font-display text-xl font-black">Корзина</h2>
          {loadingTrash ? (
            <Loader2 size={18} className="seed-spin" />
          ) : trashItems.length === 0 ? (
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">Корзина пуста.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {trashItems.map((board) => renderCard(board, true))}
            </div>
          )}
        </section>
      )}
      {!showTrash &&
        (items.length === 0 ? (
          <button
            type="button"
            data-testid="board-create-empty"
            onClick={() => void create()}
            className="brutal-card press grid w-full place-items-center px-6 py-14"
          >
            <span className="flex max-w-md flex-col items-center gap-3 text-center">
              <span className="label-eyebrow text-[color:var(--color-faint)]">Пока пусто</span>
              <span className="grid h-12 w-12 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]">
                <Plus size={20} />
              </span>
              <span className="font-display text-[20px] font-black uppercase leading-tight tracking-[-0.01em] text-[color:var(--color-fg)]">
                Создай первый борд
              </span>
              <span className="text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                Холст, сцены и монтаж в одном месте — это займёт секунду
              </span>
            </span>
          </button>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((board) => renderCard(board))}
          </div>
        ))}
      {!showTrash && cursor && (
        <button
          type="button"
          data-testid="boards-load-more"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mx-auto mt-6 flex h-10 items-center gap-2 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-5 text-[13px] font-bold shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-50"
        >
          {loadingMore && <Loader2 size={14} className="seed-spin" />} Показать ещё
        </button>
      )}
      {dialog && (
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4"
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="board-action-title"
            data-testid="board-action-dialog"
            className="glass w-full max-w-md border-[2.5px] border-[color:var(--color-line)] p-5 shadow-[6px_6px_0_0_var(--color-shadow)]"
          >
            <div className="flex items-start justify-between gap-4">
              <h2 id="board-action-title" className="font-display text-xl font-black">
                {dialog.kind === 'trash' ? 'Переместить борд в корзину?' : 'Удалить борд навсегда?'}
              </h2>
              <button type="button" aria-label="Закрыть" onClick={() => setDialog(null)}>
                <X size={18} />
              </button>
            </div>
            <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">
              «{dialog.board.title}»{' '}
              {dialog.kind === 'trash'
                ? 'останется доступен для восстановления 30 дней.'
                : 'будет удалён вместе с историей версий без возможности восстановления.'}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                data-testid="board-action-cancel"
                onClick={() => setDialog(null)}
                className="border-2 border-[color:var(--color-line)] px-4 py-2 text-[13px] font-bold"
              >
                Отмена
              </button>
              <button
                type="button"
                data-testid={
                  dialog.kind === 'trash' ? 'board-trash-confirm' : 'board-permanent-confirm'
                }
                disabled={workingId === dialog.board.id}
                onClick={() =>
                  void (dialog.kind === 'trash'
                    ? moveToTrash(dialog.board)
                    : permanentlyDelete(dialog.board))
                }
                className="bg-destructive px-4 py-2 text-[13px] font-bold text-[color:var(--color-destructive-foreground)] disabled:opacity-50"
              >
                {dialog.kind === 'trash' ? 'Переместить в корзину' : 'Удалить навсегда'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
