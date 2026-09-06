import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { AppShell } from '../_components/AppShell';
import { AnonBootstrap } from '../_components/AnonBootstrap';
import { apiBaseUrl, apiGet } from '../../lib/server-api';
import { lockedModelCtaHref } from '../../lib/locked-model-cta';
import { GenerateClient, type ModelRow, type PresetRow } from './GenerateClient';
import { parseProjectIdSearchValue, type ProjectIdSearchValue } from '@/lib/project-context';
import { normalizeLocale } from '@/lib/locale';

export const metadata: Metadata = {
  title: 'Генерация — Vertov · AI видео и изображения',
  description:
    'Создавайте видео и изображения с помощью AI. Выберите модель, напишите промт — получите результат за минуты.',
  alternates: { canonical: '/generate' },
};
export const dynamic = 'force-dynamic';

interface MeResponse {
  user: { id: string; email: string | null; name?: string; isAnonymous?: boolean };
}
interface BalanceResponse {
  available: number;
  pending: number;
}
export interface PlanResponse {
  tier: string;
  title: string | null;
  creditsPerCycle: number;
  remainingThisCycle: number;
  usedThisCycle: number;
  currentPeriodEnd: string;
  /** The LIVE plan — the only field that may gate the model picker (W0/D4).
   *  Null means nothing entitles this viewer today, whatever the row above says. */
  planAccess: { tier: string } | null;
}
interface MediaStorageResponse {
  paid: boolean;
}

export default async function GeneratePage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    via?: string;
    preset?: string;
    prompt?: string;
    // Kinobar prefills (landing hero, 2026-07-06): model id, seconds, takes.
    model?: string;
    sec?: string;
    n?: string;
    projectId?: ProjectIdSearchValue;
    onboarding?: string;
    lang?: string;
  }>;
}) {
  const sp = await searchParams;
  const cookieStore = await cookies();
  const lang = normalizeLocale(sp.lang ?? cookieStore.get('lang')?.value);
  const context = parseProjectIdSearchValue(sp.projectId);
  const [me, models, balance, plan, mediaStorage, preset] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<ModelRow[]>('/v1/models'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
    apiGet<PlanResponse | null>('/v1/billing/subscription'),
    apiGet<MediaStorageResponse>('/v1/billing/media-storage'),
    sp.preset
      ? apiGet<PresetRow>(`/v1/preset-packs/${encodeURIComponent(sp.preset)}?lang=ru`)
      : Promise.resolve({ data: null }),
  ]);
  // Pre-paywall anonymous browsing (2026-07-07): no session cookie at all yet
  // — mint a Better Auth anonymous() session client-side, then reload this
  // exact URL (prefill query untouched). Middleware no longer redirects this
  // path to /login; the wall now lives at the job-submit call (see
  // GenerateClient's signup_required handling below).
  if (!me.data) {
    return <AnonBootstrap apiUrl={apiBaseUrl()} />;
  }

  const usableModels = (models.data ?? []).filter((m) => m.kind === 'image' || m.kind === 'video');
  const available = balance.data?.available ?? 0;

  // Kinobar prefills — validated against the same short menus the landing bar
  // offers; anything else in the URL is ignored, not clamped.
  const secNum = Number(sp.sec);
  const initialDuration = sp.sec && [5, 10].includes(secNum) ? secNum : null;
  const nNum = Number(sp.n);
  const initialCount = sp.n && [1, 2, 4].includes(nNum) ? nNum : null;

  // Show the dev gateway switch when explicitly enabled (PROVIDER_SWITCH_UI=1),
  // or in any non-production build. Read at request time on the server (this is
  // a force-dynamic Server Component), so it works even under `next start`
  // where NODE_ENV is forced to "production".
  const showProviderSwitch =
    process.env.PROVIDER_SWITCH_UI === '1' || process.env.NODE_ENV !== 'production';

  return (
    <AppShell
      email={me.data.user.isAnonymous ? 'Гость' : (me.data.user.email ?? '')}
      balance={available}
      apiUrl={apiBaseUrl()}
      lang={lang}
      isAnonymous={Boolean(me.data.user.isAnonymous)}
      projectContext={context}
      // Dock-fit tool screen: the dock sizes to 100dvh − header at lg, so the
      // desktop footer would be ~61px of pure page-level overflow (M1).
      hideFooter
    >
      <GenerateClient
        models={usableModels}
        apiUrl={apiBaseUrl()}
        fromJobId={sp.from ?? null}
        viaSlug={sp.via ?? null}
        initialPreset={preset.data ?? null}
        initialPrompt={sp.prompt ?? null}
        initialModelId={sp.model ?? null}
        initialDuration={initialDuration}
        initialCount={initialCount}
        initialBalance={available}
        plan={plan.data ?? null}
        planTier={plan.data?.planAccess?.tier ?? null}
        isAnonymous={Boolean(me.data.user.isAnonymous)}
        lockedCtaHref={lockedModelCtaHref({
          hasLivePlan: Boolean(plan.data?.planAccess),
          hasManageableSubscription: plan.data != null,
        })}
        initialPaidMediaStorage={mediaStorage.data?.paid ?? false}
        onboarding={sp.onboarding === '1'}
        locale={lang}
        devTools={showProviderSwitch}
      />
    </AppShell>
  );
}
