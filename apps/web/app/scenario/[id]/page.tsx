import { notFound } from 'next/navigation';
import { apiBaseUrl, apiGet } from '../../../lib/server-api';
import { AnonBootstrap } from '../../_components/AnonBootstrap';
import { ProjectChrome } from '../../_components/ProjectChrome';
import { ScenarioCanvas } from './ScenarioCanvas';
import type { Script } from '../_lib';
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
interface ProfilePlan {
  tier: string;
  title: string | null;
}

export default async function ScenarioCanvasPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ projectId?: ProjectIdSearchValue }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const context = parseProjectIdSearchValue(sp.projectId);
  const workspaceProjectId = context.mode === 'project' ? context.projectId : null;
  const scriptPath = workspaceProjectId
    ? `/v1/scripts/${encodeURIComponent(id)}?projectId=${encodeURIComponent(workspaceProjectId)}`
    : `/v1/scripts/${encodeURIComponent(id)}`;
  const [me, script, balance, plan] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    context.mode === 'invalid'
      ? Promise.resolve({ status: 400, data: null })
      : apiGet<Script>(scriptPath),
    apiGet<BalanceResponse>('/v1/credits/balance'),
    apiGet<ProfilePlan | null>('/v1/billing/subscription'),
  ]);
  // Pre-paywall anonymous browsing (2026-07-07): a deep link can land a
  // cookie-less visitor here directly, not just via the list's
  // skip-list-when-empty redirect — mint an anon session the same way.
  if (!me.data) {
    return <AnonBootstrap apiUrl={apiBaseUrl()} />;
  }
  if (script.status === 409) {
    return (
      <div className="flex h-[100dvh] flex-col">
        <ProjectChrome
          projectContext={context}
          email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
          balance={balance.data?.available ?? 0}
          apiUrl={apiBaseUrl()}
          plan={plan.data}
          isAnonymous={Boolean(me.data.user.isAnonymous)}
        />
        <main className="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <div>
            <h1 className="font-display text-2xl font-black">Сценарий из другого проекта</h1>
            <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">
              Откройте сценарий из его проекта или вернитесь к списку текущего проекта.
            </p>
            {workspaceProjectId && (
              <a
                href={withProjectContext('/scenario', workspaceProjectId)}
                className="mt-5 inline-block underline decoration-2 underline-offset-4"
              >
                К сценариям проекта
              </a>
            )}
          </div>
        </main>
      </div>
    );
  }
  if (context.mode === 'invalid') {
    return (
      <div className="flex h-[100dvh] flex-col">
        <ProjectChrome
          projectContext={context}
          email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
          balance={balance.data?.available ?? 0}
          apiUrl={apiBaseUrl()}
          plan={plan.data}
          isAnonymous={Boolean(me.data.user.isAnonymous)}
        />
        <main className="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <h1 className="font-display text-2xl font-black">Контекст проекта недоступен</h1>
        </main>
      </div>
    );
  }
  if (!script.data) notFound();

  // Full-screen editor (boards pattern): no AppShell — its own in-canvas header.
  return (
    <div className="flex h-dvh flex-col">
      {context.mode !== 'standalone' && (
        <ProjectChrome
          projectContext={context}
          email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
          balance={balance.data?.available ?? 0}
          apiUrl={apiBaseUrl()}
          plan={plan.data}
          isAnonymous={Boolean(me.data.user.isAnonymous)}
        />
      )}
      <ScenarioCanvas
        initial={script.data}
        apiUrl={apiBaseUrl()}
        workspaceProjectId={workspaceProjectId}
        isAnonymous={Boolean(me.data.user.isAnonymous)}
      />
    </div>
  );
}
