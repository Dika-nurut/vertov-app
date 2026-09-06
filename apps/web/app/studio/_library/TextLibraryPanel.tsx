// Library text panel — template gallery (extracted from StudioClient.tsx,
// split 5f/N). AI voice generation is disabled; manual voiceover upload stays
// available in the Audio panel.
import { TEXT_TEMPLATES } from '../_model';
import type { TClip, TText } from '../_model';

export function TextLibraryPanel({
  addText,
  timeline,
}: {
  addText: (opts?: {
    text?: string;
    position?: TText['position'];
    font?: TText['font'];
    sizeFrac?: number;
    fade?: boolean;
  }) => void;
  timeline: TClip[];
}) {
  return (
    <section data-testid="lib-text" className="space-y-2">
      <p className="label-eyebrow mb-3">Шаблоны текста</p>
      {/* §3.5 text-template gallery — 2-col styled preset tiles; one click
                  drops a pre-styled text clip (position/font/size/fade all render). */}
      <div className="grid grid-cols-2 gap-2">
        {TEXT_TEMPLATES.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            data-testid={`text-template-${tpl.id}`}
            title={tpl.label}
            onClick={() =>
              addText({
                text: tpl.sample,
                position: tpl.position,
                font: tpl.font,
                sizeFrac: tpl.sizeFrac,
                fade: tpl.fade,
              })
            }
            disabled={timeline.length === 0}
            className="press-inset group relative grid aspect-video place-items-center overflow-hidden rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-2 ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:ring-[color:var(--color-accent)] disabled:opacity-40"
          >
            <span
              className={
                'pointer-events-none truncate font-bold leading-tight text-white [text-shadow:0_1px_6px_rgba(0,0,0,0.7)] ' +
                (tpl.font === 'serif' ? 'font-display' : '')
              }
              style={{
                fontSize: `clamp(9px, ${(tpl.sizeFrac * 150).toFixed(0)}%, 18px)`,
              }}
            >
              {tpl.sample}
            </span>
            <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-center text-[11px] font-medium text-white/75">
              {tpl.label}
            </span>
          </button>
        ))}
      </div>
      <p className="pt-1 text-[11px] leading-relaxed text-[color:var(--color-faint)]">
        Титры живут на дорожке «Текст» — правьте текст/стиль/время в инспекторе.
      </p>
    </section>
  );
}
