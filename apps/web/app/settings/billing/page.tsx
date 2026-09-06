import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '../../_components/AppShell';
import { apiBaseUrl, apiGet } from '../../../lib/server-api';
import { BillingClient, type HistoryRow, type Subscription, type Breakdown } from './BillingClient';
import type { PlanAccessBlock } from '../../../lib/plan-block';
import { ErrorState } from '../../_components/states/ErrorState';

export const dynamic = 'force-dynamic';

interface MeResponse {
  user: { id: string; email: string; isAnonymous?: boolean };
}
interface BalanceResponse {
  available: number;
}

export default async function SettingsBillingPage() {
  const [me, balance, history, breakdown, sub] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
    apiGet<HistoryRow[]>('/v1/billing/history?limit=50'),
    apiGet<Breakdown>('/v1/billing/credit-breakdown'),
    // The MANAGEABLE row (top level) — this card exists to cancel a subscription,
    // including one whose period has already elapsed, so it deliberately does not
    // read `planAccess`. `planAccessBlock` is why the two disagree (W0/D6.2).
    apiGet<(Subscription & { planAccessBlock: PlanAccessBlock | null }) | null>(
      '/v1/billing/subscription',
    ),
  ]);
  if (!me.data || me.data.user.isAnonymous)
    redirect('/login?next=' + encodeURIComponent('/settings/billing'));

  const historyFailed = history.status >= 500 || history.data === null;

  return (
    <AppShell
      email={me.data.user.email}
      balance={balance.data?.available ?? 0}
      apiUrl={apiBaseUrl()}
    >
      <div className="mx-auto max-w-4xl">
        <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
          <Link href="/settings" className="hover:underline">
            Настройки
          </Link>{' '}
          → <span className="text-[color:var(--color-foreground)]">Биллинг</span>
        </nav>
        <h1 className="font-display text-3xl font-black uppercase tracking-tight">Биллинг</h1>
        <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
          Управление подпиской, история платежей и баланс токенов по сроку.
        </p>
        {historyFailed ? (
          <ErrorState message="Не удалось загрузить данные биллинга. Попробуйте обновить страницу." />
        ) : (
          <BillingClient
            subscription={sub.data ?? null}
            planAccessBlock={sub.data?.planAccessBlock ?? null}
            history={history.data ?? []}
            breakdown={
              breakdown.data ?? {
                subscriptionGrant: { amount: 0, expiresAt: null },
                packGrant: [],
                pending: 0,
                refund: 0,
              }
            }
            apiUrl={apiBaseUrl()}
          />
        )}
      </div>
    </AppShell>
  );
}
