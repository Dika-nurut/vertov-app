import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShell } from '../_components/AppShell';
import { apiBaseUrl, apiGet } from '@/lib/server-api';
import { SearchPageClient } from './SearchPageClient';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;

interface MeResponse {
  user: { id: string; email: string | null; isAnonymous?: boolean };
}

interface BalanceResponse {
  available: number;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string | string[];
    page?: string | string[];
    projectId?: string | string[];
  }>;
}) {
  const userAgent = (await headers()).get('user-agent') ?? '';
  if (MOBILE_UA.test(userAgent)) redirect('/workspace');

  const params = await searchParams;
  const initialQuery = typeof params.q === 'string' ? params.q.slice(0, 100) : '';
  const initialProjectId =
    typeof params.projectId === 'string' ? params.projectId.slice(0, 160) : undefined;
  const requestedPage = typeof params.page === 'string' ? Number(params.page) : 1;
  const initialPage =
    Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 100
      ? requestedPage
      : 1;
  const [me, balance] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
  ]);
  if (!me.data) redirect(`/login?next=${encodeURIComponent('/search')}`);

  return (
    <AppShell
      email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
      balance={balance.data?.available ?? 0}
      apiUrl={apiBaseUrl()}
      isAnonymous={Boolean(me.data.user.isAnonymous)}
    >
      <SearchPageClient
        apiUrl={apiBaseUrl()}
        initialQuery={initialQuery}
        initialPage={initialPage}
        initialProjectId={initialProjectId}
      />
    </AppShell>
  );
}
