import { redirect } from 'next/navigation';
import { AppShell } from '../_components/AppShell';
import { apiBaseUrl, apiGet } from '../../lib/server-api';
import type { Tier } from '../../lib/tier-label';
import { SettingsClient } from './SettingsClient';

export const dynamic = 'force-dynamic';

interface MeResponse {
  user: {
    id: string;
    email: string;
    phone?: string | null;
    phoneVerified?: boolean;
    isAnonymous?: boolean;
  };
  flags?: { phoneBindingEnabled?: boolean };
}
interface BalanceResponse {
  available: number;
}
interface ProfileResponse {
  displayName: string | null;
  locale: 'ru' | 'en';
  email: string | null;
  tier: 'free' | 'start' | 'creator' | 'studio' | 'plus' | 'pro' | 'max' | null;
  createdAt: string;
}
interface SubscriptionResponse {
  planAccess: { tier: Tier } | null;
}

export default async function SettingsPage() {
  const [me, balance, profile, subscription] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
    apiGet<ProfileResponse>('/v1/me/profile'),
    apiGet<SubscriptionResponse | null>('/v1/billing/subscription'),
  ]);
  if (!me.data || me.data.user.isAnonymous)
    redirect('/login?next=' + encodeURIComponent('/settings'));

  const availableBalance = balance.data?.available ?? 0;
  // A successful null response means free. A non-2xx response is unknown, so
  // Settings must not assert a free tier from the stale profile column.
  const liveTier =
    subscription.status >= 200 && subscription.status < 300
      ? (subscription.data?.planAccess?.tier ?? 'free')
      : null;

  return (
    <AppShell email={me.data.user.email} balance={availableBalance} apiUrl={apiBaseUrl()}>
      <SettingsClient
        apiUrl={apiBaseUrl()}
        initial={{
          displayName: profile.data?.displayName ?? '',
          locale: profile.data?.locale ?? 'ru',
          email: profile.data?.email ?? me.data.user.email,
          tier: liveTier,
          balance: availableBalance,
          version: process.env.NEXT_PUBLIC_APP_VERSION ?? 'beta',
          phoneBindingEnabled: me.data.flags?.phoneBindingEnabled ?? false,
          phone: me.data.user.phone ?? null,
          phoneVerified: me.data.user.phoneVerified ?? false,
        }}
      />
    </AppShell>
  );
}
