import { redirect } from 'next/navigation';
import { AppShell } from '../../_components/AppShell';
import { apiBaseUrl, apiGet } from '../../../lib/server-api';
import { ReturnClient } from './ReturnClient';

export const dynamic = 'force-dynamic';

interface MeResponse {
  user: { id: string; email: string; isAnonymous?: boolean };
}
interface BalanceResponse {
  available: number;
}

export default async function BillingReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ orderId?: string; forceSuccess?: string }>;
}) {
  const sp = await searchParams;
  const [me, balance] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
  ]);
  if (!me.data || me.data.user.isAnonymous) redirect('/login');
  const orderId = sp.orderId ?? null;
  const forceSuccess = sp.forceSuccess === '1';

  return (
    <AppShell
      email={me.data.user.email}
      balance={balance.data?.available ?? 0}
      apiUrl={apiBaseUrl()}
    >
      <div className="mx-auto max-w-xl py-10 text-center">
        <h1 className="font-display text-2xl font-black uppercase tracking-tight">Оплата</h1>
        <ReturnClient orderId={orderId} forceSuccess={forceSuccess} apiUrl={apiBaseUrl()} />
      </div>
    </AppShell>
  );
}
