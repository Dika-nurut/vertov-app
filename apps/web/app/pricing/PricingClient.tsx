'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { analyticsErrorBucket, trackEvent, PlausibleEvent } from '../_components/PlausibleEvents';
import { TokenStar } from '@/components/ui/token-star';
import { PixelGlyph } from '@/components/ui/pixel-glyph';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { assetSrc } from '@/lib/asset-src';
import { formatUtcDate, planBlockNotice, type PlanAccessBlock } from '@/lib/plan-block';
import { BetaPaymentBanner } from './BetaPaymentBanner';
import {
  arePacksUnlocked,
  bezelLockedTier,
  deriveCta,
  isLegacyActiveTier,
  type PlanCta,
  type PricingContext,
} from './plan-state';
import {
  BEST_VALUE_TIER,
  BEZEL_PAIR,
  COST_PHOTO,
  COST_VIDEO,
  FAQ,
  PLAN_CONTENT,
  type CostRow,
  type PlanFit,
} from './plan-content';

export interface CreditPack {
  id: string;
  credits: number;
  priceRub: number;
  title: string;
  description: string | null;
  sortOrder: number;
}

export interface SubscriptionTier {
  tier: string;
  priceRub: number;
  creditsPerCycle: number;
  title: string;
  description: string | null;
  sortOrder: number;
}

export interface CurrentSubscription {
  id: string;
  tier: string;
  title?: string | null;
  status: string;
  priceRub?: number;
  creditsPerCycle?: number;
  cancelAtPeriodEnd: boolean;
  autoRenew: boolean;
  /** Scheduled-downgrade target tier + its title, applied at period end. */
  pendingTier?: string | null;
  pendingTitle?: string | null;
  /** ISO — end of the paid month; when a scheduled downgrade takes effect. */
  currentPeriodEnd?: string | null;
}

/** The entitlement row: only this live plan may drive pricing affordances. */
export interface PlanAccess {
  tier: string;
  title?: string | null;
  priceRub?: number | null;
  pendingTier?: string | null;
  currentPeriodEnd?: string | null;
}

export interface ProofCard {
  previewUrl: string;
  model: string;
  tokens: number;
}

const ACCENT = 'var(--color-accent)';
const INK = 'var(--color-primary-foreground)';
const LIME = 'var(--color-accent2)';
const LIME_INK = 'var(--color-accent2-foreground)';

function fmt(n: number): string {
  return n.toLocaleString('ru-RU');
}

/** Shown when packs are bought without an active subscription (API 403
 *  active_subscription_required) or tapped while locked — packs are a
 *  subscriber add-on, so the tiers below are the subscribe-first CTA. */
const PACK_SUBSCRIPTION_REQUIRED_COPY =
  'Разовые пакеты — докупка для подписчиков. Сначала выберите подписку ниже — пакеты откроются автоматически.';

/** One pixel-glyph tick + label. Neutral by default — lime lives ONLY on the
 *  recommended (popular) plate, never as an every-row flood. */
function Check({ children, hot = false }: { children: ReactNode; hot?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <PixelGlyph
        name="catalog"
        size={13}
        aria-hidden
        className="shrink-0"
        style={{ color: hot ? LIME : 'var(--color-muted-foreground)' }}
      />
      <span className="whitespace-nowrap">{children}</span>
    </div>
  );
}

/** A single «fit» line: port-colored square + count + label. */
function Fit({ fit }: { fit: PlanFit }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span
        className="mt-px h-[7px] w-[7px] shrink-0 -translate-y-px"
        style={{
          background: fit.kind === 'v' ? 'var(--color-port-video)' : 'var(--color-port-image)',
        }}
      />
      <span>
        <b className="text-[color:var(--color-fg)]">{fit.count}</b> {fit.label}
      </span>
    </div>
  );
}

/** The plate action zone: subscribe/upgrade/downgrade button, the lime current-
 *  tier status marker, or the scheduled-downgrade state — styled per press-physics. */
function PlateCta({
  cta,
  popular,
  pending,
  onClick,
  scheduledDate,
  scheduledPriceRub,
  onCancel,
  secondary = false,
}: {
  cta: PlanCta;
  popular: boolean;
  pending: boolean;
  onClick: () => void;
  /** Formatted DD.MM the scheduled downgrade takes effect. */
  scheduledDate?: string | null | undefined;
  /** Price this plate's tier will charge at the scheduled renewal. */
  scheduledPriceRub?: number | undefined;
  /** Cancel the scheduled downgrade. */
  onCancel?: (() => void) | undefined;
  /** True when this sits below another control in the action zone (tighter top margin). */
  secondary?: boolean;
}) {
  // Current tier — a LIME, non-interactive status marker (not an action).
  if (cta.status) {
    return (
      <div
        data-testid="plate-cta"
        data-action="current"
        className={
          (secondary ? 'mt-2.5' : 'mt-5') +
          ' w-full border-[2.5px] border-[color:var(--color-line)] py-3.5 text-center font-mono text-[13px] font-bold uppercase tracking-[0.1em]'
        }
        style={{ background: LIME, color: LIME_INK }}
      >
        {cta.label}
      </div>
    );
  }

  // Scheduled downgrade target — «Запланирован с DD.MM» + cancel.
  if (cta.scheduled) {
    return (
      <div className="mt-5 w-full">
        <div
          data-testid="plate-cta"
          data-action="scheduled"
          className="w-full border-[2.5px] border-[color:var(--color-accent)] py-3 text-center font-mono text-[11px] font-bold uppercase tracking-[0.08em]"
          style={{ color: 'var(--color-accent)' }}
        >
          {scheduledDate
            ? `Запланирован с ${scheduledDate} · ${fmt(scheduledPriceRub ?? 0)} ₽/мес`
            : 'Запланирован'}
        </div>
        <button
          type="button"
          data-testid="plate-cancel-downgrade"
          disabled={pending}
          onClick={onCancel}
          className="press mt-2 w-full border-[2.5px] border-[color:var(--color-line)] py-2.5 text-center font-mono text-[11px] font-bold uppercase tracking-[0.08em]"
          style={{ background: 'var(--color-surface2)', color: 'var(--color-fg)' }}
        >
          {pending ? 'Отменяем…' : 'Отменить переход'}
        </button>
      </div>
    );
  }

  const accented = popular && !cta.disabled;
  return (
    <button
      type="button"
      data-testid="plate-cta"
      data-action={cta.action}
      disabled={cta.disabled || pending}
      onClick={onClick}
      className={
        'press mt-5 w-full border-[2.5px] border-[color:var(--color-line)] py-3.5 text-center font-mono text-[13px] font-bold uppercase tracking-[0.1em] ' +
        (cta.disabled ? 'cursor-default opacity-60 ' : '')
      }
      style={
        accented
          ? { background: ACCENT, color: INK, boxShadow: '3px 3px 0 0 var(--color-shadow)' }
          : {
              background: 'var(--color-surface2)',
              color: 'var(--color-fg)',
              boxShadow: cta.disabled ? 'none' : '3px 3px 0 0 var(--color-accent)',
            }
      }
    >
      {pending ? 'Перенаправляем…' : cta.label}
    </button>
  );
}

