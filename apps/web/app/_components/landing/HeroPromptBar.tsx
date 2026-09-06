'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from '@/components/ui/icons';
import { modelDisplayName } from '@/lib/models';
import { trackEvent, PlausibleEvent } from '../PlausibleEvents';

/** Active video model rows for the kinobar's model dropdown (fetched
 *  server-side from the public /v1/models in Landing.tsx). `durations` is the
 *  model's own «Сек» option space (capability-declared or Seedance fallback). */
export interface LandingModel {
  id: string;
  family: string;
  variant: string;
  displayName?: string | null;
  durations: number[];
}

/** Two-storey «кинобар» — the hero's primary CTA (owner-approved mock
 *  mockups/kinobar.html, 2026-07-06). Top storey: a two-line prompt field
 *  where the invitation hint types itself once on open behind a lime block
 *  caret pinned BEFORE the text (it's a hint, not someone's input). Bottom
 *  storey: model / seconds / takes dropdowns (all opening DOWNWARD, uniform
 *  style, model value in lime) + «Снять» flush right.
 *
 *  Empty submit → /login (same as the old CTA). Typed submit →
 *  /generate?prompt=…&model=…&sec=…&n=… — /generate is anon-browsable
 *  (middleware no longer bounces; AnonBootstrap mints a guest session), so the
 *  visitor lands straight on the prefilled generate page and only meets the
 *  signup wall at the actual «Снять» click (guest-CJM, 2026-07-09). */

const HINT = 'Опиши сцену — камера уже включена';
const FALLBACK_SECS = [5, 10];
const COUNTS = [1, 2, 4] as const;

const ddButton =
  'flex h-full items-center gap-2 border-r-[2.5px] border-[color:var(--color-line)] px-3.5 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface2)] md:px-4';
const ddMenu =
  'absolute -left-[2.5px] top-[calc(100%+12px)] z-20 min-w-full border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)] shadow-[7px_7px_0_0_var(--color-primary-foreground)]';
// The selected row keeps its OWN hover (stays periwinkle) — two hover:bg-*
// utilities on one element resolve by stylesheet order, not className order,
// which is exactly the black-on-black hover bug this split fixes.
const ddRowBase =
  'flex w-full items-center justify-between gap-4 whitespace-nowrap border-b-[1.5px] border-[color:var(--color-line-soft)] px-3.5 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-[0.1em] last:border-b-0';
const ddRow = `${ddRowBase} text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface2)]`;
const ddRowActive = `${ddRowBase} bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]`;

/** Nearest allowed duration when the model changes (tie → the shorter one). */
function snapSec(sec: number, allowed: number[]): number {
  if (allowed.length === 0) return sec;
  return allowed.reduce((best, d) => (Math.abs(d - sec) < Math.abs(best - sec) ? d : best));
}

function DropdownIcon() {
  return (
    <ChevronDown size={12} className="text-[color:var(--color-muted-foreground)]" aria-hidden />
  );
}

function modelLabel(m: LandingModel): string {
  return modelDisplayName(m);
}

