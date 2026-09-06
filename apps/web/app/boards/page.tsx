import { redirect } from 'next/navigation';
import { AppShell } from '../_components/AppShell';
import { AnonBootstrap } from '../_components/AnonBootstrap';
import { apiBaseUrl, apiGet, apiPost } from '../../lib/server-api';
import { BoardsClient, type BoardRow } from './BoardsClient';
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

export default async function BoardsPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: ProjectIdSearchValue }>;
}) {
  const sp = await searchParams;
  const context = parseProjectIdSearchValue(sp.projectId);
  const workspaceProjectId = context.mode === 'project' ? context.projectId : null;
  const listPath = workspaceProjectId
    ? `/v1/boards?projectId=${encodeURIComponent(workspaceProjectId)}`
    : '/v1/boards';
  const [me, balance, list] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
    context.mode === 'invalid'
      ? Promise.resolve({ status: 400, data: null })
      : apiGet<{ items: BoardRow[]; nextCursor: string | null }>(listPath),
  ]);
  // Pre-paywall anonymous browsing (2026-07-07): no session cookie at all yet
  // — mint one client-side and reload (see AnonBootstrap / generate/page.tsx).
  if (!me.data) {
    return <AnonBootstrap apiUrl={apiBaseUrl()} />;
  }

  const items = list.data?.items ?? [];
  // Skip-list-when-empty (same rule as /generate having no list step at all):
  // a visitor — anon or real — with zero boards goes straight into a fresh
  // one instead of an empty list page.
  if (list.status === 200 && items.length === 0) {
    const created = await apiPost<BoardRow>('/v1/boards', {
      title: 'Проект 1',
      ...(workspaceProjectId ? { projectId: workspaceProjectId } : {}),
    });
    if (created.data) {
      const href = `/boards/${created.data.id}`;
      redirect(workspaceProjectId ? withProjectContext(href, workspaceProjectId) : href);
    }
  }

  return (
    <AppShell
      email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
      balance={balance.data?.available ?? 0}
      apiUrl={apiBaseUrl()}
      isAnonymous={Boolean(me.data.user.isAnonymous)}
      projectContext={context}
    >
      <BoardsClient
        initial={items}
        initialCursor={list.data?.nextCursor ?? null}
        apiUrl={apiBaseUrl()}
        projectContextRequested={context.mode !== 'standalone'}
        requestedWorkspaceProjectId={workspaceProjectId}
      />
    </AppShell>
  );
}
