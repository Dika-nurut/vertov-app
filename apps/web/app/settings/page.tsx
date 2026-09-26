import { redirect } from 'next/navigation';
import { AppShell } from '../_components/AppShell';
import { apiBaseUrl, apiGet } from '../../lib/server-api';
import type { Tier } from '../../lib/tier-label';
import { GIFT_TOKENS_PHONE } from '../../lib/gift-tokens';
import { SettingsClient } from './SettingsClient';

export const dynamic = 'force-dynamic';

interface MeResponse {
  user: {
    id: string;
    email: string | null;
    phone?: string | null;
    phoneVerified?: boolean;
    isAnonymous?: boolean;
  };
  welcome?: {
    phone?: { granted?: boolean; amount?: number; reason?: string } | null;
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
  const phoneGrant = me.data.welcome?.phone;
  const phoneBonus =
    phoneGrant?.granted && typeof phoneGrant.amount === 'number'
      ? phoneGrant.amount
      : phoneGrant?.reason === 'already_granted'
        ? GIFT_TOKENS_PHONE
        : null;
  // A successful null response means free. A non-2xx response is unknown, so
  // Settings must not assert a free tier from the stale profile column.
  const liveTier =
    subscription.status >= 200 && subscription.status < 300
      ? (subscription.data?.planAccess?.tier ?? 'free')
      : null;

  return (
    <AppShell
      email={me.data.user.email ?? me.data.user.phone ?? 'Телефонный аккаунт'}
      balance={availableBalance}
      apiUrl={apiBaseUrl()}
      lang={profile.data?.locale ?? 'ru'}
    >
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
          phoneBonus,
        }}
      />
    </AppShell>
  );
}