/** Shared plate chrome. `bezel` is injected between the token line and fits. */
function PlateShell({
  tier,
  name,
  popular,
  priceRub,
  credits,
  content,
  bezel,
  cta,
  pending,
  onCta,
  bestValue,
  scheduledDate,
  onCancel,
  onBuyTokens,
}: {
  tier: string;
  name: string;
  popular: boolean;
  priceRub: number;
  credits: number;
  content: { fits: PlanFit[]; checks: string[] };
  bezel?: ReactNode;
  cta: PlanCta;
  pending: boolean;
  onCta: () => void;
  bestValue: boolean;
  scheduledDate?: string | null | undefined;
  onCancel?: (() => void) | undefined;
  /** When set (current-tier plate), renders the «Пополнить токены» secondary CTA. */
  onBuyTokens?: (() => void) | undefined;
}) {
  return (
    <div
      data-testid="tier-plate"
      data-tier={tier}
      className={
        'relative flex flex-col border-[2.5px] p-[26px_22px_22px] shadow-[5px_5px_0_0_var(--color-accent)] ' +
        (popular ? 'border-[color:var(--color-accent)]' : 'border-[color:var(--color-line)]')
      }
      style={{ background: 'var(--color-card)', padding: '26px 22px 22px' }}
    >
      <div className="flex min-h-[22px] items-center justify-between">
        <span className="font-mono text-[13px] uppercase tracking-[0.2em] text-[color:var(--color-muted-foreground)]">
          {name}
        </span>
        {popular && (
          <span
            className="px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.14em]"
            style={{ background: ACCENT, color: INK }}
          >
            Популярно
          </span>
        )}
        {bestValue && !popular && (
          <span
            className="px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.12em]"
            style={{ background: LIME, color: LIME_INK }}
          >
            Лучшая цена
          </span>
        )}
      </div>

      <div className="mt-4 whitespace-nowrap font-display text-[32px] font-black tracking-[-0.01em]">
        {fmt(priceRub)}&nbsp;₽{' '}
        <small className="font-mono text-[11px] font-normal tracking-[0.08em] text-[color:var(--color-faint)]">
          /мес
        </small>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <TokenStar size={14} style={{ color: ACCENT }} />
        <b className="font-mono text-[16px] font-bold tracking-[0.02em]">{fmt(credits)}</b>
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[color:var(--color-faint)]">
          токенов
        </span>
      </div>

      {bezel}

      <div className="mt-5 flex flex-col gap-[11px] border-t-[1.5px] border-[color:var(--color-line-soft)] pt-4 text-[13px] text-[color:var(--color-muted-foreground)]">
        {content.fits.map((f, i) => (
          <Fit key={i} fit={f} />
        ))}
      </div>

      <div className="mt-[18px] flex flex-col gap-2.5 border-t-[1.5px] border-[color:var(--color-line-soft)] pt-4 text-[13px] text-[color:var(--color-muted-foreground)]">
        {content.checks.map((c, i) => (
          <Check key={i} hot={popular}>
            {c}
          </Check>
        ))}
      </div>

      <div className="mt-auto">
        {/* Current-tier plate: «Пополнить токены» sits on top; the lime status
            marker drops into the standard CTA slot below it, so plate bottoms
            still align with the action button on every other plate. */}
        {cta.status && onBuyTokens ? (
          <>
            <button
              type="button"
              data-testid="plate-buy-tokens"
              onClick={onBuyTokens}
              className="press mt-5 w-full border-[2.5px] border-[color:var(--color-line)] py-3 text-center font-mono text-[11px] font-bold uppercase tracking-[0.08em]"
              style={{ background: 'transparent', color: 'var(--color-fg)' }}
            >
              Пополнить токены
            </button>
            <PlateCta
              cta={cta}
              popular={popular}
              pending={pending}
              onClick={onCta}
              scheduledDate={scheduledDate}
              scheduledPriceRub={priceRub}
              onCancel={onCancel}
              secondary
            />
          </>
        ) : (
          <PlateCta
            cta={cta}
            popular={popular}
            pending={pending}
            onClick={onCta}
            scheduledDate={scheduledDate}
            scheduledPriceRub={priceRub}
            onCancel={onCancel}
          />
        )}
      </div>
    </div>
  );
}

