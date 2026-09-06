'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2 } from '@/components/ui/icons';

interface TimingRevision {
  id: string;
  durationSeconds: number;
  owner: 'vertov' | 'user';
  sourceRevisionId: string;
  stale: boolean;
  sourceChanged: boolean;
  createdAt: string;
}

interface TimingScene {
  sourceUnitId: string;
  ordinal: number;
  heading: string;
  synopsis: string;
  sourceRevisionId: string;
  pageEstimate: string | null;
  timing: TimingRevision | null;
}

interface TimingResponse {
  scenes: TimingScene[];
}

function formatSeconds(value: number): string {
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function ScenarioTimingPanel({
  apiUrl,
  scriptId,
  saveNow,
}: {
  apiUrl: string;
  scriptId: string;
  saveNow: () => Promise<boolean>;
}) {
  const [scenes, setScenes] = useState<TimingScene[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch(`${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/scene-timings`, {
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('load');
        return (await response.json()) as TimingResponse;
      })
      .then((body) => {
        if (!alive) return;
        setScenes(body.scenes);
        setDrafts(
          Object.fromEntries(
            body.scenes
              .filter((scene) => scene.timing)
              .map((scene) => [scene.sourceUnitId, String(scene.timing!.durationSeconds)]),
          ),
        );
      })
      .catch(() => {
        if (alive) setError('Не удалось загрузить тайминг сцен.');
      });
    return () => {
      alive = false;
    };
  }, [apiUrl, scriptId]);

  async function approve(scene: TimingScene): Promise<void> {
    const value = Number(drafts[scene.sourceUnitId] ?? '');
    if (!Number.isInteger(value) || value < 1 || value > 7200 || saving) return;
    setSaving(scene.sourceUnitId);
    setError(null);
    if (!(await saveNow())) {
      setError('Сначала сохраните текст и разрешите конфликт версии.');
      setSaving(null);
      return;
    }
    try {
      const response = await fetch(
        `${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/scene-timings/${encodeURIComponent(scene.sourceUnitId)}`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ durationSeconds: value }),
        },
      );
      if (!response.ok) throw new Error('save');
      const body = (await response.json()) as { timing: TimingRevision };
      setScenes(
        (current) =>
          current?.map((item) =>
            item.sourceUnitId === scene.sourceUnitId ? { ...item, timing: body.timing } : item,
          ) ?? current,
      );
    } catch {
      setError('Не удалось сохранить длительность. Повторите ещё раз.');
    } finally {
      setSaving(null);
    }
  }

  return (
    <section
      className="shrink-0 border-b-[2px] border-[color:var(--color-paper-ink)]/25 bg-[color:var(--color-paper)] px-4 py-4 sm:px-7"
      data-testid="scenario-timing-panel"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-paper-ink)]/55">
            Содержание · длительность сцен
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--color-paper-ink)]/65">
            «По страницам» — только ориентир. Утвердите рабочее экранное время перед планом кадров.
          </p>
        </div>
        {scenes && (
          <span className="font-mono text-[11px] text-[color:var(--color-paper-ink)]/45">
            {scenes.length} сцен
          </span>
        )}
      </div>

      {scenes === null && !error && <Loader2 size={14} className="mt-3 seed-spin" />}
      {scenes && scenes.length === 0 && (
        <p className="mt-3 text-[11px] text-[color:var(--color-paper-ink)]/55">Сцен пока нет.</p>
      )}
      {scenes && scenes.length > 0 && (
        <ol className="mt-3 space-y-2" data-testid="scenario-timing-scenes">
          {scenes.map((scene) => {
            const value = drafts[scene.sourceUnitId] ?? '';
            const canSave = Number.isInteger(Number(value)) && Number(value) > 0;
            return (
              <li
                key={scene.sourceUnitId}
                className="flex flex-wrap items-center gap-2 border-[2px] border-[color:var(--color-paper-ink)]/30 bg-white px-2.5 py-2"
                data-testid="scenario-timing-scene"
              >
                <span className="w-5 shrink-0 font-mono text-[11px] text-[color:var(--color-paper-ink)]/45">
                  {scene.ordinal}
                </span>
                <span className="min-w-[150px] flex-1">
                  <strong className="block truncate font-mono text-[11px] uppercase tracking-[0.04em]">
                    {scene.heading}
                  </strong>
                  <span className="block truncate text-[11px] text-[color:var(--color-paper-ink)]/55">
                    По страницам ~{scene.pageEstimate ?? '—'}
                    {scene.timing?.sourceChanged && scene.timing.owner === 'user'
                      ? ' · текст изменён, ваше время сохранено'
                      : scene.timing?.stale
                        ? ' · оценка устарела'
                        : ''}
                  </span>
                </span>
                <label className="flex items-center gap-1 font-mono text-[11px] text-[color:var(--color-paper-ink)]/65">
                  <input
                    type="number"
                    min={1}
                    max={7200}
                    value={value}
                    placeholder="сек"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [scene.sourceUnitId]: event.target.value,
                      }))
                    }
                    className="h-8 w-20 border-[2px] border-[color:var(--color-paper-ink)]/35 bg-white px-2 text-[13px] text-[color:var(--color-paper-ink)] outline-none"
                    data-testid={`scenario-timing-input-${scene.ordinal}`}
                  />{' '}
                  с
                </label>
                <button
                  type="button"
                  disabled={!canSave || saving !== null}
                  onClick={() => void approve(scene)}
                  className="inline-flex items-center gap-1 border-[2px] border-[color:var(--color-paper-ink)] px-2 py-1.5 text-[11px] font-bold text-[color:var(--color-paper-ink)] disabled:opacity-40"
                  data-testid={`scenario-timing-save-${scene.ordinal}`}
                >
                  {saving === scene.sourceUnitId ? (
                    <Loader2 size={11} className="seed-spin" />
                  ) : (
                    <Check size={11} />
                  )}
                  Утвердить
                </button>
                {scene.timing && (
                  <span className="w-full pl-7 font-mono text-[11px] text-[color:var(--color-paper-ink)]/45">
                    Рабочее время: {formatSeconds(scene.timing.durationSeconds)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {error && (
        <p className="mt-3 text-[11px] text-[color:var(--color-destructive)]" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
