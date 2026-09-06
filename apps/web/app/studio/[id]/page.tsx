import { notFound } from 'next/navigation';
import { AppShell } from '../../_components/AppShell';
import { AnonBootstrap } from '../../_components/AnonBootstrap';
import { apiBaseUrl, apiGet } from '../../../lib/server-api';
import { StudioClient, type StudioClip } from '../StudioClient';
import { StudioHandoffReceipt } from './StudioHandoffReceipt';
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
interface ProjectResponse {
  projectId: string | null;
  title: string;
}

export default async function StudioProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    projectId?: ProjectIdSearchValue;
    handoff?: string | string[];
    sourceBoardId?: string | string[];
    clips?: string | string[];
  }>;
}) {
  const { id: studioProjectId } = await params;
  const sp = await searchParams;
  const context = parseProjectIdSearchValue(sp.projectId);
  const workspaceProjectId = context.mode === 'project' ? context.projectId : null;
  const handoff =
    typeof sp.handoff === 'string' &&
    (sp.handoff === 'created' || sp.handoff === 'updated' || sp.handoff === 'replayed')
      ? sp.handoff
      : null;
  const sourceBoardId =
    typeof sp.sourceBoardId === 'string' && sp.sourceBoardId.length <= 128
      ? sp.sourceBoardId
      : null;
  const clipCount =
    typeof sp.clips === 'string' && /^\d{1,4}$/.test(sp.clips) ? Number(sp.clips) : null;
  const contextQuery = workspaceProjectId
    ? `?projectId=${encodeURIComponent(workspaceProjectId)}`
    : '';
  const [me, balance, clips, project] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
    context.mode === 'invalid'
      ? Promise.resolve({ status: 400, data: null })
      : apiGet<ClipsResponse>(`/v1/studio/clips${contextQuery}`),
    context.mode === 'invalid'
      ? Promise.resolve({ status: 400, data: null })
      : apiGet<ProjectResponse>(
          `/v1/studio/projects/${encodeURIComponent(studioProjectId)}${contextQuery}`,
        ),
  ]);
  // Pre-paywall anonymous browsing (2026-07-07): a deep link can land a
  // cookie-less visitor here directly — mint an anon session the same way.
  if (!me.data) {
    return <AnonBootstrap apiUrl={apiBaseUrl()} />;
  }
  // Unknown / not-owned project → 404 rather than a blank editor.
  if (project.status === 409) {
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
          <div>
            <h1 className="font-display text-2xl font-black">Монтаж из другого проекта</h1>
            <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">
              Этот монтаж не переносился. Откройте его из исходного проекта.
            </p>
            {workspaceProjectId && (
              <a
                href={withProjectContext('/studio/projects', workspaceProjectId)}
                className="mt-5 inline-block underline decoration-2 underline-offset-4"
              >
                К монтажам проекта
              </a>
            )}
          </div>
        </div>
      </AppShell>
    );
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
  if (!project.data) notFound();

  return (
    <AppShell
      email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
      balance={balance.data?.available ?? 0}
      apiUrl={apiBaseUrl()}
      fullBleed
      isAnonymous={Boolean(me.data.user.isAnonymous)}
      projectContext={context}
    >
      <>
        {workspaceProjectId && handoff && sourceBoardId && clipCount !== null && (
          <StudioHandoffReceipt
            status={handoff}
            sourceBoardId={sourceBoardId}
            clipCount={clipCount}
            projectId={workspaceProjectId}
          />
        )}
        <StudioClient
          initialClips={clips.data?.clips ?? []}
          apiUrl={apiBaseUrl()}
          ownerId={me.data.user.id}
          studioProjectId={studioProjectId}
          {...(workspaceProjectId ? { workspaceProjectId } : {})}
          projectTitle={project.data.title}
          isAnonymous={Boolean(me.data.user.isAnonymous)}
        />
      </>
    </AppShell>
  );
}
