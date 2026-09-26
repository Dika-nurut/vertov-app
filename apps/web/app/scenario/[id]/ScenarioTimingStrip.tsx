'use client';

import { useEffect, useState } from 'react';
import { formatSeconds, sceneSeconds, type SceneTiming } from '../useSceneTimings';

/**
 * One screen-time number per scene. The strip shows the cut at a glance
 * (segment width = seconds, total against the brief's target); the line below
 * edits the current scene. Saving on Enter/blur is the approval — there is no
 * separate «Утвердить» step.
 */
export function ScenarioTimingStrip({
  scenes,
  error,
  currentOrdinal,
  targetSeconds,
  onJump,
  onSetSeconds,
}: {
  scenes: SceneTiming[];
  error: string | null;
  currentOrdinal: number;
  targetSeconds: number | null;
  onJump: (ordinal: number) => void;
  onSetSeconds: (sourceUnitId: string, seconds: number) => Promise<boolean>;
}) {
  const current = scenes.find((scene) => scene.ordinal === currentOrdinal) ?? scenes[0]!;
  const currentValue = sceneSeconds(current);
  const [draft, setDraft] = useState(currentValue ? String(currentValue) : '');
  useEffect(() => {
    setDraft(currentValue ? String(currentValue) : '');
  }, [current.sourceUnitId, currentValue]);

  const seconds = scenes.map((scene) => sceneSeconds(scene) ?? 0);
  const total = seconds.reduce((sum, value) => sum + value, 0);
  const delta = targetSeconds ? total - targetSeconds : 0;

  const commit = () => {
    const value = Number(draft);
    if (!Number.isInteger(value) || value < 1 || value > 7200 || value === currentValue) return;
    void onSetSeconds(current.sourceUnitId, value);
  };

  const source =
    current.timing && !current.timing.stale
      ? current.timing.owner === 'user'
        ? 'твоё время'
        : 'предложил Вертов'
      : 'оценка по тексту';

  return (
    <section className="mb-2 shrink-0" data-testid="scenario-timing-panel">
      <div className="flex items-stretch gap-3">
        <ol
          className="flex h-9 min-w-0 flex-1 border-[2.5px] border-[color:var(--color-line)]"
          aria-label="Хронометраж по сценам"
        >
          {scenes.map((scene, index) => (
            <li
              key={scene.sourceUnitId}
              className="min-w-[28px] border-l-[2.5px] border-[color:var(--color-line)] first:border-l-0"
              style={{ flex: Math.max(seconds[index]!, 1) }}
            >
              <button
                type="button"
                onClick={() => onJump(scene.ordinal)}
                title={`${scene.ordinal}. ${scene.heading} · ${formatSeconds(seconds[index]!)}`}
                className={`flex h-full w-full items-center overflow-hidden px-2 font-mono text-[11px] font-bold uppercase tracking-[0.04em] ${
                  scene.ordinal === current.ordinal
                    ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                    : 'text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface)]'
                }`}
                data-testid="scenario-timing-scene"
              >
                <span className="truncate">
                  {scene.ordinal} {scene.heading.replace(/^\d+\.\s*/, '')}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <p
          className="flex shrink-0 items-baseline gap-1 self-center font-mono text-[17px] font-extrabold"
          data-testid="scenario-timing-total"
        >
          {formatSeconds(total)}
          {targetSeconds ? (
            <span className="text-[11px] font-bold text-[color:var(--color-muted-foreground)]">
              / {formatSeconds(targetSeconds)}{' '}
              <span
                className={
                  delta === 0
                    ? 'text-[color:var(--color-positive)]'
                    : 'text-[color:var(--color-accent2)]'
                }
              >
                {delta === 0 ? '✓' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} с`}
              </span>
            </span>
          ) : null}
        </p>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[color:var(--color-muted-foreground)]">
        <span className="min-w-0 truncate">
          Сцена {current.ordinal} · {current.heading}
        </span>
        <label className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase text-[color:var(--color-fg)]">
          <input
            type="number"
            min={1}
            max={7200}
            value={draft}
            placeholder="—"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
            className="h-7 w-16 border-[2px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-2 text-[13px] text-[color:var(--color-fg)] outline-none"
            aria-label={`Длительность сцены ${current.ordinal}, секунд`}
            data-testid={`scenario-timing-input-${current.ordinal}`}
          />
          сек
        </label>
        <span className="font-mono text-[11px]">{source}</span>
        {error && (
          <span className="text-[color:var(--color-destructive)]" role="alert">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