export function HeroPromptBar({ models }: { models: LandingModel[] }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  // Which dropdown is open — one at a time; any outside click closes it.
  const [open, setOpen] = useState<'model' | 'sec' | 'n' | null>(null);
  const [modelId, setModelId] = useState<string>(
    () => (models.find((m) => m.id === 'seedance-2-0-fast') ?? models[0])?.id ?? '',
  );
  const [sec, setSec] = useState<number>(() => {
    const first = models.find((m) => m.id === 'seedance-2-0-fast') ?? models[0];
    return snapSec(5, first?.durations ?? FALLBACK_SECS);
  });
  const [n, setN] = useState<(typeof COUNTS)[number]>(1);
  // The hint types itself once on open (skipped under prefers-reduced-motion).
  const [hintLen, setHintLen] = useState(0);
  const rootRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setHintLen(HINT.length);
      return;
    }
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setHintLen(i);
      if (i >= HINT.length) clearInterval(t);
    }, 45);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(null);
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const model = models.find((m) => m.id === modelId) ?? null;
  const secOptions = model?.durations?.length ? model.durations : FALLBACK_SECS;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = value.trim();
    trackEvent(PlausibleEvent.landingCta, { cta: 'kinobar' });
    if (!q) {
      router.push('/login');
      return;
    }
    const qs = new URLSearchParams({ prompt: q, sec: String(sec), n: String(n) });
    if (modelId) qs.set('model', modelId);
    router.push(`/generate?${qs}`);
  }

  return (
    <form
      ref={rootRef}
      onSubmit={submit}
      data-testid="hero-prompt-form"
      className="relative mt-9 w-full max-w-[720px]"
    >
      {/* ink offset-shadow: the bar sits on the hero sky's violet glow zone,
          where a lime (or periwinkle) shadow fights the backdrop — dark ink
          reads on both the night-sky top and the periwinkle bottom. */}
      <div className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)] text-left shadow-[9px_9px_0_0_var(--color-primary-foreground)]">
        <div className="relative">
          <textarea
            rows={2}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            data-testid="hero-prompt-input"
            aria-label="Опиши сцену"
            autoComplete="off"
            spellCheck={false}
            className="block min-h-[84px] w-full resize-none bg-transparent px-4 pt-4 font-mono text-[13px] font-medium text-[color:var(--color-fg)] outline-none md:px-5 md:pt-5"
            style={{ caretColor: value ? 'var(--color-accent)' : 'transparent' }}
          />
          {value === '' && (
            // Bounded on BOTH sides so the nowrap ghost text can never grow its
            // own box past the field (mobile scrollWidth guard). Lime block
            // caret sits BEFORE the hint — it's an invitation, not input.
            <span
              aria-hidden
              className="pointer-events-none absolute left-4 right-2 top-4 flex items-center overflow-hidden whitespace-nowrap font-mono text-[13px] font-medium text-[color:var(--color-muted-foreground)] md:left-5 md:top-5"
            >
              <span className="seed-caret mr-[3px] shrink-0 text-[color:var(--color-accent2)]">
                ▮
              </span>
              <span className="truncate">{HINT.slice(0, hintLen)}</span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-stretch border-t-[2.5px] border-[color:var(--color-line)]">
          {models.length > 0 && (
            <div className="relative">
              <button
                type="button"
                data-testid="hero-model-dd"
                aria-expanded={open === 'model'}
                onClick={() => setOpen(open === 'model' ? null : 'model')}
                className={ddButton}
              >
                <span className="text-[color:var(--color-fg)]">
                  {model ? modelLabel(model) : 'Модель'}
                </span>
                <DropdownIcon />
              </button>
              {open === 'model' && (
                <div className={`${ddMenu} min-w-[240px]`}>
                  {models.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setModelId(m.id);
                        setSec((s) => snapSec(s, m.durations));
                        setOpen(null);
                      }}
                      className={m.id === modelId ? ddRowActive : ddRow}
                    >
                      {modelLabel(m)}
                      {m.id === modelId && <Check size={12} aria-hidden />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="relative">
            <button
              type="button"
              aria-expanded={open === 'sec'}
              onClick={() => setOpen(open === 'sec' ? null : 'sec')}
              className={ddButton}
            >
              <span className="text-[11px] text-[color:var(--color-muted-foreground)]">Сек</span>
              {sec}
              <DropdownIcon />
            </button>
            {open === 'sec' && (
              <div className={ddMenu}>
                {secOptions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setSec(s);
                      setOpen(null);
                    }}
                    className={s === sec ? ddRowActive : ddRow}
                  >
                    {s}
                    {s === sec && <Check size={12} aria-hidden />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              type="button"
              aria-expanded={open === 'n'}
              onClick={() => setOpen(open === 'n' ? null : 'n')}
              className={ddButton}
            >
              <span className="text-[11px] text-[color:var(--color-muted-foreground)]">Шт</span>×{n}
              <DropdownIcon />
            </button>
            {open === 'n' && (
              <div className={ddMenu}>
                {COUNTS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      setN(c);
                      setOpen(null);
                    }}
                    className={c === n ? ddRowActive : ddRow}
                  >
                    ×{c}
                    {c === n && <Check size={12} aria-hidden />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="min-w-0 flex-1" />
          <button
            type="submit"
            data-testid="hero-prompt-submit"
            className="shrink-0 basis-full border-t-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-7 py-3.5 font-display text-[13px] font-black uppercase text-[color:var(--color-primary-foreground)] transition-transform duration-75 ease-out active:translate-y-[2px] sm:basis-auto sm:border-l-[2.5px] sm:border-t-0"
          >
            Снять
          </button>
        </div>
      </div>
      <p className="mt-3 text-center font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-muted-foreground)]">
        Попробуй бесплатно
      </p>
    </form>
  );
}
