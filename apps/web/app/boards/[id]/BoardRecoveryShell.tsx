'use client';

import { useEffect, useState } from 'react';
import { Archive, Loader2, RefreshCw, TriangleAlert } from '@/components/ui/icons';
import {
  clearBoardRecovery,
  getBoardRecoveryClientId,
  readBoardRecovery,
  type BoardRecoverySnapshot,
} from '@/lib/board-recovery';

export interface InvalidBoardState {
  error: 'invalid_board_state';
  boardId: string;
  title: string;
  rev: number;
  recoveryAvailable?: boolean;
  message: string;
}

export function BoardRecoveryShell({
  apiUrl,
  board,
}: {
  apiUrl: string;
  board: InvalidBoardState;
}) {
  const [snapshot, setSnapshot] = useState<BoardRecoverySnapshot | null>(null);
  const [serverSnapshotId, setServerSnapshotId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [working, setWorking] = useState<'restore' | 'reset' | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = getBoardRecoveryClientId(window.sessionStorage);
    setClientId(id);
    setSnapshot(readBoardRecovery(window.localStorage, board.boardId, id));
    if (board.recoveryAvailable) {
      void fetch(`${apiUrl}/v1/boards/${board.boardId}/snapshots`, {
        credentials: 'include',
      })
        .then(async (response) => {
          if (!response.ok) return null;
          return (await response.json()) as { items?: Array<{ id?: string }> };
        })
        .then((payload) => {
          const id = payload?.items?.[0]?.id;
          if (id) setServerSnapshotId(id);
        })
        .catch(() => undefined);
    }
  }, [apiUrl, board.boardId, board.recoveryAvailable]);

  async function restore() {
    if (!snapshot && !serverSnapshotId) return;
    setWorking('restore');
    setError(null);
    try {
      const response = snapshot
        ? await fetch(`${apiUrl}/v1/boards/${board.boardId}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state: snapshot.state, rev: snapshot.expectedRev }),
          })
        : await fetch(
            `${apiUrl}/v1/boards/${board.boardId}/snapshots/${serverSnapshotId}/restore`,
            {
              method: 'POST',
              credentials: 'include',
            },
          );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          body.error === 'rev_conflict'
            ? 'Версия борда уже изменилась. Обновите страницу и проверьте историю.'
            : 'Не удалось восстановить копию.',
        );
      }
      if (clientId) clearBoardRecovery(window.localStorage, board.boardId, clientId);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось восстановить копию.');
    } finally {
      setWorking(null);
    }
  }

  async function reset() {
    setWorking('reset');
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/v1/boards/${board.boardId}/reset`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: true }),
      });
      if (!response.ok) throw new Error('Не удалось сбросить борд.');
      if (clientId) clearBoardRecovery(window.localStorage, board.boardId, clientId);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сбросить борд.');
    } finally {
      setWorking(null);
    }
  }

  return (
    <main className="grid min-h-0 flex-1 place-items-center bg-[color:var(--color-bg)] p-6">
      <section
        className="glass w-full max-w-xl border-[2.5px] border-destructive/60 p-6 shadow-[5px_5px_0_0_var(--color-shadow)]"
        data-testid="board-recovery-shell"
        aria-labelledby="board-recovery-title"
      >
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 shrink-0 text-destructive" size={22} />
          <div>
            <h1 id="board-recovery-title" className="font-display text-2xl font-black">
              Борд «{board.title}» не открывается
            </h1>
            <p className="mt-3 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              {board.message}
            </p>
          </div>
        </div>
        {error && (
          <p
            role="alert"
            data-testid="board-recovery-error"
            className="mt-4 rounded border-2 border-destructive/50 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
          >
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-2">
          {(snapshot || serverSnapshotId) && (
            <button
              type="button"
              data-testid="board-recovery-restore"
              onClick={() => void restore()}
              disabled={working !== null}
              className="glass-accent inline-flex items-center gap-2 px-4 py-2 text-[13px] font-bold"
            >
              {working === 'restore' ? (
                <Loader2 size={15} className="seed-spin" />
              ) : (
                <Archive size={15} />
              )}{' '}
              Восстановить из последней копии
            </button>
          )}
          {!confirmReset ? (
            <button
              type="button"
              data-testid="board-recovery-reset"
              onClick={() => setConfirmReset(true)}
              disabled={working !== null}
              className="inline-flex items-center gap-2 border-2 border-[color:var(--color-line)] px-4 py-2 text-[13px] font-bold"
            >
              <RefreshCw size={15} /> Сбросить борд
            </button>
          ) : (
            <div
              role="dialog"
              aria-label="Подтверждение сброса"
              className="flex items-center gap-2 border-2 border-destructive/60 bg-destructive/10 px-2 py-1.5"
            >
              <span className="text-[11px] text-destructive">
                Старое состояние сохранится на 30 дней.
              </span>
              <button
                type="button"
                data-testid="board-recovery-reset-confirm"
                onClick={() => void reset()}
                disabled={working !== null}
                className="bg-destructive px-2 py-1 text-[11px] font-bold text-[color:var(--color-destructive-foreground)]"
              >
                Подтвердить
              </button>
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="px-1 text-[11px] font-semibold"
              >
                Отмена
              </button>
            </div>
          )}
        </div>
        {!snapshot && board.recoveryAvailable && (
          <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">
            Локальная копия в этом браузере не найдена. Сброс создаст новый пустой документ.
          </p>
        )}
      </section>
    </main>
  );
}
