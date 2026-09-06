// Unified text/title inspector — III.1 (G1). Like the overlay, a text element now
// gets the rail + drill-in shell instead of one flat panel: a Пресеты template
// gallery and an Основное tab with the drawtext-renderable fields. CapCut's text
// tabs also include TTS / AI-avatars / motion-tracking — GPU/generation features
// out of our MVP scope, so we expose only what the worker's drawtext honours
// (text · timing · position · font · size · fade), keeping preview == export.
import type React from 'react';
import { Trash2 } from '../_icons';
import { Row, Seg, Toggle, TripleInput, rangePct } from '../_kit/controls';
import { BG_SWATCHES, TEXT_DEFAULT_FRAC, TEXT_TEMPLATES } from '../_model';
import type { InspectorTab, TText, TextTemplate } from '../_model';

export function TextInspector({
  text,
  removeText,
  patchText,
  totalDur,
  inspTab,
}: {
  text: TText;
  removeText: (uid: string) => void;
  patchText: (uid: string, patch: Partial<TText>) => void;
  totalDur: number;
  inspTab: InspectorTab;
}) {
  return (
    <div className="glass space-y-4 rounded-[var(--radius-md)] p-4" data-testid="text-inspector">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-[color:var(--color-fg)]">Титр</span>
        <button
          type="button"
          title="Удалить титр (Del)"
          data-testid="text-delete"
          onClick={() => removeText(text.uid)}
          className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-faint)] press-inset hover:bg-[color:var(--color-surface2)] hover:text-destructive"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <p className="label-eyebrow" data-testid="insp-section">
        {inspTab === 'presets' ? 'Пресеты' : 'Основное'}
      </p>

      {inspTab === 'presets' ? (
        <TextPresets text={text} patchText={patchText} />
      ) : (
        <TextBasic text={text} patchText={patchText} totalDur={totalDur} />
      )}
    </div>
  );
}

/** Style-template gallery — each tile re-styles the current title (keeps its text)
 *  via fields the worker's drawtext already renders, so a preset is preview==export
 *  free. Mirrors the clip animation gallery's "preset = sugar over real fields". */
