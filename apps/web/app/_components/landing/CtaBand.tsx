'use client';

import Link from 'next/link';
import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { trackEvent, PlausibleEvent } from '../PlausibleEvents';
import { GIFT_TOKENS_UPFRONT } from '@/lib/gift-tokens';

/** Final CTA band: one claim, one button. The headline stays bone — the page's
 *  one lime spark lives on the Витрина «новое» badge. */
export function CtaBand() {
  return (
    <section className="px-6 py-16 text-center md:py-24">
      <h2 className="mx-auto max-w-[720px] font-display text-[clamp(26px,4vw,48px)] font-black uppercase leading-[0.95] tracking-[-0.02em] text-[color:var(--color-fg)]">
        Твой первый кадр — бесплатно.
      </h2>
      <p className="mt-3 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-muted-foreground)]">
        {GIFT_TOKENS_UPFRONT} токенов в подарок · без карты
      </p>
      <div className="mt-7 flex justify-center">
        <Link
          href="/login"
          onClick={() => trackEvent(PlausibleEvent.landingCta, { cta: 'cta_band' })}
          className="inline-flex items-center gap-2.5 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] py-3 pl-6 pr-3 font-display text-[16px] font-black text-[color:var(--color-primary-foreground)] shadow-[5px_5px_0_0_var(--color-accent)] transition-transform duration-75 ease-out hover:-translate-x-px hover:-translate-y-px active:translate-x-[3px] active:translate-y-[3px] active:shadow-[2px_2px_0_0_var(--color-accent)]"
        >
          <span>Снять бесплатно</span>
          <span className="flex h-[30px] w-[30px] items-center justify-center border-[2.5px] border-[color:var(--color-primary-foreground)] bg-[color:var(--color-bg)] text-[color:var(--color-fg)]">
            <ArrowRight size={16} weight="bold" aria-hidden />
          </span>
        </Link>
      </div>
    </section>
  );
}
