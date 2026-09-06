'use client';

import { Faders, MagicWand, PencilSimple } from '@phosphor-icons/react/dist/ssr';

/**
 * Preview empty-state — "Создай за три шага" (01·02·03).
 *
 * Shown in the /generate preview panel when the user has NO generations yet.
 * Three equal-height vertical "Плиты": a big number sticker up top (periwinkle
 * for 01/02, the single lime spark on 03), then a Phosphor BOLD glyph + display
 * title + one-line mono hint anchored to the BOTTOM. Equal heights + single-line
 * hints keep the three titles on one baseline.
 */
export function GenerateSteps({ kind = 'image' }: { kind?: 'image' | 'video' }) {
  const isVideo = kind === 'video';
  const steps = [
    {
      n: '01',
      Icon: PencilSimple,
      title: 'Опиши',
      hint: isVideo ? 'Сцену и движение' : 'Словами, как угодно',
      lime: false,
    },
    {
      n: '02',
      Icon: Faders,
      title: 'Настрой',
      hint: isVideo ? 'Модель и формат' : 'Модель и размер',
      lime: false,
    },
    {
      n: '03',
      Icon: MagicWand,
      title: 'Создай',
      hint: 'Жми «Создать»',
      lime: true,
    },
  ];

  return (
    <div className="flex h-full w-full flex-col gap-6 px-5 py-7 sm:px-8 sm:py-8">
      <div className="shrink-0">
        <p className="label-eyebrow mb-2.5">Генерация · Vertov</p>
        <h2 className="font-display text-[clamp(22px,3vw,32px)] font-black uppercase leading-[1.04] tracking-[-0.01em] text-[color:var(--color-fg)]">
          Создай за три шага
        </h2>
        <p className="mt-1.5 text-[13px] text-[color:var(--color-faint)]">
          {isVideo
            ? 'Слева — управление. Здесь появится твоё видео.'
            : 'Слева — управление. Здесь появятся твои генерации.'}
        </p>
      </div>

      {/* Equal-height cards + top-anchored content = aligned titles. */}
      <ol className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
        {steps.map((s) => (
          <li
            key={s.n}
            className="flex flex-col rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-5 shadow-[5px_5px_0_0_var(--color-shadow)]"
          >
            <span
              className="tnum grid h-14 w-14 shrink-0 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] font-display text-[24px] font-black shadow-[3px_3px_0_0_var(--color-shadow)]"
              style={{
                background: s.lime ? 'var(--color-accent2)' : 'var(--color-accent)',
                color: s.lime
                  ? 'var(--color-accent2-foreground)'
                  : 'var(--color-primary-foreground)',
              }}
            >
              {s.n}
            </span>
            <div className="mt-auto pt-6">
              <s.Icon
                size={30}
                weight="bold"
                className="mb-3 text-[color:var(--color-fg)]"
                aria-hidden
              />
              <h3 className="font-display text-[18px] font-black uppercase leading-tight tracking-[-0.01em] text-[color:var(--color-fg)]">
                {s.title}
              </h3>
              <p className="mt-1.5 truncate font-mono text-[13px] leading-snug text-[color:var(--color-faint)]">
                {s.hint}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
