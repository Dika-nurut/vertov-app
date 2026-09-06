'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, Film, ImageOff, Play, RefreshCw } from '@/components/ui/icons';
import { EmptyState } from '../_components/states/EmptyState';
import { ErrorState } from '../_components/states/ErrorState';
import { cardVisual } from '../../lib/visual-hash';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { assetSrc } from '@/lib/asset-src';
import { FREE_MEDIA_RETENTION_COPY } from '@seed/shared/media-retention';
import { mediaDisplayTitle } from '@seed/shared/media-title';
import { useProjectContext } from '../_components/ProjectContextProvider';
import { withProjectContext } from '@/lib/project-context';

export interface GalleryItem {
  id: string;
  jobId: string;
  assetUrl: string;
  thumbnailUrl: string | null;
  kind: 'image' | 'video';
  title: string | null;
  originalName: string | null;
  folder: string | null;
  tags: string[];
  isPublic: boolean;
  publicSlug: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface FolderRow {
  folder: string | null;
  count: number;
}
export interface TagRow {
  tag: string;
  count: number;
}

export function GalleryClient({
  initialRows,
  initialCursor,
  folders,
  tags,
  activeFolder,
  activeTag,
  paidMediaStorage,
  projectContextRequested,
  requestedWorkspaceProjectId,
  apiUrl,
}: {
  initialRows: GalleryItem[];
  initialCursor: string | null;
  folders: FolderRow[];
  tags: TagRow[];
  activeFolder: string | null;
  activeTag: string | null;
  paidMediaStorage: boolean;
  projectContextRequested: boolean;
  requestedWorkspaceProjectId: string | null;
  apiUrl: string;
}) {
  const router = useRouter();
  const projectContext = useProjectContext();
  const workspaceProject =
    projectContext.mode === 'valid' && projectContext.project.id === requestedWorkspaceProjectId
      ? projectContext.project
      : null;
  const [rows, setRows] = useState<GalleryItem[]>(initialRows);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const selectedArr = useMemo(() => Array.from(selected), [selected]);

  const buildListUrl = useCallback(
    (next?: string) => {
      const url = new URL(`${apiUrl}/v1/gallery`);
      url.searchParams.set('limit', '24');
      if (workspaceProject) url.searchParams.set('projectId', workspaceProject.id);
      if (activeFolder) url.searchParams.set('folder', activeFolder);
      if (activeTag) url.searchParams.set('tag', activeTag);
      if (next) url.searchParams.set('cursor', next);
      return url.toString();
    },
    [apiUrl, workspaceProject, activeFolder, activeTag],
  );

  useEffect(() => {
    setRows(initialRows);
    setCursor(initialCursor);
    setSelected(new Set());
  }, [activeFolder, activeTag, initialCursor, initialRows, requestedWorkspaceProjectId]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setListError(null);
    try {
      const res = await fetch(buildListUrl(cursor), { credentials: 'include' });
      if (!res.ok) {
        setListError(`Ошибка загрузки галереи (HTTP ${res.status})`);
        return;
      }
      const body = (await res.json()) as { rows: GalleryItem[]; nextCursor: string | null };
      setRows((prev) => [...prev, ...body.rows]);
      setCursor(body.nextCursor);
    } catch {
      setListError('Сетевая ошибка при загрузке галереи. Попробуй обновить страницу.');
    } finally {
      setLoading(false);
    }
  }, [buildListUrl, cursor, loading]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) void loadMore();
      },
      { rootMargin: '200px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [loadMore]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function navigate(folder: string | null | '__none__', tag: string | null) {
    const params = new URLSearchParams();
    if (folder === '__none__') params.set('folder', '__none__');
    else if (folder) params.set('folder', folder);
    if (tag) params.set('tag', tag);
    if (workspaceProject) params.set('projectId', workspaceProject.id);
    router.push(`/gallery${params.toString() ? `?${params.toString()}` : ''}`);
  }

  async function moveTo(folder: string | null) {
    setActionBusy(true);
    setListError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/gallery/move`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemIds: selectedArr, folder }),
      });
      if (!res.ok) {
        setListError(`Не удалось переместить работы (HTTP ${res.status})`);
        return;
      }
      setSelected(new Set());
      setMoveOpen(false);
      router.refresh();
    } catch {
      setListError('Сетевая ошибка. Попробуй переместить работы ещё раз.');
    } finally {
      setActionBusy(false);
    }
  }

  async function addTag(tag: string) {
    setActionBusy(true);
    try {
      await fetch(`${apiUrl}/v1/gallery/tag`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemIds: selectedArr, add: [tag], remove: [] }),
      });
      setSelected(new Set());
      setTagOpen(false);
      router.refresh();
    } finally {
      setActionBusy(false);
    }
  }

  async function bulkDownload() {
    setActionBusy(true);
    try {
      const res = await fetch(`${apiUrl}/v1/gallery/bulk-download`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemIds: selectedArr }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vertov-library-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setActionBusy(false);
    }
  }

  if (projectContextRequested && !workspaceProject) {
    const invalid = projectContext.mode === 'invalid' || projectContext.mode === 'standalone';
    return (
      <div className="mx-auto w-full max-w-[1600px] px-6 py-10">
        <h1 className="text-h2">Галерея</h1>
        {invalid ? (
          <ErrorState message="Контекст проекта недоступен. Материалы не загружены." />
        ) : (
          <p
            className="mt-5 font-mono text-sm text-[color:var(--color-muted-foreground)]"
            data-testid="gallery-project-loading"
          >
            Проверяем проект…
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-eyebrow">
            {workspaceProject ? 'Материалы проекта' : 'Архив · всё, что ты сгенерировал'}
          </p>
          <h1 className="text-h2 mt-2">{workspaceProject ? workspaceProject.title : 'Галерея'}</h1>
        </div>
        {workspaceProject && (
          <Link
            href="/gallery"
            className="text-sm text-[color:var(--color-muted-foreground)] underline decoration-2 underline-offset-4 transition-colors hover:text-[color:var(--color-fg)]"
            data-testid="complete-library-link"
          >
            Вся библиотека
          </Link>
        )}
      </div>

      {!paidMediaStorage && (
        <div
          data-testid="free-expiry-banner"
          className="mt-5 flex items-start gap-3 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-card px-4 py-3 text-sm text-[color:var(--color-muted-foreground)] shadow-[var(--shadow-card)]"
        >
          <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 bg-[color:var(--color-accent)]" />
          <span>
            {FREE_MEDIA_RETENTION_COPY.split(' · ').slice(0, 2).join(' · ')} ·{' '}
            <Link href="/pricing" className="underline decoration-2 underline-offset-2">
              {FREE_MEDIA_RETENTION_COPY.split(' · ')[2]}
            </Link>
          </span>
        </div>
      )}

      <div className="mt-8 grid gap-6 md:grid-cols-[200px_1fr]">
        <aside data-testid="folder-sidebar" className="text-sm">
          <h2 className="eyebrow mb-3">Папки</h2>
          <ul className="space-y-1">
            <li>
              <button
                type="button"
                onClick={() => navigate(null, activeTag)}
                className={cn(
                  'press-inset w-full border-l-[2.5px] border-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-[color:var(--color-surface2)]',
                  !activeFolder &&
                    'border-[color:var(--color-accent)] bg-[color:var(--color-surface2)] font-bold text-[color:var(--color-fg)]',
                )}
              >
                Все
              </button>
            </li>
            {folders.map((f) => (
              <li key={f.folder ?? '__none__'}>
                <button
                  type="button"
                  data-testid="folder-button"
                  data-folder={f.folder ?? '__none__'}
                  onClick={() => navigate(f.folder ?? '__none__', activeTag)}
                  className={cn(
                    'press-inset flex w-full items-center justify-between gap-2 border-l-[2.5px] border-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-[color:var(--color-surface2)]',
                    activeFolder === (f.folder ?? '__none__') &&
                      'border-[color:var(--color-accent)] bg-[color:var(--color-surface2)] font-bold text-[color:var(--color-fg)]',
                  )}
                >
                  <span className="truncate">{f.folder ?? 'Без папки'}</span>
                  <span className="tnum shrink-0 text-xs text-[color:var(--color-muted-foreground)]">
                    {f.count}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {tags.length > 0 && (
            <>
              <h2 className="eyebrow mb-3 mt-7">Теги</h2>
              <div className="flex flex-wrap gap-2">
                {tags.map((t) => (
                  <button
                    key={t.tag}
                    type="button"
                    data-selected={activeTag === t.tag}
                    onClick={() =>
                      navigate(activeFolder ?? null, t.tag === activeTag ? null : t.tag)
                    }
                    className="chip px-2.5 py-1 text-xs text-[color:var(--color-fg)]"
                  >
                    #{t.tag}{' '}
                    <span className="tnum text-[color:var(--color-muted-foreground)]">
                      {t.count}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>

        <div>
          {selected.size > 0 && (
            <div
              data-testid="action-bar"
              className="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border-[2.5px] border-[color:var(--color-line)] bg-card px-3.5 py-2.5 text-sm shadow-[var(--shadow-card)]"
            >
              <span className="tnum font-mono text-xs font-bold uppercase tracking-wide">
                {selected.size} выбрано
              </span>
              <Button
                type="button"
                data-testid="bulk-download-button"
                size="sm"
                disabled={actionBusy}
                onClick={() => void bulkDownload()}
                className="ml-auto"
              >
                Скачать ZIP
              </Button>
              <Button
                type="button"
                data-testid="move-trigger"
                size="sm"
                variant="secondary"
                onClick={() => setMoveOpen((v) => !v)}
              >
                Переместить в…
              </Button>
              <Button
                type="button"
                data-testid="tag-trigger"
                size="sm"
                variant="secondary"
                onClick={() => setTagOpen((v) => !v)}
              >
                Теги…
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set())}
              >
                Сбросить
              </Button>
            </div>
          )}

          {moveOpen && (
            <div className="mb-3 rounded-[var(--radius-lg)] border-[2.5px] border-[color:var(--color-line)] bg-card p-3.5 text-sm shadow-[var(--shadow-card)]">
              <MoveForm onMove={moveTo} disabled={actionBusy} />
            </div>
          )}
          {tagOpen && (
            <div className="mb-3 rounded-[var(--radius-lg)] border-[2.5px] border-[color:var(--color-line)] bg-card p-3.5 text-sm shadow-[var(--shadow-card)]">
              <TagForm onAdd={addTag} disabled={actionBusy} />
            </div>
          )}

          {listError ? (
            <ErrorState
              message={listError}
              onRetry={() => {
                setListError(null);
              }}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              message="Пока ничего. Начни с генерации."
              actionLabel="Сгенерировать"
              actionHref={
                workspaceProject
                  ? withProjectContext('/generate', workspaceProject.id)
                  : '/generate'
              }
            />
          ) : (
            <div
              className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
              data-testid="gallery-grid"
            >
              {rows.map((item) => (
                <GalleryTile
                  key={item.id}
                  item={item}
                  checked={selected.has(item.id)}
                  selectionActive={selected.size > 0}
                  onToggle={() => toggle(item.id)}
                  workspaceProjectId={workspaceProject?.id ?? null}
                />
              ))}
            </div>
          )}
          <div ref={sentinelRef} className="h-12" />
          {loading && (
            <p className="mt-2 text-center text-sm text-[color:var(--color-muted-foreground)]">
              Загрузка…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Gallery tile — poster-first (no native video controls in a grid), play
 * badge + hover preview for videos, quick actions on hover, checkbox only
 * when hovering or a selection is in progress.
 */
function GalleryTile({
  item,
  checked,
  selectionActive,
  onToggle,
  workspaceProjectId,
}: {
  item: GalleryItem;
  checked: boolean;
  selectionActive: boolean;
  onToggle: () => void;
  workspaceProjectId: string | null;
}) {
  const [previewing, setPreviewing] = useState(false);
  const poster = item.thumbnailUrl ?? (item.kind === 'image' ? item.assetUrl : null);
  const label = mediaDisplayTitle(item);

  return (
    <div
      data-testid="gallery-item"
      data-item-id={item.id}
      onMouseEnter={() => item.kind === 'video' && setPreviewing(true)}
      onMouseLeave={() => setPreviewing(false)}
      className={
        'lift-card group relative aspect-square overflow-hidden rounded-[var(--radius-md)] border-[2.5px] shadow-[3px_3px_0_0_var(--color-shadow)] ' +
        (checked ? 'border-[color:var(--color-accent)]' : 'border-[color:var(--color-line)]')
      }
    >
      <input
        type="checkbox"
        data-testid="select-checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label="Выбрать"
        className={
          'seed-check absolute left-2 top-2 z-20 transition-opacity ' +
          (checked || selectionActive
            ? 'opacity-100'
            : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100')
        }
      />

      <Link
        href={
          workspaceProjectId
            ? withProjectContext(`/gallery/${item.jobId}`, workspaceProjectId)
            : `/gallery/${item.jobId}`
        }
        className="block h-full w-full"
      >
        {item.kind === 'video' && previewing && item.assetUrl ? (
          <video
            src={assetSrc(item.assetUrl)}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          // No poster (legacy/expired asset) — hashed identity, never a black box.
          <div
            className="grid h-full w-full place-items-center"
            style={{ background: cardVisual(item.id).background }}
          >
            {item.kind === 'video' ? (
              <Film size={22} className="text-white/30" aria-hidden />
            ) : (
              <ImageOff size={22} className="text-white/30" aria-hidden />
            )}
          </div>
        )}

        {/* Video affordance — glass play badge, hidden while previewing. */}
        {item.kind === 'video' && !previewing && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="grid h-10 w-10 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/70">
              <Play size={16} className="ml-0.5 text-white" aria-hidden />
            </span>
          </span>
        )}
        {item.kind === 'video' && (
          <span className="pointer-events-none absolute right-2 top-2 z-10 border-[1.5px] border-[color:var(--color-line)] bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-white">
            видео
          </span>
        )}
        <span className="pointer-events-none absolute inset-x-2 bottom-2 z-10 truncate bg-black/70 px-2 py-1 font-mono text-[10px] text-white transition-[bottom] duration-150 group-hover:bottom-10 group-focus-within:bottom-10 touch:bottom-10">
          {label}
        </span>
      </Link>

      {/* Quick actions — appear on hover, bottom-right over a soft gradient. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-end gap-1 bg-gradient-to-t from-black/65 to-transparent px-2 pb-2 pt-7 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100">
        <Link
          href={
            workspaceProjectId
              ? withProjectContext(
                  `/generate?from=${encodeURIComponent(item.jobId)}`,
                  workspaceProjectId,
                )
              : `/generate?from=${encodeURIComponent(item.jobId)}`
          }
          title="Повторить"
          className="pointer-events-auto grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/70 text-white transition-colors hover:bg-[color:var(--color-accent)] hover:text-[color:var(--color-primary-foreground)]"
        >
          <RefreshCw size={12} aria-hidden />
        </Link>
        {item.kind === 'video' && (
          <Link
            href={
              workspaceProjectId ? withProjectContext('/studio', workspaceProjectId) : '/studio'
            }
            title="Открыть в студии"
            className="pointer-events-auto grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/70 text-white transition-colors hover:bg-[color:var(--color-accent)] hover:text-[color:var(--color-primary-foreground)]"
          >
            <Clapperboard size={12} aria-hidden />
          </Link>
        )}
      </div>
    </div>
  );
}

function MoveForm({
  onMove,
  disabled,
}: {
  onMove: (folder: string | null) => void | Promise<void>;
  disabled: boolean;
}) {
  const [name, setName] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="text"
        data-testid="move-folder-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Имя папки"
        className="h-9 flex-1"
      />
      <Button
        type="button"
        data-testid="move-apply"
        size="sm"
        disabled={disabled || !name.trim()}
        onClick={() => void onMove(name.trim())}
      >
        Переместить
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled}
        onClick={() => void onMove(null)}
      >
        В «Без папки»
      </Button>
    </div>
  );
}

function TagForm({
  onAdd,
  disabled,
}: {
  onAdd: (tag: string) => void | Promise<void>;
  disabled: boolean;
}) {
  const [tag, setTag] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="text"
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        placeholder="Имя тега"
        className="h-9 flex-1"
      />
      <Button
        type="button"
        size="sm"
        disabled={disabled || !tag.trim()}
        onClick={() => void onAdd(tag.trim())}
      >
        Добавить
      </Button>
    </div>
  );
}
