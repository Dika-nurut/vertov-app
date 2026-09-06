'use client';

import { useCallback, useEffect, useState } from 'react';
import { X } from '@/components/ui/icons';

interface Snapshot {
  id: string;
  rev: number;
  cause: string;
  createdAt: string;
}

const CAUSE_RU: Record<string, string> = {
  manual: 'Вручную',
  apply: 'Правка ассистента',
  autosave: 'Автосохранение',
  restore: 'Восстановление',
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU');
}

export function VersionsSheet({
  apiUrl,
  scriptId,
  onClose,
  onRestored,
}: {
  apiUrl: string;
  scriptId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [items, setItems] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/scripts/${scriptId}/snapshots`, {
        credentials: 'include',
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = (await res.json()) as { items: Snapshot[] };
      setItems(b.items);
    } catch {
      setError('Не удалось загрузить историю версий.');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, scriptId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const createPoint = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/scripts/${scriptId}/snapshots`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch {
      setError('Не удалось создать точку.');
    } finally {
      setBusy(false);
    }
  }, [apiUrl, scriptId, busy, load]);

  const restore = useCallback(
    async (snapshotId: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${apiUrl}/v1/scripts/${scriptId}/restore`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ snapshotId }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onRestored();
      } catch {
        setError('Не удалось восстановить версию.');
      } finally {
        setBusy(false);
      }
    },
    [apiUrl, scriptId, busy, onRestored],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[color:var(--color-overlay)]"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-[420px] flex-col border-l-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] shadow-[-8px_0_0_0_var(--color-shadow)]"
        data-testid="scenario-versions-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        {/* head */}
        <div className="flex items-center gap-3 border-b-[2.5px] border-[color:var(--color-line)] px-4 py-3">
          <span className="font-display text-[13px] font-black">История версий</span>
          <button
            onClick={createPoint}
            disabled={busy}
            className="sp-btn ml-auto border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3 py-1.5 text-[13px] font-bold text-[color:var(--color-primary-foreground)]"
          >
            Создать точку
          </button>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-2 py-1.5 text-[13px] text-[color:var(--color-muted-foreground)]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        {/* body */}
        <div className="flex flex-1 flex-col gap-2 overflow-auto p-4">
          {error && (
            <div className="border-[2.5px] border-[color:var(--color-destructive)] px-3 py-2 text-[13px] text-[color:var(--color-destructive)]">
              {error}
              <button
                onClick={() => void load()}
                className="ml-2 cursor-pointer font-semibold underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
              >
                Повторить
              </button>
            </div>
          )}

          {loading ? (
            <p className="my-6 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
              Загрузка…
            </p>
          ) : items.length === 0 && !error ? (
            <p className="my-6 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
              Пока нет сохранённых версий.
            </p>
          ) : (
            items.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-[color:var(--color-fg)]">
                    {CAUSE_RU[s.cause] ?? s.cause}{' '}
                    <span className="font-mono text-[13px] text-[color:var(--color-muted-foreground)]">
                      · v{s.rev}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
                    {fmtDate(s.createdAt)}
                  </div>
                </div>
                <button
                  onClick={() => void restore(s.id)}
                  disabled={busy}
                  className="sp-btn-ghost shrink-0 border-[2px] border-[color:var(--color-line-soft)] px-3 py-1.5 text-[13px] font-semibold text-[color:var(--color-fg)]"
                >
                  Восстановить
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
