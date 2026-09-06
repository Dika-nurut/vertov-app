import { apiBaseUrl } from '@/lib/server-api';
import { MediaViewer } from './MediaViewer';

export const dynamic = 'force-dynamic';

export default async function WorkspaceMediaViewer({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}) {
  const { id, assetId } = await params;
  return <MediaViewer projectId={id} assetId={assetId} apiUrl={apiBaseUrl()} />;
}
