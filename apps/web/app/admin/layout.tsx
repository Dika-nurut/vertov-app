import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { apiGet } from '../../lib/server-api';
import { AdminRail } from './_components/AdminRail';

// The admin panel is gated by the API's ADMIN_USER_IDS allowlist (apps/api/src/admin.ts).
// The middleware already forces a session; here we ask the API "is this user an admin?".
// A non-admin (or an anon whose /v1/admin/me came back 401) gets a 404 — the route must
// not reveal that it exists to anyone who isn't allowlisted.
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { data } = await apiGet<{ isAdmin: boolean }>('/v1/admin/me');
  if (!data?.isAdmin) notFound();
  return (
    <div className="grid min-h-screen grid-cols-[232px_1fr] bg-bg text-fg">
      <AdminRail />
      <main className="max-w-[1180px] px-8 py-7 pb-16">{children}</main>
    </div>
  );
}
