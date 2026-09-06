'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Subscription = {
  tier: string;
  status: string;
  currentPeriodEnd: string;
  priceRub: number;
  creditsPerCycle: number;
  cancelAtPeriodEnd?: boolean;
};

const tiers = [
  ['start', 'Старт'],
  ['plus', 'Плюс'],
  ['pro', 'Про'],
  ['studio', 'Студия'],
  ['max', 'Макс'],
] as const;

export function SubscriptionManagementForm({
  userId,
  apiUrl,
  subscription,
}: {
  userId: string;
  apiUrl: string;
  subscription: Subscription | null;
}) {
  const router = useRouter();
  const [tier, setTier] = useState(subscription?.tier ?? 'start');
  const [grantCycleCredits, setGrantCycleCredits] = useState(false);
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCloseNow, setConfirmCloseNow] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function request(path: string, method: 'POST' | 'PATCH', body: object, success: string) {
    setBusy(path);
    setMsg(null);
    try {
      const res = await fetch(
        `${apiUrl}/v1/admin/users/${encodeURIComponent(userId)}/subscription${path}`,
        {
          method,
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ ok: false, text: payload?.error ?? `Ошибка ${res.status}` });
        return;
      }
      setMsg({ ok: true, text: success });
      setConfirmCloseNow(false);
      router.refresh();
    } catch {
      setMsg({ ok: false, text: 'Сеть недоступна.' });
    } finally {
      setBusy(null);
    }
  }

  const tierPicker = (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-widest text-faint">Тариф</span>
      <select
        value={tier}
        onChange={(e) => setTier(e.target.value)}
        className="border-[2.5px] border-line bg-[color:var(--color-surface2)] px-3 py-2 text-sm outline-none"
      >
        {tiers.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );

  if (!subscription) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-faint">
          Подписки нет. Комп-подписка действует до конца периода, не продлевается и не создаёт заказ
          или счёт.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          {tierPicker}
          <label className="flex items-center gap-2 pb-2 text-[13px]">
            <input
              type="checkbox"
              checked={grantCycleCredits}
              onChange={(e) => setGrantCycleCredits(e.target.checked)}
            />
            Выдать токены текущего цикла
          </label>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              request('', 'POST', { tier, grantCycleCredits }, 'Комп-подписка создана.')
            }
            className="border-[2.5px] border-line bg-accent px-5 py-2 text-sm font-bold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-line)] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none disabled:opacity-60"
          >
            {busy !== null ? '…' : 'Создать подписку'}
          </button>
        </div>
        <p className="text-[12px] text-faint">
          Токены выдаются отдельно: без отметки выше баланс не меняется.
        </p>
        {msg && <Message msg={msg} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-6 text-[13px]">
        <KV k="Тариф" v={subscription.tier} />
        <KV k="Статус" v={subscription.status} />
        <KV k="До" v={new Date(subscription.currentPeriodEnd).toLocaleString('ru-RU')} />
        <KV k="Цена" v={`${subscription.priceRub.toLocaleString('ru-RU')} ₽`} />
        <KV k="Токенов/цикл" v={subscription.creditsPerCycle.toLocaleString('ru-RU')} />
        <KV k="Автопродление" v={subscription.cancelAtPeriodEnd ? 'отменено' : 'включено'} />
      </div>
      <div className="flex flex-wrap items-end gap-3 border-t-[2.5px] border-[color:var(--color-line-soft)] pt-4">
        {tierPicker}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            request('', 'PATCH', { tier }, 'Тариф подписки изменён. Токены не выдавались.')
          }
          className="border-[2.5px] border-line bg-surface2 px-4 py-2 text-sm font-bold disabled:opacity-60"
        >
          {busy === '' ? '…' : 'Сменить тариф'}
        </button>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
            Добавить дней
          </span>
          <input
            type="number"
            min={1}
            max={3650}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="w-28 border-[2.5px] border-line bg-[color:var(--color-surface2)] px-3 py-2 text-sm outline-none"
          />
        </label>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            const value = Number(days);
            if (!Number.isInteger(value) || value < 1 || value > 3650) {
              setMsg({ ok: false, text: 'Укажи целое число от 1 до 3650.' });
              return;
            }
            request('/extend', 'POST', { days: value }, 'Период и токены текущего цикла продлены.');
          }}
          className="border-[2.5px] border-line bg-surface2 px-4 py-2 text-sm font-bold disabled:opacity-60"
        >
          {busy === '/extend' ? '…' : 'Продлить'}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t-[2.5px] border-[color:var(--color-line-soft)] pt-4">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            request(
              '/close',
              'POST',
              { mode: 'at_period_end' },
              'Подписка закроется в конце периода.',
            )
          }
          className="border-[2.5px] border-line bg-surface2 px-4 py-2 text-sm font-bold disabled:opacity-60"
        >
          {busy === '/close' ? '…' : 'Закрыть в конце периода'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            if (!confirmCloseNow) {
              setConfirmCloseNow(true);
              setMsg({ ok: false, text: 'Нажми ещё раз: доступ будет отозван немедленно.' });
              return;
            }
            request('/close', 'POST', { mode: 'now' }, 'Подписка закрыта, доступ отозван.');
          }}
          className="border-[2.5px] border-destructive px-4 py-2 text-sm font-bold text-destructive disabled:opacity-60"
        >
          {confirmCloseNow ? 'Подтвердить закрытие сейчас' : 'Закрыть сейчас'}
        </button>
      </div>
      {msg && <Message msg={msg} />}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="font-mono text-[9.5px] uppercase tracking-widest text-faint">{k}</div>
      <div className="mt-0.5 font-semibold capitalize">{v}</div>
    </div>
  );
}

function Message({ msg }: { msg: { ok: boolean; text: string } }) {
  return (
    <p className={'text-[13px] ' + (msg.ok ? 'text-positive' : 'text-destructive')}>{msg.text}</p>
  );
}
