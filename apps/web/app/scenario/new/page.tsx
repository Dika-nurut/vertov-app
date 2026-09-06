import type { Metadata } from 'next';
import { AppShell } from '../../_components/AppShell';
import { AnonBootstrap } from '../../_components/AnonBootstrap';
import { apiBaseUrl, apiGet } from '../../../lib/server-api';
import { ScenarioIntentStart } from './ScenarioIntentStart';
import { parseProjectIdSearchValue, type ProjectIdSearchValue } from '@/lib/project-context';

export const metadata: Metadata = {
  title: 'Новый сценарий — Vertov',
  description: 'Опишите замысел — Vertov соберёт редактируемую структуру сценария.',
};
export const dynamic = 'force-dynamic';

interface MeResponse {
  user: { id: string; email: string | null; isAnonymous?: boolean };
}
interface BalanceResponse {
  available: number;
}

export default async function NewScenarioPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: ProjectIdSearchValue }>;
}) {
  const sp = await searchParams;
  const context = parseProjectIdSearchValue(sp.projectId);
  const [me, balance] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
  ]);

  // Keep the same cookie-less anonymous bootstrap as the Scenario list. The
  // intent surface must be browseable before signup, but no row is created by
  // this page load or by a refresh.
  if (!me.data) return <AnonBootstrap apiUrl={apiBaseUrl()} />;

  return (
    <AppShell
      email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
      balance={balance.data?.available ?? 0}
      apiUrl={apiBaseUrl()}
      isAnonymous={Boolean(me.data.user.isAnonymous)}
      projectContext={context}
    >
      <ScenarioIntentStart
        apiUrl={apiBaseUrl()}
        projectId={context.mode === 'project' ? context.projectId : null}
        isAnonymous={Boolean(me.data.user.isAnonymous)}
      />
    </AppShell>
  );
}
