import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchUserDetail, apiBaseUrl, n, rub, dt } from '../../_lib';
import { Panel, Eyebrow, Tile } from '../../_components/ui';
import { CreditGrantForm } from './CreditGrantForm';
import { SubscriptionManagementForm } from './SubscriptionManagementForm';
import { UserStatusForm } from './UserStatusForm';
import { TokenStar } from '@/components/ui/token-star';
import { modelDisplayName, modelDisplayNameFromId } from '@/lib/models';

export const metadata: Metadata = { title: 'Вертов · Админ · Пользователь' };
export const dynamic = 'force-dynamic';

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await fetchUserDetail(id);
  if (!d) notFound();

  return (
    <>
      <Link
        href="/admin/users"
        className="mb-4 inline-block font-mono text-[11px] text-faint hover:text-fg"
      >
        ← к поиску
      </Link>
      <header className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="font-display text-2xl font-black tracking-tight">
          {d.contact.email ?? d.user.displayName ?? d.user.id}
        </h1>
        <span className="border-2 border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest capitalize">
          {d.user.tier}
        </span>
        <span
          className={
            'border-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ' +
            (d.user.status === 'active'
              ? 'border-[color:var(--color-line-soft)] text-faint'
              : 'border-destructive text-destructive')
          }
        >
          {d.user.status}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
        <Tile
          label="Баланс"
          value={
            <>
              <TokenStar size={11} />
              {n(d.balance.available)}
            </>
          }
        />
        <Tile
          label="Резерв"
          value={
            <>
              <TokenStar size={11} />
              {n(d.balance.pending)}
            </>
          }
        />
        <Tile label="Телефон" value={<span className="text-base">{d.contact.phone ?? '—'}</span>} />
        <Tile
          label="Регистрация"
          value={<span className="text-base">{dt(d.user.createdAt)}</span>}
        />
      </div>

      <section className="mt-7">
        <Eyebrow>Начислить токены (в аудит-лог)</Eyebrow>
        <Panel>
          <CreditGrantForm userId={d.user.id} apiUrl={apiBaseUrl()} />
        </Panel>
      </section>

      <section className="mt-7">
        <Eyebrow>Подписка</Eyebrow>
        <Panel>
          <SubscriptionManagementForm
            userId={d.user.id}
            apiUrl={apiBaseUrl()}
            subscription={d.subscription}
          />
          {d.linkedAccounts.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {d.linkedAccounts.map((a, i) => (
                <span
                  key={i}
                  className="border-2 border-[color:var(--color-line-soft)] px-2 py-0.5 font-mono text-[11px] text-faint"
                >
                  {a.providerId}
                </span>
              ))}
            </div>
          )}
        </Panel>
      </section>

      <section className="mt-7">
        <Eyebrow>Статус аккаунта</Eyebrow>
        <Panel>
          <UserStatusForm
            userId={d.user.id}
            apiUrl={apiBaseUrl()}
            currentStatus={d.user.status}
            isDeleted={d.user.deletedAt !== null || d.user.status === 'deleted'}
          />
        </Panel>
      </section>

      <div className="mt-7 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <Eyebrow>Последние задачи</Eyebrow>
          <Panel className="px-5 py-1.5">
            <MiniTable
              head={['Модель', 'ID модели', 'Статус', 'Токены', 'Когда']}
              rows={d.recentJobs.map((j) => [
                j.model ? modelDisplayName(j.model) : modelDisplayNameFromId(j.modelId),
                j.modelId,
                j.errorCode ? `${j.status} · ${j.errorCode}` : j.status,
                n(j.creditsSpent),
                dt(j.queuedAt),
              ])}
              empty="Задач нет."
            />
          </Panel>
        </div>
        <div>
          <Eyebrow>Последние платежи</Eyebrow>
          <Panel className="px-5 py-1.5">
            <MiniTable
              head={['Тип', 'Сумма', 'Статус', 'Когда']}
              rows={d.recentOrders.map((o) => [
                o.kind,
                rub(o.amountRub),
                o.ourStatus,
                dt(o.createdAt),
              ])}
              empty="Платежей нет."
            />
          </Panel>
        </div>
      </div>

      <section className="mt-7">
        <Eyebrow>История токенов</Eyebrow>
        <Panel className="px-5 py-1.5">
          <MiniTable
            head={['Когда', 'Сумма', 'Счёт', 'Причина', 'Корзина']}
            rows={d.creditHistory.map((c) => [
              dt(c.createdAt),
              c.amount > 0 ? `+${n(c.amount)}` : n(c.amount),
              c.account,
              c.reason,
              c.origin ? `${c.origin}${c.expiresAt ? ` · до ${dt(c.expiresAt)}` : ''}` : '—',
            ])}
            empty="Операций с токенами нет."
          />
        </Panel>
      </section>
    </>
  );
}

function MiniTable({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="[&>th]:border-b-[2.5px] [&>th]:border-line [&>th]:px-2 [&>th]:pb-2.5 [&>th]:text-left [&>th]:font-mono [&>th]:text-[9px] [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-faint">
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="[&>tr>td]:border-b-[2.5px] [&>tr>td]:border-[color:var(--color-line-soft)] [&>tr>td]:px-2 [&>tr>td]:py-2 [&>tr:last-child>td]:border-b-0">
        {rows.length === 0 && (
          <tr>
            <td colSpan={head.length} className="text-center text-faint">
              {empty}
            </td>
          </tr>
        )}
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((cell, j) => (
              <td key={j} className={j === 0 ? 'font-mono' : ''}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
