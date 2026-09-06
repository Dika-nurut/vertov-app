import { describe, expect, it } from 'vitest';
import {
  fmtClock,
  fmtEtaHint,
  inflightGenerationsReducer,
  inflightProgressPct,
  inflightStageLabel,
  inflightStatus,
  isActiveInflightJobStatus,
  restoreOwnedInflightJobs,
  type InflightGeneration,
} from './inflight-generations';

const videoJob: InflightGeneration = {
  jobId: 'video-1',
  modelId: 'seedance',
  modelLabel: 'Seedance 1.5',
  kind: 'video',
  startedAt: 1_000,
  etaSec: 120,
  status: 'queued',
};

describe('inflightGenerationsReducer', () => {
  it('adds each accepted take and replaces a duplicate job rather than duplicating its tile', () => {
    const withFirstTake = inflightGenerationsReducer([], { kind: 'add', generation: videoJob });
    const withSecondTake = inflightGenerationsReducer(withFirstTake, {
      kind: 'add',
      generation: { ...videoJob, jobId: 'video-2' },
    });
    const replacedFirstTake = inflightGenerationsReducer(withSecondTake, {
      kind: 'add',
      generation: { ...videoJob, status: 'running' },
    });

    expect(replacedFirstTake).toEqual([
      { ...videoJob, status: 'running' },
      { ...videoJob, jobId: 'video-2' },
    ]);
  });

  it('updates only the tracked job status and removes it after its terminal row resolves', () => {
    const jobs = [videoJob, { ...videoJob, jobId: 'image-1', kind: 'image' as const }];
    const running = inflightGenerationsReducer(jobs, {
      kind: 'status',
      jobId: 'image-1',
      status: 'running',
    });
    const resolved = inflightGenerationsReducer(running, { kind: 'remove', jobId: 'image-1' });

    expect(resolved).toEqual([videoJob]);
  });
});

describe('in-flight generation presentation helpers', () => {
  it('uses the shared Russian stage wording for submitting, queued, video, and image jobs', () => {
    expect(inflightStageLabel('submitting', 'image')).toBe('Отправляем…');
    expect(inflightStageLabel('queued', 'video')).toBe('В очереди…');
    expect(inflightStageLabel('running', 'video')).toBe('Снимаем ролик…');
    expect(inflightStageLabel('running', 'image')).toBe('Рисуем…');
  });

  it('keeps queued jobs at zero progress and caps rendering jobs at the honest 94 percent asymptote', () => {
    expect(inflightProgressPct(60, 120, 'queued')).toBe(0);
    expect(inflightProgressPct(600, 120, 'running')).toBe(94);
  });

  it('normalizes job statuses and formats the timer language used by both stages', () => {
    expect(inflightStatus('running')).toBe('running');
    expect(inflightStatus('anything-else')).toBe('submitting');
    expect(fmtClock(247)).toBe('4:07');
    expect(fmtEtaHint(65)).toBe('~1 мин');
  });

  it('adopts only active rows when restoring concurrent takes after a reload', () => {
    expect(isActiveInflightJobStatus('queued')).toBe(true);
    expect(isActiveInflightJobStatus('running')).toBe(true);
    expect(isActiveInflightJobStatus('succeeded')).toBe(false);
    expect(isActiveInflightJobStatus('failed')).toBe(false);
  });

  it('restores this Generate screen’s active jobs but ignores active jobs from another surface', () => {
    const rows = [
      { id: 'mine', status: 'running' },
      { id: 'boards', status: 'queued' },
      { id: 'finished-mine', status: 'succeeded' },
    ];

    expect(restoreOwnedInflightJobs(rows, new Set(['mine', 'finished-mine']))).toEqual([
      { id: 'mine', status: 'running' },
    ]);
  });
});
