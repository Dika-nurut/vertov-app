import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '@/components/ui/wordmark';
import { AppShell } from '../_components/AppShell';
import { apiBaseUrl, apiGet } from '../../lib/server-api';
import {
  PricingClient,
  type CreditPack,
  type CurrentSubscription,
  type PlanAccess,
  type ProofCard,
  type SubscriptionTier,
} from './PricingClient';
import type { PlanAccessBlock } from '../../lib/plan-block';
import { serializeJsonLd } from '@/lib/json-ld';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Тарифы и цены — Vertov',
  description:
    'Прозрачные тарифы: 210 токенов бесплатно при регистрации, без карты. Подписки для профессионалов и разовые пакеты.',
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: 'Vertov · Тарифы',
    description: '210 токенов в подарок · без карты. Подписки от профессионалов.',
    url: '/pricing',
    siteName: 'Vertov',
    type: 'website',
  },
};

interface MeResponse {
  user: { id: string; email: string; isAnonymous?: boolean };
}
interface BalanceResponse {
  available: number;
}
interface ModelRow {
  id: string;
  family: string;
  variant: string;
  kind: string;
  minUnitCredits: number;
}
interface PresetRow {
  slug: string;
  modelId: string;
  samplePreviewUrl: string;
}
interface SubscriptionResponse extends CurrentSubscription {
  planAccess: PlanAccess | null;
  planAccessBlock: PlanAccessBlock | null;
}

// The payment provider is public web configuration; provider secrets stay in the API container.
// Tochka is live, so the beta banner must not depend on TOCHKA_JWT being available to web.
const billingProvider = (process.env.BILLING_PROVIDER ?? 'yookassa').toLowerCase();
const isBetaPaymentMode = billingProvider !== 'tochka' && !process.env.YOOKASSA_SHOP_ID;

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ packs?: string }>;
}) {
  const pageParams = await searchParams;
  const [me, packs, tiers, sub, balance] = await Promise.all([
    apiGet<MeResponse>('/v1/me'),
    apiGet<CreditPack[]>('/v1/billing/packs'),
    apiGet<SubscriptionTier[]>('/v1/billing/tiers'),
    apiGet<SubscriptionResponse | null>('/v1/billing/subscription'),
    apiGet<BalanceResponse>('/v1/credits/balance'),
  ]);
  // Pricing is public: anonymous visitors (including a "Гость" anonymous
  // session, which now carries a real cookie — see pre-paywall browsing)
  // browse the catalog; a purchase routes through login first (guest CTAs
  // handled in PricingClient).
  const guest = !me.data || Boolean(me.data.user.isAnonymous);
  // A 200 null means no subscription and may safely subscribe. Any failed
  // lookup for an authenticated user is unknown state: fail closed so we never
  // offer the server-rejected subscribe route.
  const planStateUnknown = !guest && (sub.status < 200 || sub.status >= 300);

  // A demo card cannot truthfully price itself from the mutable catalog ceiling;
  // it has no persisted request selector. Omit the strip until it carries an
  // authoritative estimate captured with the generation.
  const proofCards: ProofCard[] = [];

  const body = (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd({
            '@context': 'https://schema.org',
            '@type': 'Product',
            name: 'Vertov',
            description: metadata.description,
            url: 'https://vertov.space/pricing',
            brand: { '@type': 'Brand', name: 'Vertov' },
            offers: (tiers.data ?? []).map((tier) => ({
              '@type': 'Offer',
              name: tier.title,
              price: tier.priceRub,
              priceCurrency: 'RUB',
              availability: 'https://schema.org/InStock',
              url: `https://vertov.space/pricing#${tier.tier}`,
            })),
          }),
        }}
      />
      <PricingClient
        packs={packs.data ?? []}
        tiers={tiers.data ?? []}
        planAccess={guest ? null : (sub.data?.planAccess ?? null)}
        planAccessBlock={guest ? null : (sub.data?.planAccessBlock ?? null)}
        planStateUnknown={planStateUnknown}
        proofCards={proofCards}
        apiUrl={apiBaseUrl()}
        contactEmail={guest ? null : (me.data?.user.email ?? null)}
        guest={guest}
        betaPaymentMode={isBetaPaymentMode}
        initialPacksOpen={pageParams.packs === '1'}
      />
    </>
  );

  // Anonymous → lightweight public shell (no authed AppShell chrome).
  if (guest) {
    return (
      <div className="min-h-screen">
        <header className="bg-transparent">
          <nav className="mx-auto flex max-w-[1240px] items-center justify-between px-6 py-4">
            <Link href="/" className="press inline-flex items-center">
              <Wordmark size={28} />
            </Link>
            <Link
              href="/login?next=/pricing"
              className="press inline-grid h-8 place-items-center border-[2.5px] border-[color:var(--color-line)] px-3 font-mono text-[13px] font-bold uppercase tracking-[0.08em] shadow-[3px_3px_0_0_var(--color-accent)]"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-primary-foreground)',
              }}
            >
              Войти
            </Link>
          </nav>
        </header>
        <main>{body}</main>
      </div>
    );
  }

  return (
    <AppShell
      email={me.data!.user.email}
      balance={balance.data?.available ?? 0}
      apiUrl={apiBaseUrl()}
    >
      {body}
    </AppShell>
  );
}
