'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function UserStatusForm({
  userId,
  apiUrl,
  currentStatus,
  isDeleted,
}: {
  userId: string;
  apiUrl: string;
  currentStatus: string;
  isDeleted: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<'active' | 'banned'>(
    currentStatus === 'banned' ? 'banned' : 'active',
  );
  const [reason, setReason] = useState('');
  const [confirmBan, setConfirmBan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (isDeleted || currentStatus === 'deleted') {
    return (
      <p className="text-sm text-faint">
        Аккаунт удалён. Стирание данных необратимо и не изменяется из админ-панели.
      </p>
    );
  }

  async function submit() {
    if (reason.trim().length < 3) {
      setMsg({ ok: false, text: 'Укажи причину не короче 3 символов.' });
      return;
    }
    if (status === 'banned' && !confirmBan) {
      setConfirmBan(true);
      setMsg({ ok: false, text: 'Нажми ещё раз, чтобы подтвердить блокировку.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${apiUrl}/v1/admin/users/${encodeURIComponent(userId)}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status, reason: reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ ok: false, text: body?.error ?? `Ошибка ${res.status}` });
        return;
      }
      setMsg({
        ok: true,
        text: status === 'banned' ? 'Пользователь заблокирован.' : 'Блокировка снята.',
      });
      setReason('');
      setConfirmBan(false);
      router.refresh();
    } catch {
      setMsg({ ok: false, text: 'Сеть недоступна.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-widest text-faint">Статус</span>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as 'active' | 'banned');
              setConfirmBan(false);
            }}
            className="border-[2.5px] border-line bg-[color:var(--color-surface2)] px-3 py-2 text-sm outline-none"
          >
            <option value="active">active</option>
            <option value="banned">banned</option>
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
            Причина
          </span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="например: подтверждённый спам"
            className="w-full border-[2.5px] border-line bg-[color:var(--color-surface2)] px-3 py-2 text-sm outline-none placeholder:text-faint"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className={
            'border-[2.5px] px-5 py-2 text-sm font-bold disabled:opacity-60 ' +
            (status === 'banned'
              ? 'border-destructive text-destructive'
              : 'border-line bg-accent text-[color:var(--color-primary-foreground)]')
          }
        >
          {busy ? '…' : status === 'banned' && confirmBan ? 'Подтвердить блокировку' : 'Сохранить'}
        </button>
      </div>
      <p className="text-[12px] text-faint">
        Заблокированный пользователь не проходит защищённые API-маршруты; разблокировка
        восстанавливает доступ.
      </p>
      {msg && (
        <p className={'text-[13px] ' + (msg.ok ? 'text-positive' : 'text-destructive')}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
