'use client';

import { useEffect, useState } from 'react';
import { Film, Loader2, Plus, X } from '@/components/ui/icons';

interface StudioProject {
  id: string;
  title: string;
  updatedAt: string;
}

export function StudioDestinationDialog({
  apiUrl,
  projectId,
  clipCount,
  busy,
  onChoose,
  onClose,
}: {
  apiUrl: string;
  projectId: string;
  clipCount: number;
  busy: boolean;
  onChoose: (studioProjectId: string | null) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<StudioProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = new URL(`${apiUrl}/v1/studio/projects`);
    url.searchParams.set('projectId', projectId);
    void fetch(url, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as { items?: StudioProject[] };
      })
      .then((body) => {
        if (!cancelled) setRows(Array.isArray(body.items) ? body.items : []);
      })
      .catch(() => {
        if (!cancelled) setError('Не удалось загрузить монтажи проекта.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, projectId]);

  return (
    <div className="fixed inset-0 z-[85] grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={busy ? undefined : onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-destination-title"
        data-testid="studio-destination-dialog"
        className="glass-menu relative w-full max-w-[560px] p-5"
      >
        <div className="flex items-start gap-3">
          <Film size={17} className="mt-1 text-[color:var(--color-accent)]" />
          <div className="min-w-0 flex-1">
            <h2 id="studio-destination-title" className="font-display text-[19px]">
              Куда передать монтаж
            </h2>
            <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
              {clipCount} {clipCount === 1 ? 'клип' : 'клипов'} · только внутри текущего проекта
            </p>
          </div>
          <button
            type="button"
            aria-label="Закрыть"
            disabled={busy}
            onClick={onClose}
            className="text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)] disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <button
          type="button"
          data-testid="studio-destination-new"
          disabled={busy}
          onClick={() => onChoose(null)}
          className="mt-5 flex w-full items-center gap-3 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10 px-4 py-3 text-left disabled:opacity-50"
        >
          {busy ? <Loader2 size={17} className="seed-spin" /> : <Plus size={17} />}
          <span>
            <span className="block text-[13px] font-bold">Новый монтаж</span>
            <span className="block text-[11px] text-[color:var(--color-muted-foreground)]">
              Создать отдельный именованный монтаж и открыть его
            </span>
          </span>
        </button>

        <p className="mb-2 mt-5 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-faint)]">
          Или заменить таймлайн существующего
        </p>
        {loading ? (
          <div className="grid min-h-24 place-items-center">
            <Loader2 size={18} className="seed-spin" />
          </div>
        ) : error ? (
          <p className="rounded-[var(--radius-sm)] bg-destructive/10 p-3 text-[13px] text-destructive">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-[var(--radius-sm)] border-2 border-dashed border-[color:var(--color-line)] p-4 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
            В этом проекте ещё нет монтажей.
          </p>
        ) : (
          <div className="seed-scroll max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                data-testid={`studio-destination-${row.id}`}
                disabled={busy}
                onClick={() => onChoose(row.id)}
                className="flex w-full items-center gap-3 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] px-3 py-2.5 text-left hover:border-[color:var(--color-accent)] disabled:opacity-50"
              >
                <Film size={15} className="shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">{row.title}</span>
                  <span className="block text-[11px] text-[color:var(--color-faint)]">
                    Обновлён {new Date(row.updatedAt).toLocaleDateString('ru-RU')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