function CostTable({
  title,
  unit,
  kind,
  rows,
}: {
  title: string;
  unit: string;
  kind: 'v' | 'i';
  rows: CostRow[];
}) {
  return (
    <div
      data-testid="cost-table"
      data-kind={kind}
      className="border-[2.5px] border-[color:var(--color-line)] [&+&]:ml-[-2.5px] max-md:[&+&]:ml-0 max-md:[&+&]:mt-[-2.5px]"
      style={{ background: 'var(--color-surface2)' }}
    >
      <div
        className="flex items-center justify-between border-b-[2.5px] border-[color:var(--color-line)] px-5 py-[13px]"
        style={{ background: 'var(--color-card)' }}
      >
        <span className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">
          <span
            className="h-[9px] w-[9px]"
            style={{
              background: kind === 'v' ? 'var(--color-port-video)' : 'var(--color-port-image)',
            }}
          />
          {title}
        </span>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[color:var(--color-faint)]">
          {unit}
        </span>
      </div>
      {rows.map((r, i) => (
        <div
          key={i}
          data-testid="cost-row"
          className="flex items-baseline justify-between border-b-[1.5px] border-[color:var(--color-line-soft)] px-5 py-2.5 text-[13px] last:border-b-0"
        >
          <span className="font-bold">
            {r.model}
            {r.cfg && (
              <span className="ml-2.5 font-mono text-[11px] uppercase tracking-[0.06em] text-[color:var(--color-faint)]">
                {r.cfg}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[13px] font-bold">
            {r.tokens}
          </span>
        </div>
      ))}
    </div>
  );
}

export function PricingClient({
  packs,
  tiers,
  planAccess,
  planAccessBlock,
  planStateUnknown,
  proofCards,
  apiUrl,
  contactEmail = null,
  guest = false,
  betaPaymentMode = false,
  initialPacksOpen = false,
}: {
  packs: CreditPack[];
  tiers: SubscriptionTier[];
  planAccess: PlanAccess | null;
  planAccessBlock: PlanAccessBlock | null;
  /** Subscription fetch failed for an authenticated viewer: fail closed to billing. */
  planStateUnknown: boolean;
  proofCards: ProofCard[];
  apiUrl: string;
  contactEmail?: string | null;
  guest?: boolean;
  betaPaymentMode?: boolean;
  initialPacksOpen?: boolean;
}) {
  const router = useRouter();
  const ctx: PricingContext = {
    guest,
    activeTier: planAccess?.tier ?? null,
    activePriceRub: planAccess?.priceRub ?? null,
    pendingTier: planAccess?.pendingTier ?? null,
    planBlocked: Boolean(planAccessBlock),
    planStateUnknown,
  };
  const packsUnlocked = arePacksUnlocked(ctx);
  const gridTiers = tiers.map((t) => t.tier);
  const legacyActive = isLegacyActiveTier(ctx, gridTiers);

  // DD.MM the scheduled downgrade takes effect (end of the paid month).
  const scheduledDate =
    !planAccessBlock && planAccess?.currentPeriodEnd
      ? formatUtcDate(planAccess.currentPeriodEnd)
      : null;

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Order id of an already-started checkout (409 checkout_in_progress) — the
  // return page for it now carries the resume link, so this is the way out.
  const [resumeOrderId, setResumeOrderId] = useState<string | null>(null);
  const [receiptEmail, setReceiptEmail] = useState(contactEmail ?? '');
  // Tochka's receipt API needs the buyer contact BEFORE a payment link exists.
  // This modal is the explicit checkout step; it also covers profiles whose
  // OAuth provider did not return an email.
  const [checkoutContact, setCheckoutContact] = useState<{
    path: string;
    payloadKey: string;
    itemId: string;
    kind: 'subscription' | 'pack' | 'upgrade';
    title: string;
    priceRub: number;
  } | null>(null);
  // Downgrade confirm step — the plate + tier the viewer is moving down to.
  const [confirmDowngrade, setConfirmDowngrade] = useState<{ tier: string; title: string } | null>(
    null,
  );
  // «Пополнить токены» / «Разовые пакеты» both open this modal — the page
  // itself only ever shows the subscription plates.
  const [packsModalOpen, setPacksModalOpen] = useState(Boolean(initialPacksOpen));

  // Студия⟷Макс bezel — one plate, two backend tiers. If the viewer already
  // subscribes to one of the pair, the knob locks to it.
  const lockedBezel = bezelLockedTier(ctx, BEZEL_PAIR);
  const [bezelTier, setBezelTier] = useState<string>(lockedBezel === 'max' ? 'max' : 'studio');
  const effectiveBezelTier = lockedBezel ?? bezelTier;

  const byTier = new Map(tiers.map((t) => [t.tier, t]));

  async function checkout(
    path: string,
    payloadKey: string,
    tier: string,
    kind: 'subscription' | 'pack' | 'upgrade',
    pendKey: string,
  ) {
    if (guest) {
      window.location.href = '/login?next=/pricing';
      return;
    }
    const email = (contactEmail ?? receiptEmail).trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      trackEvent(PlausibleEvent.checkoutFailed, { kind, reason: 'validation' });
      setError('Укажите корректный email для электронного чека');
      return;
    }
    setPendingId(pendKey);
    setError(null);
    setResumeOrderId(null);
    try {
      const res = await fetch(`${apiUrl}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          [payloadKey]: tier,
          customerEmail: email,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        // Packs are a subscriber add-on: without an active subscription the
        // API answers 403 active_subscription_required. Point at the tiers
        // below instead of showing the raw code.
        if (res.status === 403 && b?.error === 'active_subscription_required') {
          trackEvent(PlausibleEvent.checkoutFailed, {
            kind,
            reason: analyticsErrorBucket(String(b.error)),
          });
          setError(PACK_SUBSCRIPTION_REQUIRED_COPY);
          setPacksModalOpen(false);
          return;
        }
        // W1-0: the API refuses a second checkout for the same thing while one
        // is still in progress — that is what stops a double charge. Point at
        // the return page, which now carries the SAME payment link to finish.
        if (res.status === 409 && b?.error === 'checkout_in_progress') {
          trackEvent(PlausibleEvent.checkoutFailed, { kind, reason: 'in_progress' });
          setError(
            'Оплата этой покупки уже начата — продолжите её по кнопке ниже. Повторный счёт мы не выставляем, чтобы не списать деньги дважды.',
          );
          setResumeOrderId(
            typeof b?.orderId === 'string' && b.orderId.length > 0 ? b.orderId : null,
          );
          return;
        }
        if (
          res.status === 409 &&
          (b?.error === 'subscription_expired' ||
            b?.error === 'subscription_renewal_pending' ||
            b?.error === 'subscription_payment_pending' ||
            b?.error === 'subscription_payment_failed')
        ) {
          const message =
            b.error === 'subscription_expired'
              ? 'Оплаченный период закончился. Оформите новую подписку, чтобы вернуть доступ к платным моделям.'
              : b.error === 'subscription_renewal_pending'
                ? 'Автопродление этой подписки уже выполняется. Подождите подтверждения платежа.'
                : b.error === 'subscription_payment_pending'
                  ? 'Платёж по этой подписке ещё обрабатывается. Повторный счёт не выставляем.'
                  : 'Платёж по подписке не прошёл. Откройте настройки биллинга для восстановления доступа.';
          trackEvent(PlausibleEvent.checkoutFailed, {
            kind,
            reason: analyticsErrorBucket(String(b.error)),
          });
          setError(message);
          router.refresh();
          return;
        }
        trackEvent(PlausibleEvent.checkoutFailed, {
          kind,
          reason: analyticsErrorBucket(String(b?.error ?? res.status)),
        });
        setError(`Не удалось оформить: ${b?.error ?? res.status}`);
        return;
      }
      const b = (await res.json()) as { confirmationUrl: string };
      trackEvent(PlausibleEvent.checkoutStarted, { kind, tier });
      window.location.href = b.confirmationUrl;
    } catch (err) {
      trackEvent(PlausibleEvent.checkoutFailed, {
        kind,
        reason: analyticsErrorBucket(err instanceof Error ? err.message : 'network'),
      });
      setError(err instanceof Error ? err.message : 'Сетевая ошибка');
    } finally {
      setPendingId(null);
    }
  }

  // Downgrade + cancel-downgrade are free, no-redirect actions: POST, then
  // refresh the server component so the subscription state re-reads.
  async function postBilling(path: string, body: Record<string, unknown>, pendKey: string) {
    setPendingId(pendKey);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(`Не удалось выполнить: ${b?.error ?? res.status}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сетевая ошибка');
    } finally {
      setPendingId(null);
      setConfirmDowngrade(null);
    }
  }

  function onPlateCta(tier: string, cta: PlanCta, title: string) {
    if (cta.action === 'login') {
      window.location.href = '/login?next=/pricing';
    } else if (cta.action === 'subscribe') {
      if (contactEmail) {
        void checkout('/v1/billing/subscribe', 'tier', tier, 'subscription', `sub-${tier}`);
      } else {
        setCheckoutContact({
          path: '/v1/billing/subscribe',
          payloadKey: 'tier',
          itemId: tier,
          kind: 'subscription',
          title,
          priceRub: byTier.get(tier)?.priceRub ?? 0,
        });
      }
    } else if (cta.action === 'upgrade') {
      if (contactEmail) {
        void checkout('/v1/billing/upgrade', 'newTier', tier, 'upgrade', `sub-${tier}`);
      } else {
        setCheckoutContact({
          path: '/v1/billing/upgrade',
          payloadKey: 'newTier',
          itemId: tier,
          kind: 'upgrade',
          title,
          priceRub: byTier.get(tier)?.priceRub ?? 0,
        });
      }
    } else if (cta.action === 'downgrade') {
      // Confirm step before scheduling — downgrade is deferred, not immediate.
      setConfirmDowngrade({ tier, title });
    } else if (cta.action === 'manage') {
      router.push('/settings/billing');
    }
  }

  function onCancelDowngrade() {
    void postBilling('/v1/billing/cancel-downgrade', {}, 'cancel-downgrade');
  }

  // Render order: start, plus, pro, then the studio/max bezel plate.
  const flatTiers = ['start', 'plus', 'pro']
    .map((t) => byTier.get(t))
    .filter(Boolean) as SubscriptionTier[];
  const bezelRow = byTier.get(effectiveBezelTier);
  const planNotice = planBlockNotice(planAccessBlock);

  return (
    <div className="mx-auto max-w-[1240px] px-6 py-2 max-md:px-4">
      {planNotice && (
        <div
          data-testid="plan-access-block"
          className="mt-4 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-4 py-3"
        >
          <p className="font-display text-[13px] font-black uppercase tracking-tight">
            {planNotice.title}
          </p>
          <p className="mt-1.5 text-[13px] text-[color:var(--color-muted-foreground)]">
            {planNotice.body}
          </p>
          <Link
            href="/settings/billing"
            className="mt-2 inline-block font-bold text-[color:var(--color-accent)] underline underline-offset-2"
          >
            Управлять подпиской
          </Link>
        </div>
      )}
      {/* COMPACT HERO */}
      <div className="flex items-end justify-between gap-10 pb-6 pt-8 max-md:flex-col max-md:items-start max-md:gap-4">
        <div>
          <div className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.22em] text-[color:var(--color-accent)] before:h-0.5 before:w-[26px] before:bg-[color:var(--color-accent)] before:content-['']">
            Тарифы
          </div>
          <h1 className="mt-3 font-display text-[32px] font-black uppercase leading-[1.08] tracking-[-0.01em] max-md:text-[24px]">
            Токены на съёмку.
            <br />
            Больше — <span className="text-[color:var(--color-accent)]">дешевле</span>.
          </h1>
          <p className="mt-3 max-w-[44em] text-[15px] leading-[1.5] text-[color:var(--color-muted-foreground)]">
            Один токен — одна валюта на всю линейку: сценарий, генерация, доска, монтаж. Точная цена
            видна до запуска.
          </p>
        </div>
        <div className="flex max-md:flex-wrap">
          {['Точка Банк', 'СБП', 'Карты «Мир»', 'Чек 54-ФЗ'].map((chip) => (
            <span
              key={chip}
              className="whitespace-nowrap border-[2.5px] border-[color:var(--color-line)] px-3 py-[7px] font-mono text-[11px] uppercase tracking-[0.1em] text-[color:var(--color-muted-foreground)] [&:not(:first-child)]:ml-[-2.5px]"
              style={{ background: 'var(--color-surface2)' }}
            >
              {chip}
            </span>
          ))}
        </div>
      </div>

      {betaPaymentMode && (
        <div className="mt-6">
          <BetaPaymentBanner apiUrl={apiUrl} />
        </div>
      )}
      {error && (
        <p className="mt-4 text-[13px] text-destructive">
          {error}{' '}
          {error === PACK_SUBSCRIPTION_REQUIRED_COPY && (
            <a href="#subscription-tiers" className="font-bold underline underline-offset-2">
              Выбрать подписку ↓
            </a>
          )}
        </p>
      )}
      {resumeOrderId && (
        <a
          data-testid="resume-payment-link"
          href={`/billing/return?orderId=${encodeURIComponent(resumeOrderId)}`}
          className="press mt-3 inline-block border-[2.5px] border-[color:var(--color-line)] px-5 py-3 font-mono text-[13px] font-bold uppercase tracking-[0.1em] shadow-[3px_3px_0_0_var(--color-shadow)]"
          style={{ background: ACCENT, color: INK }}
        >
          Продолжить оплату
        </a>
      )}

      {/* MODE TOGGLE — the page only ever shows the subscription plates now;
          «Разовые пакеты» is a trigger that opens the packs modal. */}
      <section className="pt-2" id="subscription-tiers">
        <div className="mb-[26px] flex items-center max-md:flex-wrap">
          <span
            data-testid="mode-subscription"
            className="border-[2.5px] border-[color:var(--color-line)] px-[18px] py-[9px] font-mono text-[11px] font-bold uppercase tracking-[0.12em]"
            style={{ background: 'var(--color-fg)', color: INK }}
          >
            Подписка / мес
          </span>
          <button
            type="button"
            data-testid="mode-packs"
            data-locked={packsUnlocked ? undefined : 'true'}
            disabled={!packsUnlocked}
            onClick={() => packsUnlocked && setPacksModalOpen(true)}
            className={
              'ml-[-2.5px] border-[2.5px] border-[color:var(--color-line)] px-[18px] py-[9px] font-mono text-[11px] uppercase tracking-[0.12em] ' +
              (packsUnlocked ? 'press ' : 'cursor-not-allowed opacity-45 ')
            }
            style={{ background: 'var(--color-bg)', color: 'var(--color-faint)' }}
          >
            Разовые пакеты
          </button>
          <span className="ml-4 self-center text-[13px] text-[color:var(--color-faint)] max-md:hidden">
            {packsUnlocked
              ? 'разовые пакеты — докупка к подписке, токены без срока действия'
              : 'разовые пакеты — докупка для подписчиков, токены без срока действия'}
          </span>
        </div>

        {legacyActive && (
          <div
            data-testid="legacy-notice"
            className="mb-5 flex flex-wrap items-center gap-2 border-[2.5px] border-[color:var(--color-line)] px-4 py-3 text-[13px] text-[color:var(--color-muted-foreground)]"
            style={{ background: 'var(--color-surface2)' }}
          >
            <span
              className="px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.12em]"
              style={{ background: LIME, color: LIME_INK }}
            >
              Текущий тариф
            </span>
            <span>
              {planAccess?.title ?? 'Ваш тариф'} — архивный план. Перейдите на актуальную линейку в
              любой момент, остаток токенов сохранится.
            </span>
          </div>
        )}

        <div
          data-testid="tiers-grid"
          className="grid grid-cols-4 items-stretch gap-3.5 pt-2 max-md:grid-cols-1 max-md:gap-4"
        >
          {flatTiers.map((t) => {
            const content = PLAN_CONTENT[t.tier];
            if (!content) return null;
            const cta = deriveCta({ tier: t.tier, priceRub: t.priceRub }, ctx);
            return (
              <PlateShell
                key={t.tier}
                tier={t.tier}
                name={t.title}
                popular={Boolean(content.popular)}
                priceRub={t.priceRub}
                credits={t.creditsPerCycle}
                content={content}
                cta={cta}
                pending={Boolean(
                  pendingId === `sub-${t.tier}` ||
                    (cta.scheduled && pendingId === 'cancel-downgrade'),
                )}
                onCta={() => onPlateCta(t.tier, cta, t.title)}
                onCancel={onCancelDowngrade}
                scheduledDate={scheduledDate}
                onBuyTokens={cta.status ? () => setPacksModalOpen(true) : undefined}
                bestValue={false}
              />
            );
          })}

          {/* Студия⟷Макс bezel plate */}
          {bezelRow &&
            (() => {
              const content = PLAN_CONTENT[effectiveBezelTier];
              if (!content) return null;
              const cta = deriveCta({ tier: bezelRow.tier, priceRub: bezelRow.priceRub }, ctx);
              const studioRow = byTier.get('studio');
              const maxRow = byTier.get('max');
              return (
                <PlateShell
                  key="bezel"
                  tier={bezelRow.tier}
                  name="Студия"
                  popular={false}
                  bestValue={effectiveBezelTier === BEST_VALUE_TIER}
                  priceRub={bezelRow.priceRub}
                  credits={bezelRow.creditsPerCycle}
                  content={content}
                  cta={cta}
                  pending={Boolean(
                    pendingId === `sub-${bezelRow.tier}` ||
                      (cta.scheduled && pendingId === 'cancel-downgrade'),
                  )}
                  onCta={() => onPlateCta(bezelRow.tier, cta, bezelRow.title)}
                  onCancel={onCancelDowngrade}
                  scheduledDate={scheduledDate}
                  onBuyTokens={cta.status ? () => setPacksModalOpen(true) : undefined}
                  bezel={
                    <div className="mt-3.5">
                      <div
                        data-testid="bezel-track"
                        onPointerDown={(e) => {
                          if (lockedBezel) return;
                          e.currentTarget.setPointerCapture(e.pointerId);
                          const rect = e.currentTarget.getBoundingClientRect();
                          const pct = (e.clientX - rect.left) / rect.width;
                          setBezelTier(pct >= 0.5 ? 'max' : 'studio');
                        }}
                        onPointerMove={(e) => {
                          if (lockedBezel || e.buttons === 0) return;
                          const rect = e.currentTarget.getBoundingClientRect();
                          const pct = (e.clientX - rect.left) / rect.width;
                          setBezelTier(pct >= 0.5 ? 'max' : 'studio');
                        }}
                        className={
                          'relative h-3.5 border-[2.5px] border-[color:var(--color-line)] ' +
                          (lockedBezel ? 'cursor-default' : 'cursor-pointer')
                        }
                        style={{ background: 'var(--color-surface2)' }}
                      >
                        <span
                          className="absolute inset-y-0 left-0"
                          style={{
                            width: effectiveBezelTier === 'max' ? '100%' : '38%',
                            background: ACCENT,
                          }}
                        />
                        <span
                          data-testid="bezel-knob"
                          className="absolute top-[-7px] grid h-6 w-[26px] place-items-center border-[2.5px] border-[color:var(--color-line)] shadow-[3px_3px_0_0_var(--color-accent)]"
                          style={{
                            left: effectiveBezelTier === 'max' ? 'calc(100% - 13px)' : '38%',
                            transform: 'translateX(-13px)',
                            background: 'var(--color-fg)',
                            color: INK,
                          }}
                        >
                          <PixelGlyph name="catalog" size={11} aria-hidden />
                        </span>
                      </div>
                      <div className="mt-2.5 flex items-center justify-between gap-2 font-mono text-[11px] uppercase tracking-[0.1em]">
                        <button
                          type="button"
                          data-testid="bezel-studio"
                          disabled={Boolean(lockedBezel)}
                          onClick={() => !lockedBezel && setBezelTier('studio')}
                          className={
                            effectiveBezelTier === 'studio'
                              ? 'font-bold text-[color:var(--color-fg)]'
                              : 'text-[color:var(--color-faint)]'
                          }
                        >
                          Студия {fmt(studioRow?.creditsPerCycle ?? 15900)}
                        </button>
                        <button
                          type="button"
                          data-testid="bezel-max"
                          disabled={Boolean(lockedBezel)}
                          onClick={() => !lockedBezel && setBezelTier('max')}
                          className="px-1.5 py-0.5 font-bold"
                          style={
                            effectiveBezelTier === 'max'
                              ? { background: LIME, color: LIME_INK }
                              : { color: 'var(--color-faint)' }
                          }
                        >
                          Макс {fmt(maxRow?.creditsPerCycle ?? 32500)}
                        </button>
                      </div>
                      <div className="mt-2 text-[11px] text-[color:var(--color-faint)]">
                        {lockedBezel
                          ? 'Ваш текущий тариф зафиксирован на бегунке.'
                          : effectiveBezelTier === 'max'
                            ? 'Макс — та же Студия на максимальном объёме.'
                            : 'Потяните бегунок вправо — тариф Макс.'}
                      </div>
                    </div>
                  }
                />
              );
            })()}
        </div>
        <div className="mt-6 font-mono text-[11px] uppercase tracking-[0.08em] text-[color:var(--color-faint)]">
          видео — при минимальной длительности клипа (4&nbsp;с) · «Макс» — та же плита Студии,
          бегунок вправо · докупать можно сколько угодно раз · отменить подписку можно в профиле
        </div>
      </section>

      <PacksModal
        open={packsModalOpen}
        onOpenChange={setPacksModalOpen}
        packs={packs}
        pendingId={pendingId}
        onBuy={(id) => {
          // Packs stay locked without an active subscription (arePacksUnlocked)
          // — explain instead of letting the tap hit the 403.
          if (!packsUnlocked) {
            setError(PACK_SUBSCRIPTION_REQUIRED_COPY);
            setPacksModalOpen(false);
            return;
          }
          if (contactEmail) {
            void checkout('/v1/billing/checkout', 'packId', id, 'pack', id);
            return;
          }
          const pack = packs.find((item) => item.id === id);
          if (!pack) return;
          setCheckoutContact({
            path: '/v1/billing/checkout',
            payloadKey: 'packId',
            itemId: id,
            kind: 'pack',
            title: `Пакет ${pack.title}`,
            priceRub: pack.priceRub,
          });
        }}
      />

      {/* Explicit receipt-contact step before Tochka creates the payment link.
          The bank cannot collect this later because 54-ФЗ receipt data is part
          of the create-subscription request. */}
      {checkoutContact && (
        <div
          data-testid="checkout-contact-modal"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'color-mix(in srgb, var(--color-bg) 72%, transparent)' }}
          onClick={() => setCheckoutContact(null)}
        >
          <div
            className="w-full max-w-[440px] border-[2.5px] border-[color:var(--color-line)] p-6 shadow-[7px_7px_0_0_var(--color-accent)]"
            style={{ background: 'var(--color-card)' }}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-faint)]">
              Перед оплатой
            </p>
            <h3 className="mt-2 font-display text-[20px] font-black uppercase leading-[1.1]">
              Тариф «{checkoutContact.title}»
            </h3>
            <p className="mt-3 text-[13px] leading-[1.5] text-[color:var(--color-muted-foreground)]">
              Укажите email — на него придёт электронный чек. Дальше откроется защищённая форма
              Точка Банка для карты или СБП.
            </p>
            {error && <p className="mt-3 text-[13px] text-destructive">{error}</p>}
            <label
              htmlFor="checkout-receipt-email"
              className="mt-5 block text-[13px] font-semibold"
            >
              Email для чека
            </label>
            <input
              id="checkout-receipt-email"
              type="email"
              autoFocus
              value={receiptEmail}
              onChange={(event) => setReceiptEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void checkout(
                    checkoutContact.path,
                    checkoutContact.payloadKey,
                    checkoutContact.itemId,
                    checkoutContact.kind,
                    `sub-${checkoutContact.itemId}`,
                  );
                }
              }}
              placeholder="pochta@example.com"
              autoComplete="email"
              className="mt-2 w-full border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)] px-3 py-3 text-[13px] outline-none focus:border-[color:var(--color-accent)]"
            />
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={() => setCheckoutContact(null)}
                className="press flex-1 border-[2.5px] border-[color:var(--color-line)] py-3 font-mono text-[13px] font-bold uppercase tracking-[0.1em]"
                style={{ background: 'var(--color-surface2)', color: 'var(--color-fg)' }}
              >
                Назад
              </button>
              <button
                type="button"
                disabled={pendingId !== null}
                onClick={() =>
                  void checkout(
                    checkoutContact.path,
                    checkoutContact.payloadKey,
                    checkoutContact.itemId,
                    checkoutContact.kind,
                    `sub-${checkoutContact.itemId}`,
                  )
                }
                className="press flex-1 border-[2.5px] border-[color:var(--color-line)] py-3 font-mono text-[13px] font-bold uppercase tracking-[0.1em] shadow-[3px_3px_0_0_var(--color-shadow)]"
                style={{ background: ACCENT, color: INK }}
              >
                {pendingId ? 'Открываем оплату…' : `Оплатить ${fmt(checkoutContact.priceRub)} ₽`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* COST TABLE */}
      <section className="py-8">
        <div className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.22em] text-[color:var(--color-accent)] before:h-0.5 before:w-[26px] before:bg-[color:var(--color-accent)] before:content-['']">
          Прозрачность
        </div>
        <h2 className="mt-3 font-display text-[32px] font-black uppercase leading-[1.08] max-md:text-[22px]">
          Сколько стоит генерация
        </h2>
        <p className="mt-2.5 max-w-[48em] text-[15px] leading-[1.5] text-[color:var(--color-muted-foreground)]">
          Ориентиры для базовых настроек. Точная цена в токенах показана до запуска — списание без
          сюрпризов.
        </p>
        <div className="mt-[30px] grid grid-cols-2 max-md:grid-cols-1">
          <CostTable title="Видео" unit="за клип · ткн" kind="v" rows={COST_VIDEO} />
          <CostTable title="Фото" unit="за изображение · ткн" kind="i" rows={COST_PHOTO} />
        </div>
      </section>

      {/* PROOF */}
      {proofCards.length > 0 && (
        <section className="py-8">
          <div className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.22em] text-[color:var(--color-accent)] before:h-0.5 before:w-[26px] before:bg-[color:var(--color-accent)] before:content-['']">
            Снято на Вертове
          </div>
          <h2 className="mt-3 font-display text-[32px] font-black uppercase leading-[1.08] max-md:text-[22px]">
            Модели в деле, не в списке
          </h2>
          <p className="mt-2.5 max-w-[48em] text-[15px] leading-[1.5] text-[color:var(--color-muted-foreground)]">
            Каждый кадр — реальная генерация из Витрины, с моделью и ценой в токенах.
          </p>
          <div className="mt-[30px] grid grid-cols-4 max-md:grid-cols-2">
            {proofCards.map((c, i) => (
              <ProofTile key={i} card={c} />
            ))}
          </div>
        </section>
      )}

      {/* FAQ */}
      <section className="py-8">
        <div className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.22em] text-[color:var(--color-accent)] before:h-0.5 before:w-[26px] before:bg-[color:var(--color-accent)] before:content-['']">
          Вопросы
        </div>
        <h2 className="mt-3 font-display text-[32px] font-black uppercase leading-[1.08] max-md:text-[22px]">
          Коротко о главном
        </h2>
        <div className="mt-[30px] grid grid-cols-2 gap-[22px] max-md:grid-cols-1">
          {FAQ.map((f, i) => (
            <div
              key={i}
              className="border-[2.5px] border-[color:var(--color-line)] px-5 py-[17px] shadow-[5px_5px_0_0_var(--color-accent)]"
              style={{ background: 'var(--color-card)' }}
            >
              <b className="block text-[15px]">{f.q}</b>
              <p className="mt-[7px] text-[13px] leading-[1.5] text-[color:var(--color-muted-foreground)]">
                {f.a}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA BAND */}
      <div
        className="mt-[50px] border-y-[2.5px] border-[color:var(--color-line)] py-[52px] text-center"
        style={{ background: 'var(--color-surface2)' }}
      >
        <h2 className="font-display text-[36px] font-black uppercase leading-[1.05] max-md:text-[24px]">
          Первые кадры — <span className="text-[color:var(--color-fg)]">бесплатно</span>
        </h2>
        <div className="mt-3 flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[color:var(--color-muted-foreground)]">
          <TokenStar size={12} style={{ color: ACCENT }} />
          До 400 токенов в подарок · без карты
        </div>
        <a
          href={guest ? '/login?next=/pricing' : '/generate'}
          className="press mt-[26px] inline-block border-[2.5px] border-[color:var(--color-line)] px-9 py-4 font-mono text-[13px] font-bold uppercase tracking-[0.1em] shadow-[7px_7px_0_0_var(--color-shadow)]"
          style={{ background: ACCENT, color: INK }}
        >
          Снять бесплатно →
        </a>
      </div>

      {/* legal footer — only for the lightweight guest shell (AppShell has its own) */}
      {guest && (
        <footer className="flex justify-center gap-6 py-6 font-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-faint)] max-md:flex-wrap">
          <span>Вертов © 2026</span>
          <a href="/legal/offer" className="hover:text-[color:var(--color-fg)]">
            Оферта
          </a>
          <a href="/legal/refund" className="hover:text-[color:var(--color-fg)]">
            Возврат
          </a>
          <a href="/legal/privacy" className="hover:text-[color:var(--color-fg)]">
            152-ФЗ · Конфиденциальность
          </a>
        </footer>
      )}

      {/* Downgrade confirm — scheduled, not immediate; states the terms plainly. */}
      {confirmDowngrade && (
        <div
          data-testid="downgrade-confirm"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'color-mix(in srgb, var(--color-bg) 72%, transparent)' }}
          onClick={() => setConfirmDowngrade(null)}
        >
          <div
            className="w-full max-w-[440px] border-[2.5px] border-[color:var(--color-line)] p-6 shadow-[7px_7px_0_0_var(--color-accent)]"
            style={{ background: 'var(--color-card)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-[20px] font-black uppercase leading-[1.1]">
              Сменить тариф на «{confirmDowngrade.title}»?
            </h3>
            <p className="mt-3 text-[13px] leading-[1.5] text-[color:var(--color-muted-foreground)]">
              Тариф сменится на «{confirmDowngrade.title}»
              {scheduledDate ? ` с ${scheduledDate}` : ' со следующего платёжного периода'} —
              спишется {fmt(byTier.get(confirmDowngrade.tier)?.priceRub ?? 0)}&nbsp;₽/мес,
              автопродление включится. Текущие токены и уровень сохраняются до конца оплаченного
              месяца.
            </p>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                data-testid="downgrade-confirm-cancel"
                onClick={() => setConfirmDowngrade(null)}
                className="press flex-1 border-[2.5px] border-[color:var(--color-line)] py-3 font-mono text-[13px] font-bold uppercase tracking-[0.1em]"
                style={{ background: 'var(--color-surface2)', color: 'var(--color-fg)' }}
              >
                Отмена
              </button>
              <button
                type="button"
                data-testid="downgrade-confirm-submit"
                disabled={pendingId === `down-${confirmDowngrade.tier}`}
                onClick={() =>
                  void postBilling(
                    '/v1/billing/downgrade',
                    { newTier: confirmDowngrade.tier },
                    `down-${confirmDowngrade.tier}`,
                  )
                }
                className="press flex-1 border-[2.5px] border-[color:var(--color-line)] py-3 font-mono text-[13px] font-bold uppercase tracking-[0.1em] shadow-[3px_3px_0_0_var(--color-shadow)]"
                style={{ background: ACCENT, color: INK }}
              >
                {pendingId === `down-${confirmDowngrade.tier}` ? 'Планируем…' : 'Подтвердить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** «Пополнить токены» / «Разовые пакеты» chooser — a compact modal, packs as
 *  list rows (the 5-column in-page grid read as cramped). */
function PacksModal({
  open,
  onOpenChange,
  packs,
  pendingId,
  onBuy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packs: CreditPack[];
  pendingId: string | null;
  onBuy: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="packs-modal"
        className="max-w-[480px] gap-5 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] p-6 shadow-[5px_5px_0_0_var(--color-accent)]"
      >
        <DialogHeader>
          <DialogTitle className="font-display text-[20px] font-black uppercase leading-[1.1]">
            Пополнить токены
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2.5">
          {packs.map((p) => (
            <div
              key={p.id}
              data-testid="pack-row"
              data-pack-id={p.id}
              className="flex items-center gap-3 border-[2.5px] border-[color:var(--color-line)] px-4 py-3"
              style={{ background: 'var(--color-surface2)' }}
            >
              <span className="w-9 shrink-0 font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-muted-foreground)]">
                {p.title}
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[13px] font-bold">
                <TokenStar size={12} style={{ color: ACCENT }} />
                {fmt(p.credits)}
              </span>
              <span className="ml-auto whitespace-nowrap font-display text-[16px] font-black">
                {fmt(p.priceRub)}&nbsp;₽
              </span>
              <button
                type="button"
                data-testid="buy-button"
                disabled={pendingId !== null}
                onClick={() => onBuy(p.id)}
                className="press shrink-0 border-[2.5px] border-[color:var(--color-line)] px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] shadow-[3px_3px_0_0_var(--color-accent)]"
                style={{ background: 'var(--color-fg)', color: INK }}
              >
                {pendingId === p.id ? 'Ждите…' : 'Купить'}
              </button>
            </div>
          ))}
        </div>
        <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
          Токены из пакетов не сгорают.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function ProofTile({ card }: { card: ProofCard }) {
  const poster = assetSrc(card.previewUrl.replace(/\.mp4$/, '.png'));
  return (
    <div
      className="relative aspect-[4/3] overflow-hidden border-[2.5px] border-[color:var(--color-line)] [&:not(:first-child)]:ml-[-2.5px] max-md:[&:not(:first-child)]:ml-0"
      style={{ background: 'var(--color-card)' }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={poster} alt={card.model} loading="lazy" className="h-full w-full object-cover" />
      <div className="absolute bottom-0 left-0 flex">
        <b
          className="px-2.5 py-[5px] font-mono text-[11px] font-bold uppercase tracking-[0.08em]"
          style={{ background: 'var(--color-fg)', color: INK }}
        >
          {card.model}
        </b>
        <i
          className="flex items-center gap-1.5 px-2.5 py-[5px] font-mono text-[11px] font-bold not-italic"
          style={{ background: ACCENT, color: INK }}
        >
          <TokenStar size={10} />
          {card.tokens}
        </i>
      </div>
    </div>
  );
}
