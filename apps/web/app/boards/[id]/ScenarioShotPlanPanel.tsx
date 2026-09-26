'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, Clock3, FileText, Loader2, Sparkles, X } from '@/components/ui/icons';
import type { BoardDocument } from '@seed/shared/board-contract';
import type { ScenarioShotPlan } from '@seed/shared/scenario-shot-plan';

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

interface HandoffResponse {
  state?: BoardDocument;
  added?: number;
  updated?: number;
  materializedShots?: number;
  materializedCastNodes?: number;
  error?: string;
}

function randomKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `scenario-plan-${crypto.randomUUID()}`;
  }
  return `scenario-plan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatSeconds(value: number): string {
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function planError(status: number, error: unknown): string {
  if (error === 'signup_required') return 'План кадров доступен после регистрации.';
  if (error === 'scene_timing_required') return 'Утвердите экранное время после изменения текста.';
  if (error === 'shot_plan_in_progress')
    return 'План для этой сцены уже строится. Повторите позже.';
  if (error === 'shot_plan_daily_quota') return 'Дневной лимит планов исчерпан. Попробуйте завтра.';
  if (error === 'insufficient_credits') return 'Недостаточно кредитов для плана кадров.';
  if (error === 'shot_plan_unreconcilable')
    return 'План не удалось согласовать с длительностью сцены.';
  if (error === 'timing_save') return 'Не удалось сохранить экранное время сцены.';
  if (status === 429) return 'Слишком много запросов. Повторите через несколько минут.';
  return `Не удалось построить план кадров (HTTP ${status}).`;
}

export function ScenarioShotPlanPanel({
  apiUrl,
  boardId,
  scriptId,
  ordinals,
  beforeApply,
  onClose,
  onApplied,
}: {
  apiUrl: string;
  boardId: string;
  scriptId: string;
  ordinals: readonly number[];
  beforeApply: () => Promise<boolean>;
  onClose: () => void;
  onApplied: (state: BoardDocument, summary: string) => void;
}) {
  const [scenes, setScenes] = useState<TimingScene[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [plans, setPlans] = useState<Record<string, ScenarioShotPlan>>({});
  const [step, setStep] = useState<'timing' | 'plan'>('timing');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(randomKey());
  const ordinalKey = [...ordinals].sort((a, b) => a - b).join(',');

  useEffect(() => {
    idempotencyKey.current = randomKey();
    setScenes(null);
    setPlans({});
    setStep('timing');
    setError(null);
    const selectedOrdinals = new Set(ordinals);
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
        const selected = body.scenes.filter((scene) => selectedOrdinals.has(scene.ordinal));
        setScenes(selected);
        setDrafts(
          Object.fromEntries(
            selected
              .filter((scene) => scene.timing)
              .map((scene) => [scene.sourceUnitId, String(scene.timing!.durationSeconds)]),
          ),
        );
      })
      .catch(() => {
        if (alive) setError('Не удалось загрузить длительность сцен.');
      });
    return () => {
      alive = false;
    };
  }, [apiUrl, ordinalKey, ordinals, scriptId]);

  async function buildPlans(): Promise<void> {
    if (!scenes || busy) return;
    const invalid = scenes.find((scene) => {
      const value = Number(drafts[scene.sourceUnitId] ?? '');
      return !Number.isInteger(value) || value < 1 || value > 7200;
    });
    if (invalid) {
      setError(`Задайте длительность сцены ${invalid.ordinal} целым числом секунд.`);
      return;
    }
    setBusy(true);
    setError(null);
    if (!(await beforeApply())) {
      setBusy(false);
      setError('Сначала нужно сохранить изменения борда. Попробуйте ещё раз.');
      return;
    }
    try {
      // Re-approve every selected value. This makes a stale Vertov suggestion or
      // a timing from an older source revision explicit before the paid call.
      for (const scene of scenes) {
        const response = await fetch(
          `${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/scene-timings/${encodeURIComponent(scene.sourceUnitId)}`,
          {
            method: 'PUT',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ durationSeconds: Number(drafts[scene.sourceUnitId]) }),
          },
        );
        if (!response.ok) throw new Error('timing_save');
      }

      const nextPlans: Record<string, ScenarioShotPlan> = {};
      for (const scene of scenes) {
        const response = await fetch(
          `${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/scenes/${encodeURIComponent(scene.sourceUnitId)}/shot-plan`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          },
        );
        const body = (await response.json().catch(() => ({}))) as {
          plan?: ScenarioShotPlan;
          error?: string;
        };
        if (!response.ok || !body.plan) {
          throw new Error(planError(response.status, body.error));
        }
        nextPlans[scene.sourceUnitId] = body.plan;
      }
      setPlans(nextPlans);
      setStep('plan');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось построить план кадров.');
    } finally {
      setBusy(false);
    }
  }

  async function applyPlans(): Promise<void> {
    if (!scenes || Object.keys(plans).length !== scenes.length || busy) return;
    setBusy(true);
    setError(null);
    if (!(await beforeApply())) {
      setBusy(false);
      setError('Сначала нужно сохранить изменения борда. Попробуйте ещё раз.');
      return;
    }
    try {
      const response = await fetch(
        `${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/board-handoff`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ordinals: scenes.map((scene) => scene.ordinal).sort((a, b) => a - b),
            destination: 'board',
            boardId,
            // The scene-only import already handled source removal policy. The
            // plan pass only adds ordinary prompt/generate/reference nodes.
            fullSync: false,
            idempotencyKey: idempotencyKey.current,
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as HandoffResponse;
      if (!response.ok || !body.state) {
        throw new Error(planError(response.status, body.error));
      }
      onApplied(
        body.state,
        `План добавлен: ${body.materializedShots ?? 0} кадров · референсов для разрешения: ${body.materializedCastNodes ?? 0}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось добавить план на борд.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      aria-label={step === 'timing' ? 'Длительность сцен' : 'Предложение плана кадров'}
      className="glass-menu seed-scroll pointer-events-auto absolute bottom-3 right-3 top-3 z-40 flex w-[min(440px,calc(100vw-1.5rem))] flex-col overflow-y-auto rounded-[var(--radius-md)] p-4"
      data-testid={step === 'timing' ? 'scenario-arrival-panel' : 'scenario-plan-panel'}
    >
      <div className="flex items-start gap-3">
        {step === 'timing' ? (
          <Clock3 size={19} className="mt-1 text-[color:var(--color-accent)]" />
        ) : (
          <Sparkles size={19} className="mt-1 text-[color:var(--color-accent)]" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-faint)]">
            {step === 'timing' ? 'Сценарий · Board' : 'Сценарий · план кадров'}
          </p>
          <h2 className="mt-1 font-display text-[20px] text-[color:var(--color-fg)]">
            {step === 'timing' ? 'Задайте хронометраж' : 'Предложение плана'}
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            {step === 'timing'
              ? 'Рабочее время сцены нужно утвердить до разложения на кадры. Оценка по страницам — только ориентир.'
              : 'Кадры по смыслу, не по модели. Модель и цена появятся позже, на карточке генерации.'}
          </p>
        </div>
        <button type="button" aria-label="Закрыть" onClick={onClose}>
          <X size={17} />
        </button>
      </div>

      {scenes === null && !error && <Loader2 size={16} className="m-5 seed-spin" />}
      {scenes && scenes.length === 0 && (
        <p className="mt-5 text-[13px] text-[color:var(--color-faint)]">
          Выбранные сцены не найдены.
        </p>
      )}

      {step === 'timing' && scenes && scenes.length > 0 && (
        <ol className="mt-5 space-y-2" data-testid="scenario-arrival-scenes">
          {scenes.map((scene) => {
            const value = drafts[scene.sourceUnitId] ?? '';
            const approved =
              scene.timing?.owner === 'user' &&
              !scene.timing.stale &&
              !scene.timing.sourceChanged &&
              String(scene.timing.durationSeconds) === value;
            return (
              <li
                key={scene.sourceUnitId}
                className="border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] p-2.5"
                data-testid="scenario-arrival-scene"
              >
                <div className="flex items-start gap-2">
                  <span className="font-mono text-[11px] text-[color:var(--color-faint)]">
                    {scene.ordinal}
                  </span>
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-[13px] text-[color:var(--color-fg)]">
                      {scene.heading}
                    </strong>
                    <span className="mt-0.5 block text-[11px] text-[color:var(--color-faint)]">
                      По страницам ~{scene.pageEstimate ?? '—'}
                      {approved ? ' · время утверждено' : ' · нужно утвердить'}
                    </span>
                  </div>
                  <Check
                    size={14}
                    aria-hidden
                    className={approved ? 'text-[color:var(--color-positive)]' : 'text-transparent'}
                  />
                </div>
                <label className="mt-2 flex items-center gap-2 font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
                  <span>Экранное время</span>
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
                    className="h-8 w-24 border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-2 text-[13px] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
                    data-testid={`scenario-arrival-duration-${scene.ordinal}`}
                  />
                  с
                </label>
              </li>
            );
          })}
        </ol>
      )}

      {step === 'plan' && scenes && (
        <div className="mt-5 space-y-4" data-testid="scenario-plan-scenes">
          {scenes.map((scene) => {
            const plan = plans[scene.sourceUnitId];
            return (
              <section
                key={scene.sourceUnitId}
                className="border-b-2 border-[color:var(--color-line)] pb-3 last:border-0"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="min-w-0 truncate text-[14px] font-semibold text-[color:var(--color-fg)]">
                    {scene.ordinal}. {scene.heading}
                  </h3>
                  <span className="shrink-0 font-mono text-[11px] text-[color:var(--color-faint)]">
                    {formatSeconds(plan?.targetDurationSeconds ?? 0)} · {plan?.shots.length ?? 0}{' '}
                    кадр.
                  </span>
                </div>
                <ol className="mt-2 space-y-1.5">
                  {plan?.shots.map((shot) => (
                    <li
                      key={shot.order}
                      className="border-2 border-[color:var(--color-line-soft)] px-2.5 py-2"
                      data-testid="scenario-plan-shot"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] text-[color:var(--color-accent)]">
                          {shot.order}
                        </span>
                        <strong className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--color-fg)]">
                          {shot.title}
                        </strong>
                        <span className="shrink-0 font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
                          {shot.durationSec} с
                        </span>
                      </div>
                      {shot.dramaticBeat && (
                        <p className="mt-1 pl-5 text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                          {shot.dramaticBeat}
                        </p>
                      )}
                      {(shot.requiredLocks.length > 0 || shot.unresolvedAssets.length > 0) && (
                        <div className="mt-1 flex flex-wrap gap-1 pl-5">
                          {shot.requiredLocks.map((lock) => (
                            <span
                              key={`lock-${lock}`}
                              className="border border-[color:var(--color-positive)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-positive)]"
                            >
                              lock · {lock}
                            </span>
                          ))}
                          {shot.unresolvedAssets.map((asset) => (
                            <span
                              key={`asset-${asset}`}
                              className="border border-[color:var(--color-destructive)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-destructive)]"
                            >
                              нужно решить · {asset}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 text-[13px] leading-relaxed text-[color:var(--color-destructive)]"
        >
          {error}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t-2 border-[color:var(--color-line)] pt-3">
        {step === 'plan' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setStep('timing');
              setError(null);
            }}
            className="press-inset inline-flex items-center gap-1 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] px-3 py-2 text-[13px] font-semibold text-[color:var(--color-muted-foreground)] disabled:opacity-40"
          >
            <ChevronLeft size={14} /> Изменить время
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--color-faint)]">
            <FileText size={13} /> {scenes?.length ?? 0} сцен выбрано
          </span>
        )}
        <button
          type="button"
          disabled={busy || !scenes?.length}
          onClick={() => void (step === 'timing' ? buildPlans() : applyPlans())}
          className="press inline-flex items-center gap-2 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-40"
          data-testid={step === 'timing' ? 'scenario-plan-continue' : 'scenario-plan-apply'}
        >
          {busy && <Loader2 size={14} className="seed-spin" />}
          {step === 'timing' ? 'Построить план' : 'Создать кадры на борде'}
        </button>
      </div>
    </aside>
  );
}
