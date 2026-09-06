'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { cardVisual } from '../../../lib/visual-hash';
import { useProjectContext } from '../../_components/ProjectContextProvider';
import { withProjectContext } from '@/lib/project-context';
import { appendUniquePage, projectListPageUrl } from '@/lib/project-list-pagination';

export interface StudioProjectRow {
  id: string;
  projectId?: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Studio projects gallery — each project is a saved montage you can reopen and
 * keep editing (autosaved). Mirrors the boards gallery; opening a card routes to
 * the per-project editor at /studio/:id.
 */
export function StudioProjectsClient({
  initial,
  initialCursor,
  apiUrl,
  projectContextRequested,
  requestedWorkspaceProjectId,
}: {
  initial: StudioProjectRow[];
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
  const [items, setItems] = useState<StudioProjectRow[]>(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/studio/projects`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: `Монтаж ${items.length + 1}`,
          ...(workspaceProject ? { projectId: workspaceProject.id } : {}),
        }),
      });
      if (res.ok) {
        const project = (await res.json()) as StudioProjectRow;
        const href = `/studio/${project.id}`;
        router.push(workspaceProject ? withProjectContext(href, workspaceProject.id) : href);
        return;
      }
      setError('Не удалось создать монтаж. Попробуй ещё раз.');
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
        projectListPageUrl(apiUrl, '/v1/studio/projects', workspaceProject?.id ?? null, cursor),
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as {
        items: StudioProjectRow[];
        nextCursor: string | null;
      };
      setItems((current) => appendUniquePage(current, body.items));
      setCursor(body.nextCursor);
    } catch {
      setError('Не удалось загрузить остальные монтажи.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function remove(id: string) {
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/studio/projects/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(String(res.status));
      setItems((prev) => prev.filter((p) => p.id !== id));
    } catch {
      setError('Не удалось удалить монтаж. Проверь соединение и попробуй снова.');
    } finally {
      setDeletingId(null);
    }
  }

  async function rename(id: string, current: string) {
    const next = prompt('Новое название монтажа', current)?.trim();
    if (!next || next === current) return;
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/studio/projects/${id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setItems((prev) => prev.map((p) => (p.id === id ? { ...p, title: next } : p)));
    } catch {
      setError('Не удалось переименовать монтаж.');
    }
  }

  if (projectContextRequested && !workspaceProject) {
    return (
      <div className="w-full px-6 py-10" data-testid="studio-projects-blocked">
        <h1 className="font-display text-2xl font-black">Монтажи проекта</h1>
        <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">
          {projectContext.mode === 'loading'
            ? 'Проверяем проект…'
            : 'Контекст проекта недоступен. Монтажи не загружены.'}
        </p>
      </div>
    );
  }

  return (
    <div className="w-full px-6 py-6 pb-16">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-eyebrow mb-2.5">
            {workspaceProject ? 'Монтажи проекта' : 'Монтажи · Студия'}
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
              монтажи
            </span>
          </h1>
          <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Каждый монтаж — отдельная сборка: собери таймлайн, добавь текст, музыку и переходы. Всё
            сохраняется автоматически — вернёшься и продолжишь с того же места.
          </p>
        </div>
        <button
          type="button"
          data-testid="studio-project-create"
          onClick={() => void create()}
          disabled={creating}
          className="glass-accent inline-flex h-11 items-center gap-2 px-6 text-[13px] font-bold disabled:bg-[color:var(--color-surface2)] disabled:text-[color:var(--color-faint)] disabled:shadow-none disabled:cursor-not-allowed"
        >
          {creating ? <Loader2 size={16} className="seed-spin" /> : <Plus size={16} />}
          Новый монтаж
        </button>
      </div>
      {error && (
        <div className="mb-4 rounded-[var(--radius-sm)] border-2 border-destructive/50 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {error}
        </div>
      )}
      {items.length === 0 ? (
        <button
          type="button"
          onClick={() => void create()}
          className="glass glass-hover grid h-56 w-full place-items-center"
        >
          <span className="flex flex-col items-center gap-3 text-[color:var(--color-muted-foreground)]">
            <span className="grid h-12 w-12 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]">
              <Plus size={20} />
            </span>
            <span className="text-[13px]">Создай первый монтаж — это займёт секунду</span>
          </span>
        </button>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((p) => (
            <div key={p.id} className="group relative">
              <Link
                href={
                  workspaceProject
                    ? withProjectContext(`/studio/${p.id}`, workspaceProject.id)
                    : `/studio/${p.id}`
                }
                data-testid="studio-project-card"
                className="lift-card group relative flex aspect-[16/10] flex-col justify-end overflow-hidden rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] shadow-[3px_3px_0_0_var(--color-shadow)]"
              >
                <div
                  className="absolute inset-0"
                  style={{ background: cardVisual(p.id).background }}
                />
                {/* filmstrip hint that this is a montage */}
                <div
                  className="absolute inset-0 opacity-[0.16]"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(90deg, rgba(255,255,255,0.6) 0 2px, transparent 2px 16px)',
                  }}
                />
                <div className="relative z-10 bg-gradient-to-t from-black/80 to-transparent px-4 pb-3.5 pt-10">
                  <p className="truncate text-[15px] font-semibold text-white">{p.title}</p>
                  <p className="mt-0.5 text-[11px] text-white/55">
                    обновлено {new Date(p.updatedAt).toLocaleDateString('ru-RU')}
                  </p>
                </div>
              </Link>
              <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 touch:opacity-100">
                <button
                  type="button"
                  aria-label={`Переименовать ${p.title}`}
                  onClick={() => void rename(p.id, p.title)}
                  className="grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/70 text-white hover:bg-[color:var(--color-accent)] hover:text-[color:var(--color-primary-foreground)]"
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Удалить ${p.title}`}
                  onClick={() => {
                    if (confirm(`Удалить монтаж «${p.title}»? Это действие необратимо.`))
                      void remove(p.id);
                  }}
                  disabled={deletingId === p.id}
                  className="grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/70 text-white hover:bg-destructive hover:text-[color:var(--color-destructive-foreground)] disabled:opacity-50"
                >
                  {deletingId === p.id ? (
                    <Loader2 size={13} className="seed-spin" />
                  ) : (
                    <Trash2 size={13} />
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {cursor && (
        <button
          type="button"
          data-testid="studio-projects-load-more"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mx-auto mt-6 flex h-10 items-center gap-2 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-5 text-[13px] font-bold shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-50"
        >
          {loadingMore && <Loader2 size={14} className="seed-spin" />}
          Показать ещё
        </button>
      )}
    </div>
  );
}
