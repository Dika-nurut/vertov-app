import { redirect } from 'next/navigation';
import { AppShell } from '../_components/AppShell';
import { apiBaseUrl, apiGet } from '../../lib/server-api';
import { GalleryClient, type GalleryItem } from './GalleryClient';
import { parseProjectIdSearchValue, type ProjectIdSearchValue } from '@/lib/project-context';

export const dynamic = 'force-dynamic';

interface MeResponse {
  user: { id: string; email: string; isAnonymous?: boolean };
}
interface BalanceResponse {
  available: number;
}
interface GalleryListResponse {
  rows: GalleryItem[];
  nextCursor: string | null;
}
interface FolderRow {
  folder: string | null;
  count: number;
}
interface TagRow {
  tag: string;
  count: number;
}
interface MediaStorageResponse {
  paid: boolean;
}

export default async function GalleryPage({
  searchParams,
}: {
  searchParams: Promise<{
    folder?: string;
    tag?: string;
    projectId?: ProjectIdSearchValue;
  }>;
}) {
  const sp = await searchParams;
  const folderParam = sp.folder ?? '';
  const tagParam = sp.tag ?? '';
  const context = parseProjectIdSearchValue(sp.projectId);
  const projectIds = context.mode === 'project' ? [context.projectId] : [];
  const projectContextRequested = context.mode !== 'standalone';
  const requestedWorkspaceProjectId = context.mode === 'project' ? context.projectId : null;

  const listQs = new URLSearchParams();
  listQs.set('limit', '24');
  if (folderParam) listQs.set('folder', folderParam);
  if (tagParam) listQs.set('tag', tagParam);
  for (const projectId of projectIds) listQs.append('projectId', projectId);
  const listPath = `/v1/gallery?${listQs.toString()}`;
  const facetQs = new URLSearchParams();
  for (const projectId of projectIds) facetQs.append('projectId', projectId);
  const facetSuffix = facetQs.size > 0 ? `?${facetQs.toString()}` : '';

  const [me, list, folders, tags, balance, mediaStorage] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<GalleryListResponse>(listPath),
    apiGet<FolderRow[]>(`/v1/gallery/folders${facetSuffix}`),
    apiGet<TagRow[]>(`/v1/gallery/tags${facetSuffix}`),
    apiGet<BalanceResponse>('/v1/credits/balance'),
    apiGet<MediaStorageResponse>('/v1/billing/media-storage'),
  ]);
  // Архив is real-account territory (generation history); an anonymous
  // "Гость" session has no business here even if it holds a session cookie.
  if (!me.data || me.data.user.isAnonymous) redirect('/login');

  const initial = list.data ?? { rows: [], nextCursor: null };
  const available = balance.data?.available ?? 0;

  return (
    <AppShell
      email={me.data.user.email}
      balance={available}
      apiUrl={apiBaseUrl()}
      projectContext={context}
    >
      <GalleryClient
        initialRows={initial.rows}
        initialCursor={initial.nextCursor}
        folders={folders.data ?? []}
        tags={tags.data ?? []}
        activeFolder={folderParam || null}
        activeTag={tagParam || null}
        paidMediaStorage={mediaStorage.data?.paid ?? false}
        projectContextRequested={projectContextRequested}
        requestedWorkspaceProjectId={requestedWorkspaceProjectId}
        apiUrl={apiBaseUrl()}
      />
    </AppShell>
  );
}
