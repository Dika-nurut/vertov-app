'use client';

import { useState } from 'react';
import { Check, Loader2, Pencil } from '@/components/ui/icons';
import type { ScenarioBriefV1, ScenarioFormat, ScenarioOutlineV1 } from '@seed/shared';

const FORMAT_LABEL: Record<ScenarioFormat, string> = {
  film: 'Фильм',
  social: 'Соцвидео',
  ad: 'Реклама',
  sketch: 'Скетч',
};

const FORMAT_OPTIONS: Array<[ScenarioFormat, string]> = [
  ['film', 'Фильм'],
  ['social', 'Соцвидео'],
  ['ad', 'Реклама'],
  ['sketch', 'Скетч'],
];

type BriefTextField = 'goal' | 'audience' | 'platform' | 'tone' | 'cta';

function briefText(brief: ScenarioBriefV1, field: BriefTextField): string {
  return brief[field] ?? '';
}

export function ScenarioStructurePanel({
  initialFormat,
  initialBrief,
  initialOutline,
  onSave,
}: {
  initialFormat: ScenarioFormat;
  initialBrief: ScenarioBriefV1;
  initialOutline: ScenarioOutlineV1;
  onSave: (value: {
    format: ScenarioFormat;
    brief: ScenarioBriefV1;
    outline: ScenarioOutlineV1;
  }) => Promise<boolean>;
}) {
  const [format, setFormat] = useState(initialFormat);
  const [brief, setBrief] = useState(initialBrief);
  const [outline] = useState(initialOutline);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  function setTextField(field: BriefTextField, value: string): void {
    setBrief((current) => {
      const next = { ...current };
      if (value.trim()) next[field] = value;
      else delete next[field];
      return next;
    });
  }

  function setDuration(value: string): void {
    setBrief((current) => {
      const next = { ...current };
      const seconds = Number(value);
      if (value.trim() && Number.isInteger(seconds) && seconds > 0) {
        next.durationSeconds = seconds;
      } else {
        delete next.durationSeconds;
      }
      return next;
    });
  }

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(false);
    const ok = await onSave({ format, brief, outline });
    setSaving(false);
    if (ok) setEditing(false);
    else setSaveError(true);
  }

  const rows = (
    [
      ['Цель', brief.goal ?? ''],
      ['Аудитория', brief.audience ?? ''],
      ['Площадка', brief.platform ?? ''],
      ['Тон', brief.tone ?? ''],
      ['CTA', brief.cta ?? ''],
    ] as Array<[string, string]>
  ).filter(([, value]) => value.trim());

  return (
    <section
      className="shrink-0 border-b-[2px] border-[color:var(--color-paper-ink)]/25 bg-[color:var(--color-paper)] px-4 py-4 sm:px-7"
      data-testid="scenario-structure-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="bg-[color:var(--color-accent2)] px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em]">
              Предположение Вертова
            </span>
            <span className="text-[11px] text-[color:var(--color-paper-ink)]/50">
              черновик брифа — поправьте, если не так
            </span>
          </div>
          <p className="mt-3 font-mono text-[11px] font-bold uppercase tracking-[0.06em]">
            {FORMAT_LABEL[format]}
            {brief.durationSeconds ? ` · ${brief.durationSeconds} сек` : ''}
            {brief.platform ? ` · ${brief.platform}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing((value) => !value)}
          className="inline-flex items-center gap-1.5 border-[2px] border-[color:var(--color-paper-ink)]/35 px-2.5 py-1.5 text-[11px] font-semibold text-[color:var(--color-paper-ink)]/65"
          data-testid="scenario-structure-edit"
        >
          <Pencil size={12} /> {editing ? 'Закрыть' : 'Поправить'}
        </button>
      </div>

      {editing ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2" data-testid="scenario-structure-form">
          <label className="text-[11px] font-semibold">
            Формат
            <select
              value={format}
              onChange={(event) => setFormat(event.target.value as ScenarioFormat)}
              className="mt-1 h-9 w-full border-[2px] border-[color:var(--color-paper-ink)]/35 bg-white px-2 text-[13px] outline-none"
              data-testid="scenario-structure-format"
            >
              {FORMAT_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] font-semibold">
            Длительность, секунд
            <input
              type="number"
              min={1}
              max={7200}
              value={brief.durationSeconds ?? ''}
              onChange={(event) => setDuration(event.target.value)}
              className="mt-1 h-9 w-full border-[2px] border-[color:var(--color-paper-ink)]/35 bg-white px-2 text-[13px] outline-none"
              data-testid="scenario-structure-duration"
            />
          </label>
          {(
            [
              ['goal', 'Цель'],
              ['audience', 'Аудитория'],
              ['platform', 'Площадка'],
              ['tone', 'Тон'],
              ['cta', 'CTA'],
            ] as Array<[BriefTextField, string]>
          ).map(([field, label]) => (
            <label key={field} className="text-[11px] font-semibold sm:col-span-2">
              {label}
              <input
                value={briefText(brief, field)}
                onChange={(event) => setTextField(field, event.target.value)}
                className="mt-1 h-9 w-full border-[2px] border-[color:var(--color-paper-ink)]/35 bg-white px-2 text-[13px] outline-none"
                data-testid={`scenario-structure-${field}`}
              />
            </label>
          ))}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex items-center gap-1.5 border-[2px] border-[color:var(--color-paper-ink)] bg-[color:var(--color-paper-ink)] px-3 py-2 text-[13px] font-bold text-[color:var(--color-paper)] disabled:opacity-50"
              data-testid="scenario-structure-save"
            >
              {saving ? <Loader2 size={13} className="seed-spin" /> : <Check size={13} />}
              Сохранить бриф
            </button>
            {saveError && (
              <span className="text-[11px] text-[color:var(--color-destructive)]">
                Не удалось сохранить — обновите проект и повторите.
              </span>
            )}
          </div>
        </div>
      ) : (
        rows.length > 0 && (
          <dl className="mt-3 grid gap-x-5 gap-y-1 text-[13px] leading-relaxed text-[color:var(--color-paper-ink)]/70 sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt className="inline font-semibold text-[color:var(--color-paper-ink)]">
                  {label}:
                </dt>{' '}
                <dd className="inline">{value}</dd>
              </div>
            ))}
          </dl>
        )
      )}

      <div className="mt-5">
        <p className="mb-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-paper-ink)]/50">
          Структура · {outline.beats.length} {outline.beats.length === 1 ? 'бит' : 'битов'}
        </p>
        <ol className="space-y-0" data-testid="scenario-structure-beats">
          {outline.beats.map((beat, index) => (
            <li
              key={beat.id}
              className="flex gap-2.5 border-[2px] border-[color:var(--color-paper-ink)] bg-white px-3 py-2.5 [&+li]:-mt-[2px]"
              data-testid="scenario-structure-beat"
            >
              <span className="w-5 shrink-0 pt-0.5 font-mono text-[11px] text-[color:var(--color-paper-ink)]/45">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block font-mono text-[11px] uppercase tracking-[0.06em]">
                  {beat.title}
                </strong>
                <span className="mt-1 block text-[13px] leading-relaxed text-[color:var(--color-paper-ink)]/70">
                  {beat.summary || 'Без дополнительного описания.'}
                </span>
                {(beat.visual || beat.spokenText || beat.onScreenText) && (
                  <span className="mt-2 block space-y-0.5 text-[11px] leading-relaxed text-[color:var(--color-paper-ink)]/55">
                    {beat.visual && (
                      <span className="block">
                        <b>Визуал:</b> {beat.visual}
                      </span>
                    )}
                    {beat.spokenText && (
                      <span className="block">
                        <b>Реплика:</b> {beat.spokenText}
                      </span>
                    )}
                    {beat.onScreenText && (
                      <span className="block">
                        <b>На экране:</b> {beat.onScreenText}
                      </span>
                    )}
                  </span>
                )}
              </span>
              {beat.durationSeconds && (
                <span className="shrink-0 pt-0.5 font-mono text-[11px] text-[color:var(--color-paper-ink)]/45">
                  {beat.durationSeconds} с
                </span>
              )}
            </li>
          ))}
        </ol>
        <p className="mt-3 font-mono text-[11px] leading-relaxed tracking-[0.02em] text-[color:var(--color-paper-ink)]/45">
          Биты — будущие кадры: визуал, реплика, надпись и хронометраж можно отправить на доску как
          раскадровку.
        </p>
      </div>
    </section>
  );
}
