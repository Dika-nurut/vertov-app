import { apiBaseUrl } from '@/lib/server-api';
import { MediaViewer } from './MediaViewer';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;

export default async function WorkspaceMediaViewer({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}) {
  const { id, assetId } = await params;
  if (MOBILE_UA.test((await headers()).get('user-agent') ?? '')) redirect('/workspace');
  return <MediaViewer projectId={id} assetId={assetId} apiUrl={apiBaseUrl()} />;
}
