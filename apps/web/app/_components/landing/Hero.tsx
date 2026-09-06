import { HeadlineCycle } from './HeadlineCycle';
import { HeroPromptBar, type LandingModel } from './HeroPromptBar';
import { HeroSky } from './HeroSky';

/** Hero (v20, 2026-07-06 — «кинобар» workstream, owner-approved mock
 *  mockups/kinobar.html): eyebrow dropped; sub rewritten as two controlled
 *  lines; prompt bar is now the two-storey kinobar (field + model/sec/count
 *  controls). Word-swap stays the hero's ONE looping foreground animation.
 *
 *  H1 sizing: one UNIFORM font-size for the whole heading that never changes
 *  between cycle words (owner: no per-word resizing). The min() cap sizes the
 *  heading so the longest cycle word («Смонтировано.» — 11.7× its font-size in
 *  Unbounded Black at -0.03em, measured against the real page 2026-07-03) fits
 *  inside (100vw − 55px). Only binds on narrow screens (~28px at 375px);
 *  desktop stays at the full clamp. */
export function Hero({ models }: { models: LandingModel[] }) {
  return (
    <section className="relative flex min-h-[100svh] flex-col justify-center px-6 py-14 md:px-11">
      <HeroSky />
      <div className="relative z-[1] mx-auto flex w-full max-w-[980px] flex-col items-center text-center">
        <h1
          className="font-display font-black uppercase leading-[0.9] tracking-[-0.03em] text-[color:var(--color-fg)]"
          style={{ fontSize: 'min(clamp(44px, 6.4vw, 78px), calc((100vw - 55px) / 11.7))' }}
        >
          Скажи.
          <br />
          <HeadlineCycle />
        </h1>
        <p className="mt-5 max-w-[640px] text-[15px] font-medium leading-relaxed text-[color:var(--color-muted-foreground)] md:text-[16px]">
          Фильм начинается с одной фразы.{' '}
          <b className="block font-bold text-[color:var(--color-fg)]">
            Скажи её — кадры, монтаж и озвучка соберутся сами.
          </b>
        </p>

        <HeroPromptBar models={models} />
      </div>
    </section>
  );
}
