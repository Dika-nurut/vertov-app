import { AppShell } from '../_components/AppShell';
import { AnonBootstrap } from '../_components/AnonBootstrap';
import { apiBaseUrl, apiGet } from '../../lib/server-api';
import { StudioClient, type StudioClip } from './StudioClient';
import { redirect } from 'next/navigation';
import {
  parseProjectIdSearchValue,
  withProjectContext,
  type ProjectIdSearchValue,
} from '@/lib/project-context';

export const dynamic = 'force-dynamic';

interface MeResponse {
  user: { id: string; email: string | null; isAnonymous?: boolean };
}
interface BalanceResponse {
  available: number;
}
interface ClipsResponse {
  clips: StudioClip[];
}

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: ProjectIdSearchValue }>;
}) {
  const sp = await searchParams;
  const context = parseProjectIdSearchValue(sp.projectId);
  if (context.mode === 'project') {
    redirect(withProjectContext('/studio/projects', context.projectId));
  }
  const [me, balance, clips] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
    context.mode === 'invalid'
      ? Promise.resolve({ status: 400, data: null })
      : apiGet<ClipsResponse>('/v1/studio/clips'),
  ]);
  // Pre-paywall anonymous browsing (2026-07-07): mint an anon session client-
  // side instead of redirecting to /login (see AnonBootstrap).
  if (!me.data) {
    return <AnonBootstrap apiUrl={apiBaseUrl()} />;
  }
  if (context.mode === 'invalid') {
    return (
      <AppShell
        email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
        balance={balance.data?.available ?? 0}
        apiUrl={apiBaseUrl()}
        fullBleed
        isAnonymous={Boolean(me.data.user.isAnonymous)}
        projectContext={context}
      >
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <h1 className="font-display text-2xl font-black">Контекст проекта недоступен</h1>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
      balance={balance.data?.available ?? 0}
      apiUrl={apiBaseUrl()}
      fullBleed
      isAnonymous={Boolean(me.data.user.isAnonymous)}
      projectContext={context}
    >
      <StudioClient
        initialClips={clips.data?.clips ?? []}
        apiUrl={apiBaseUrl()}
        ownerId={me.data.user.id}
        isAnonymous={Boolean(me.data.user.isAnonymous)}
      />
    </AppShell>
  );
}
