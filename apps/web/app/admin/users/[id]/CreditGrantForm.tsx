'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// Manual credit grant/refund. POSTs to the audited /v1/admin/users/:id/credits
// endpoint (browser → API with the session cookie) then refreshes the server view.
export function CreditGrantForm({ userId, apiUrl }: { userId: string; apiUrl: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [account, setAccount] = useState<'refund' | 'pack_grant'>('refund');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Stable idempotency key for the current grant attempt: if the response is lost
  // (tunnel timeout) and the admin re-clicks, the same key dedups the grant instead
  // of double-crediting. Rotated only after a confirmed success (below).
  const idemKey = useRef<string>(crypto.randomUUID());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt <= 0 || reason.trim().length < 3) {
      setMsg({ ok: false, text: 'Введи целое количество > 0 и причину (≥3 симв.).' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${apiUrl}/v1/admin/users/${encodeURIComponent(userId)}/credits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          amount: amt,
          reason: reason.trim(),
          account,
          idempotencyKey: idemKey.current,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ ok: false, text: body?.error ?? `Ошибка ${res.status}` });
        return;
      }
      setMsg({
        ok: true,
        text:
          body.outcome === 'replayed'
            ? `Уже начислено ранее. Баланс: ${body.balance?.available ?? '?'}.`
            : `Начислено ${amt}. Баланс: ${body.balance?.available ?? '?'}.`,
      });
      idemKey.current = crypto.randomUUID(); // next grant is a distinct operation
      setAmount('');
      setReason('');
      router.refresh();
    } catch {
      setMsg({ ok: false, text: 'Сеть недоступна.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-widest text-faint">Токены</span>
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-32 border-[2.5px] border-line bg-[color:var(--color-surface2)] px-3 py-2 text-sm outline-none focus:shadow-[3px_3px_0_0_var(--color-accent)]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-widest text-faint">Счёт</span>
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value as 'refund' | 'pack_grant')}
            className="border-[2.5px] border-line bg-[color:var(--color-surface2)] px-3 py-2 text-sm outline-none"
          >
            <option value="refund">refund (возврат)</option>
            <option value="pack_grant">pack_grant (пакет)</option>
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
            Причина
          </span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="например: компенсация за неудачный рендер"
            className="w-full border-[2.5px] border-line bg-[color:var(--color-surface2)] px-3 py-2 text-sm outline-none placeholder:text-faint focus:shadow-[3px_3px_0_0_var(--color-accent)]"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="border-[2.5px] border-line bg-accent px-5 py-2 text-sm font-bold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-line)] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none disabled:opacity-60"
        >
          {busy ? '…' : 'Начислить'}
        </button>
      </div>
      {msg && (
        <p className={'text-[13px] ' + (msg.ok ? 'text-positive' : 'text-destructive')}>
          {msg.text}
        </p>
      )}
    </form>
  );
}
