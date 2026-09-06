/**
 * Map a studio render stage (emitted by the worker over the job-event bus,
 * B-0/B-9) to a user-facing label, so a render shows meaningful progress beyond
 * a bare "running". Pure → unit-tested; the Studio client renders the label.
 */
const STAGE_LABELS: Record<string, string> = {
  normalizing: 'Нормализуем клипы…',
  probing: 'Анализируем тайминги…',
  composing: 'Собираем дорожку…',
  uploading: 'Готовим файл…',
};

export function renderStageLabel(stage: string | undefined | null): string | null {
  if (!stage) return null;
  return STAGE_LABELS[stage] ?? null;
}

export interface RenderBusEvent {
  jobId: string;
  status: string;
  source: string;
  stage?: string;
}

/**
 * The stage label to show for THIS render from a bus event — only for studio
 * events targeting our render id while it's still running. Returns null to
 * leave the current label untouched (foreign event, terminal, or no stage).
 */
export function renderStageFromEvent(evt: RenderBusEvent, renderId: string | null): string | null {
  if (!renderId || evt.source !== 'studio' || evt.jobId !== renderId) return null;
  if (evt.status !== 'running') return null;
  return renderStageLabel(evt.stage);
}
