import { apiBaseUrl } from '@/lib/server-api';
import { ProjectDesktop } from './ProjectDesktop';

export const dynamic = 'force-dynamic';

export default function WorkspaceListPage() {
  return <ProjectDesktop apiUrl={apiBaseUrl()} />;
}
