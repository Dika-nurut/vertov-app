'use client';

import { useEffect, useState } from 'react';
import { Image as ImageIcon, Loader2, X } from '@/components/ui/icons';
import { assetSrc } from '@/lib/asset-src';

interface ProjectMedia {
  id: string;
  assetUrl: string;
  thumbnailUrl: string | null;
  kind: 'image' | 'video';
}

export function ProjectMediaPicker({
  apiUrl,
  projectId,
  onChoose,
  onClose,
}: {
  apiUrl: string;
  projectId: string;
  onChoose: (media: ProjectMedia) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ProjectMedia[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = new URL(`${apiUrl}/v1/gallery`);
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('limit', '100');
    void fetch(url, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as { rows?: ProjectMedia[] };
      })
      .then((body) => {
        if (!cancelled) setRows(Array.isArray(body.rows) ? body.rows : []);
      })
      .catch(() => {
        if (!cancelled) setError('Не удалось загрузить материалы проекта.');
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
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-media-title"
        data-testid="project-media-picker"
        className="glass-menu relative w-full max-w-[680px] p-5"
      >
        <div className="flex items-start gap-3">
          <ImageIcon size={17} className="mt-1 text-[color:var(--color-accent)]" />
          <div className="min-w-0 flex-1">
            <h2 id="project-media-title" className="font-display text-[19px]">
              Материалы проекта
            </h2>
            <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
              Здесь показаны только материалы, уже связанные с этим проектом.
            </p>
          </div>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            className="text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]"
          >
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="grid min-h-48 place-items-center">
            <Loader2 size={20} className="seed-spin" />
          </div>
        ) : error ? (
          <p className="mt-5 rounded-[var(--radius-sm)] bg-destructive/10 p-3 text-[13px] text-destructive">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <div className="mt-5 rounded-[var(--radius-sm)] border-2 border-dashed border-[color:var(--color-line)] px-5 py-10 text-center">
            <p className="font-semibold">В проекте пока нет материалов</p>
            <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
              Добавьте результат из Generate или Архива, затем вернитесь на борд.
            </p>
          </div>
        ) : (
          <div className="seed-scroll mt-5 grid max-h-[56vh] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 md:grid-cols-4">
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                data-testid={`project-media-${row.id}`}
                onClick={() => onChoose(row)}
                className="group relative aspect-square overflow-hidden rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-black text-left hover:border-[color:var(--color-accent)]"
              >
                {row.kind === 'video' ? (
                  <video
                    src={`${assetSrc(row.assetUrl)}#t=0.1`}
                    muted
                    preload="metadata"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <img
                    src={assetSrc(row.thumbnailUrl ?? row.assetUrl)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                )}
                <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase text-white">
                  {row.kind === 'video' ? 'Видео' : 'Фото'}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
