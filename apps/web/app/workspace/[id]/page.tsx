import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBaseUrl } from '@/lib/server-api';
import { DeskClient } from './DeskClient';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;
export default async function WorkspaceDeskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userAgent = (await headers()).get('user-agent') ?? '';
  if (MOBILE_UA.test(userAgent)) redirect('/workspace');
  return <DeskClient projectId={id} apiUrl={apiBaseUrl()} />;
}