function TextPresets({
  text,
  patchText,
}: {
  text: TText;
  patchText: (uid: string, patch: Partial<TText>) => void;
}) {
  const apply = (t: TextTemplate) =>
    patchText(text.uid, {
      position: t.position,
      font: t.font,
      sizeFrac: t.sizeFrac,
      fade: t.fade,
      plate: t.plate,
    });
  const active = (t: TextTemplate) =>
    text.position === t.position &&
    text.font === t.font &&
    Math.abs((text.sizeFrac ?? TEXT_DEFAULT_FRAC) - t.sizeFrac) < 0.001;
  return (
    <div className="space-y-3" data-testid="insp-pane-presets">
      <div className="grid grid-cols-2 gap-2">
        {TEXT_TEMPLATES.map((t) => {
          const on = active(t);
          return (
            <button
              key={t.id}
              type="button"
              data-testid={`text-preset-${t.id}`}
              aria-pressed={on}
              onClick={() => apply(t)}
              className={
                'press-inset overflow-hidden rounded-[var(--radius-sm)] ring-1 ring-inset transition-shadow ' +
                (on
                  ? 'ring-2 ring-[color:var(--color-accent)]'
                  : 'ring-[color:var(--color-line)]/15 hover:ring-[color:var(--color-line)]/40')
              }
            >
              <span className="studio-swatch grid h-12 w-full place-items-center px-1">
                <span className="truncate text-[13px] font-semibold text-white/90">{t.sample}</span>
              </span>
              <span className="block py-1 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
                {t.label}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-relaxed text-[color:var(--color-faint)]">
        Пресет меняет стиль титра (положение · шрифт · размер · появление), сам текст остаётся. Всё
        впечатывается в экспорт.
      </p>
    </div>
  );
}

/** Основное — the drawtext fields (extracted from the old flat TextPanel). */
function TextBasic({
  text,
  patchText,
  totalDur,
}: {
  text: TText;
  patchText: (uid: string, patch: Partial<TText>) => void;
  totalDur: number;
}) {
  return (
    <div className="space-y-4" data-testid="insp-pane-main">
      <Row label="Текст">
        <input
          type="text"
          maxLength={200}
          value={text.text}
          data-testid="text-input"
          onChange={(e) => patchText(text.uid, { text: e.target.value })}
          className="h-10 w-full rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 text-[13px] text-[color:var(--color-fg)] outline-none ring-1 ring-inset ring-[color:var(--color-line)]/15 focus:border-[color:var(--color-accent)] focus:shadow-[3px_3px_0_0_var(--color-shadow)]"
        />
      </Row>
      <Row label={`Показ с ${text.fromSec.toFixed(1)}с`}>
        <input
          type="range"
          min={0}
          max={Math.max(totalDur, 1)}
          step={0.1}
          value={text.fromSec}
          onChange={(e) =>
            patchText(text.uid, {
              fromSec: Math.min(Number(e.target.value), text.toSec - 0.2),
            })
          }
          style={
            { ['--pct']: rangePct(text.fromSec, 0, Math.max(totalDur, 1)) } as React.CSSProperties
          }
          className="seed-range w-full"
        />
      </Row>
      <Row label={`до ${text.toSec.toFixed(1)}с`}>
        <input
          type="range"
          min={0}
          max={Math.max(totalDur, 1)}
          step={0.1}
          value={text.toSec}
          onChange={(e) =>
            patchText(text.uid, {
              toSec: Math.max(Number(e.target.value), text.fromSec + 0.2),
            })
          }
          style={
            { ['--pct']: rangePct(text.toSec, 0, Math.max(totalDur, 1)) } as React.CSSProperties
          }
          className="seed-range w-full"
        />
      </Row>
      <Row label="Положение">
        <Seg
          value={text.position}
          onChange={(v) => patchText(text.uid, { position: v })}
          options={[
            { id: 'top', label: 'Верх' },
            { id: 'center', label: 'Центр' },
            { id: 'bottom', label: 'Низ' },
          ]}
        />
      </Row>
      <Row label="Шрифт">
        <Seg
          cols={2}
          value={text.font}
          onChange={(v) => patchText(text.uid, { font: v })}
          options={[
            { id: 'sans', label: 'Гротеск' },
            { id: 'display', label: 'Заголовок' },
            { id: 'serif', label: 'Антиква' },
            { id: 'mono', label: 'Моно' },
          ]}
        />
      </Row>
      {/* Size = sizeFrac × output height (mirrors drawtext); shown as % of frame height. */}
      <TripleInput
        label="Размер"
        testid="insp-text-size"
        value={Math.round((text.sizeFrac ?? TEXT_DEFAULT_FRAC) * 100)}
        min={3}
        max={20}
        step={1}
        def={Math.round(TEXT_DEFAULT_FRAC * 100)}
        unit="%"
        onChange={(v) => patchText(text.uid, { sizeFrac: v / 100 })}
      />
      <Toggle
        label="Плавное появление"
        on={text.fade}
        onToggle={() => patchText(text.uid, { fade: !text.fade })}
      />
      <Toggle
        label="Плашка"
        on={!!text.plate}
        onToggle={() =>
          patchText(text.uid, { plate: text.plate ? undefined : { color: '#101014' } })
        }
      />
      {text.plate && (
        <div className="grid grid-cols-6 gap-2" data-testid="text-plate-swatches">
          {BG_SWATCHES.map((c) => {
            const on = text.plate!.color.toLowerCase() === c.toLowerCase();
            return (
              <button
                key={c}
                type="button"
                data-testid={`text-plate-${c.slice(1)}`}
                aria-pressed={on}
                title={c}
                onClick={() => patchText(text.uid, { plate: { color: c } })}
                className={
                  'h-8 rounded-[var(--radius-sm)] ring-inset transition-shadow ' +
                  (on
                    ? 'ring-2 ring-[color:var(--color-accent)]'
                    : 'ring-1 ring-[color:var(--color-line)]/15 hover:ring-[color:var(--color-line)]/40')
                }
                style={{ backgroundColor: c }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
