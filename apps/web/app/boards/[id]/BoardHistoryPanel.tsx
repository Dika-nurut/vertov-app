'use client';

import { useEffect, useState } from 'react';
import { Clock3, Loader2, RefreshCw, X } from '@/components/ui/icons';

interface SnapshotRow {
  id: string;
  rev: number;
  reason: 'autosave' | 'manual' | 'pre-destructive';
  createdAt: string;
  nodeCount: number;
  edgeCount: number;
  trayCount: number;
}

export function BoardHistoryPanel({
  apiUrl,
  boardId,
  open,
  onClose,
  onRestored,
  onFeedback,
}: {
  apiUrl: string;
  boardId: string;
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
  onFeedback: (message: string) => void;
}) {
  const [items, setItems] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void fetch(`${apiUrl}/v1/boards/${boardId}/snapshots`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { items: SnapshotRow[] };
        setItems(body.items);
      })
      .catch(() => onFeedback('Не удалось загрузить историю версий.'))
      .finally(() => setLoading(false));
  }, [apiUrl, boardId, onFeedback, open]);

  async function snapshotNow() {
    setBusy('manual');
    try {
      const response = await fetch(`${apiUrl}/v1/boards/${boardId}/snapshots`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error(String(response.status));
      onFeedback('Версия сохранена в историю.');
      const refreshed = await fetch(`${apiUrl}/v1/boards/${boardId}/snapshots`, {
        credentials: 'include',
      });
      if (refreshed.ok) setItems(((await refreshed.json()) as { items: SnapshotRow[] }).items);
    } catch {
      onFeedback('Не удалось сохранить версию.');
    } finally {
      setBusy(null);
    }
  }

  async function restore(item: SnapshotRow) {
    if (!window.confirm(`Восстановить версию ${item.rev}? Текущее состояние останется в истории.`))
      return;
    setBusy(item.id);
    try {
      const response = await fetch(`${apiUrl}/v1/boards/${boardId}/snapshots/${item.id}/restore`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error(String(response.status));
      onFeedback('Версия восстановлена как новая ревизия.');
      onRestored();
    } catch {
      onFeedback('Не удалось восстановить версию.');
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;
  return (
    <aside
      data-testid="board-history-panel"
      aria-label="История версий"
      className="glass-menu seed-scroll pointer-events-auto absolute bottom-3 right-3 top-3 z-40 w-[min(380px,calc(100vw-1.5rem))] overflow-y-auto rounded-[var(--radius-md)] p-3"
    >
      <div className="mb-3 flex items-center gap-2">
        <Clock3 size={15} className="text-[color:var(--color-accent)]" />
        <span className="label-eyebrow flex-1">История версий</span>
        <button type="button" aria-label="Закрыть историю" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <button
        type="button"
        data-testid="board-history-snapshot"
        disabled={busy !== null}
        onClick={() => void snapshotNow()}
        className="mb-3 inline-flex w-full items-center justify-center gap-1.5 border-2 border-[color:var(--color-line)] px-3 py-2 text-[13px] font-semibold hover:bg-[color:var(--color-surface2)] disabled:opacity-50"
      >
        {busy === 'manual' ? <Loader2 size={13} className="seed-spin" /> : <RefreshCw size={13} />}{' '}
        Сохранить версию сейчас
      </button>
      {loading ? (
        <Loader2 size={17} className="seed-spin" />
      ) : items.length === 0 ? (
        <p className="text-[13px] text-[color:var(--color-faint)]">
          История появится после первого сохранения.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold">Ревизия {item.rev}</span>
                <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
                  {new Date(item.createdAt).toLocaleString('ru-RU')}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-[color:var(--color-faint)]">
                {item.reason === 'autosave'
                  ? 'Автосохранение'
                  : item.reason === 'pre-destructive'
                    ? 'Перед изменением'
                    : 'Вручную'}{' '}
                · {item.nodeCount} узл. · {item.edgeCount} связ. · {item.trayCount} в монтаже
              </p>
              <button
                type="button"
                data-testid={`board-history-restore-${item.id}`}
                disabled={busy !== null}
                onClick={() => void restore(item)}
                className="mt-2 border-b border-[color:var(--color-accent)] text-[11px] font-semibold text-[color:var(--color-accent)] disabled:opacity-50"
              >
                {busy === item.id ? 'Восстанавливаю…' : 'Восстановить эту версию'}
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
