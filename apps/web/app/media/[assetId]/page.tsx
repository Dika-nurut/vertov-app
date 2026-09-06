import { apiBaseUrl } from '@/lib/server-api';
import { MediaDetailClient } from './MediaDetailClient';

export const dynamic = 'force-dynamic';

export default async function MediaDetailPage({
  params,
}: {
  params: Promise<{ assetId: string }>;
}) {
  const { assetId } = await params;
  return <MediaDetailClient assetId={assetId} apiUrl={apiBaseUrl()} />;
}
