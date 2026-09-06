/**
 * Pure state and presentation helpers for Generate's jobs that have been
 * accepted by the API but have not reached a terminal row yet.
 */

export type InflightGenerationStatus = 'submitting' | 'queued' | 'running';

export interface InflightGeneration {
  jobId: string;
  modelId: string;
  modelLabel: string;
  kind: 'image' | 'video';
  startedAt: number;
  etaSec: number;
  status: InflightGenerationStatus;
}

export type InflightGenerationsAction =
  | { kind: 'add'; generation: InflightGeneration }
  | { kind: 'status'; jobId: string; status: InflightGenerationStatus }
  | { kind: 'remove'; jobId: string };

export function inflightGenerationsReducer(
  generations: InflightGeneration[],
  action: InflightGenerationsAction,
): InflightGeneration[] {
  if (action.kind === 'add') {
    const existing = generations.findIndex(
      (generation) => generation.jobId === action.generation.jobId,
    );
    if (existing < 0) return [...generations, action.generation];
    return generations.map((generation, index) =>
      index === existing ? action.generation : generation,
    );
  }
  if (action.kind === 'status') {
    return generations.map((generation) =>
      generation.jobId === action.jobId ? { ...generation, status: action.status } : generation,
    );
  }
  return generations.filter((generation) => generation.jobId !== action.jobId);
}

/** Server event values are broader than the compact UI state. */
export function inflightStatus(status?: string): InflightGenerationStatus {
  if (status === 'queued') return 'queued';
  if (status === 'running') return 'running';
  return 'submitting';
}

/** Only these server rows may be adopted as live work after a page reload. */
export function isActiveInflightJobStatus(status: string): boolean {
  return status === 'queued' || status === 'running';
}

/** Keeps only jobs this Generate tab explicitly launched when it reloads. */
export function restoreOwnedInflightJobs<T extends { id: string; status: string }>(
  rows: readonly T[],
  ownedJobIds: ReadonlySet<string>,
): T[] {
  return rows.filter((job) => ownedJobIds.has(job.id) && isActiveInflightJobStatus(job.status));
}

export function inflightStageLabel(
  status: InflightGenerationStatus,
  kind: InflightGeneration['kind'],
): string {
  if (status === 'submitting') return 'Отправляем…';
  if (status === 'queued') return 'В очереди…';
  return kind === 'video' ? 'Снимаем ролик…' : 'Рисуем…';
}

/** Honest progress: queueing has no measurable render progress. */
export function inflightProgressPct(
  elapsedSec: number,
  etaSec: number,
  status: InflightGenerationStatus,
): number {
  if (status !== 'running') return 0;
  return Math.min(94, Math.round((elapsedSec / etaSec) * 100));
}

export function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtEtaHint(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  return s < 60 ? `~${s} с` : `~${Math.round(s / 60)} мин`;
}
