import { notFound } from 'next/navigation';
import { apiBaseUrl, apiGet } from '../../../lib/server-api';
import { lockedModelCtaHref } from '../../../lib/locked-model-cta';
import { AnonBootstrap } from '../../_components/AnonBootstrap';
import { ProjectChrome } from '../../_components/ProjectChrome';
import type { ModelRow } from '../../generate/GenerateClient';
import { BoardSurface } from './BoardSurface';
import { BoardRecoveryShell, type InvalidBoardState } from './BoardRecoveryShell';
import {
  parseProjectIdSearchValue,
  withProjectContext,
  type ProjectIdSearchValue,
} from '@/lib/project-context';

export const dynamic = 'force-dynamic';

interface MeResponse {
  user: { id: string; email: string | null; isAnonymous?: boolean };
}
interface BoardResponse {
  id: string;
  projectId: string | null;
  title: string;
  state: Record<string, unknown>;
}
/** Only the LIVE plan matters here — it gates the node model picker
 *  (P-B2/DEC-3, sourced from `planAccess` since W0/D4). The top-level
 *  manageable row is deliberately not read: it can be an elapsed subscription. */
interface SubscriptionResponse {
  planAccess: { tier: string; title: string | null } | null;
}
interface BalanceResponse {
  available: number;
}

export default async function BoardPage({
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
  const boardPath = workspaceProjectId
    ? `/v1/boards/${encodeURIComponent(id)}?projectId=${encodeURIComponent(workspaceProjectId)}`
    : `/v1/boards/${encodeURIComponent(id)}`;
  const [me, board, models, subscription, balance] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    context.mode === 'invalid'
      ? Promise.resolve({ status: 400, data: null })
      : apiGet<BoardResponse | InvalidBoardState>(boardPath),
    apiGet<ModelRow[]>('/v1/models'),
    apiGet<SubscriptionResponse | null>('/v1/billing/subscription'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
  ]);
  // Pre-paywall anonymous browsing (2026-07-07): a deep link (e.g. a shared
  // board URL) can land a cookie-less visitor here directly, not just via
  // /boards' skip-list-when-empty redirect — mint an anon session the same way.
  if (!me.data) {
    return <AnonBootstrap apiUrl={apiBaseUrl()} />;
  }
  if (
    board.status === 409 &&
    board.data &&
    'error' in board.data &&
    board.data.error === 'invalid_board_state'
  ) {
    return (
      <div className="flex h-[100dvh] flex-col">
        <ProjectChrome
          projectContext={context}
          email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
          balance={balance.data?.available ?? 0}
          apiUrl={apiBaseUrl()}
          plan={subscription.data?.planAccess ?? null}
          isAnonymous={Boolean(me.data.user.isAnonymous)}
        />
        <BoardRecoveryShell apiUrl={apiBaseUrl()} board={board.data} />
      </div>
    );
  }
  if (board.status === 409) {
    return (
      <div className="flex h-[100dvh] flex-col">
        <ProjectChrome
          projectContext={context}
          email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
          balance={balance.data?.available ?? 0}
          apiUrl={apiBaseUrl()}
          plan={subscription.data?.planAccess ?? null}
          isAnonymous={Boolean(me.data.user.isAnonymous)}
        />
        <main className="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <div>
            <h1 className="font-display text-2xl font-black">Борд из другого проекта</h1>
            <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">
              Этот борд не переносился. Откройте борд из его проекта.
            </p>
            {workspaceProjectId && (
              <a
                href={withProjectContext('/boards', workspaceProjectId)}
                className="mt-5 inline-block underline decoration-2 underline-offset-4"
              >
                К бордам проекта
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
          plan={subscription.data?.planAccess ?? null}
          isAnonymous={Boolean(me.data.user.isAnonymous)}
        />
        <main className="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <h1 className="font-display text-2xl font-black">Контекст проекта недоступен</h1>
        </main>
      </div>
    );
  }
  if (!board.data) notFound();
  if ('error' in board.data) notFound();

  const usableModels = (models.data ?? []).filter((m) => m.kind === 'image' || m.kind === 'video');
  // Temp operator gateway widget — shown only in dev (same gate as /generate).
  const showGatewayWidget =
    process.env.PROVIDER_SWITCH_UI === '1' || process.env.NODE_ENV !== 'production';

  // The canvas is a FULL-SCREEN editor: no website header/nav — its own minimal
  // header (back · project name · save status) lives inside BoardClient.
  return (
    <div className="flex h-[100dvh] flex-col">
      {context.mode !== 'standalone' && (
        <ProjectChrome
          projectContext={context}
          email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
          balance={balance.data?.available ?? 0}
          apiUrl={apiBaseUrl()}
          plan={subscription.data?.planAccess ?? null}
          isAnonymous={Boolean(me.data.user.isAnonymous)}
        />
      )}
      <BoardSurface
        boardId={board.data.id}
        initialTitle={board.data.title}
        initialState={board.data.state}
        workspaceProjectId={workspaceProjectId}
        models={usableModels}
        planTier={subscription.data?.planAccess?.tier ?? null}
        lockedCtaHref={lockedModelCtaHref({
          hasLivePlan: Boolean(subscription.data?.planAccess),
          hasManageableSubscription: subscription.data != null,
        })}
        apiUrl={apiBaseUrl()}
        devTools={showGatewayWidget}
        isAnonymous={Boolean(me.data.user.isAnonymous)}
      />
    </div>
  );
}
