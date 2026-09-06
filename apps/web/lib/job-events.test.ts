import { describe, expect, it } from 'vitest';
import { jobEventAction, TERMINAL_JOB_STATUSES } from './job-events';

const ctx = (tracked: string[], displayedJobId: string | null) => ({
  tracked: new Set(tracked),
  displayedJobId,
});

describe('jobEventAction', () => {
  it('ignores non-generation (studio) events', () => {
    const evt = { jobId: 'r1', status: 'succeeded', source: 'studio' };
    expect(jobEventAction(evt, ctx(['r1'], 'r1'))).toEqual({ kind: 'ignore' });
  });

  it('ignores generation events for jobs this screen did not submit', () => {
    const evt = { jobId: 'other', status: 'succeeded', source: 'generation' };
    expect(jobEventAction(evt, ctx(['mine'], 'mine'))).toEqual({ kind: 'ignore' });
  });

  it('resolves a terminal event for the displayed job', () => {
    const evt = { jobId: 'j1', status: 'succeeded', source: 'generation' };
    expect(jobEventAction(evt, ctx(['j1'], 'j1'))).toEqual({ kind: 'resolve' });
  });

  it('resolves a terminal event for a tracked BACKGROUND job (concurrent submits)', () => {
    // j2 finished while j1 is on stage — its result must still land.
    const evt = { jobId: 'j2', status: 'failed', source: 'generation' };
    expect(jobEventAction(evt, ctx(['j1', 'j2'], 'j1'))).toEqual({ kind: 'resolve' });
  });

  it('treats every terminal status as resolve', () => {
    for (const status of TERMINAL_JOB_STATUSES) {
      const evt = { jobId: 'j1', status, source: 'generation' };
      expect(jobEventAction(evt, ctx(['j1'], 'j1'))).toEqual({ kind: 'resolve' });
    }
  });

  it('emits a progress update for an in-flight DISPLAYED job', () => {
    const evt = { jobId: 'j1', status: 'running', source: 'generation' };
    expect(jobEventAction(evt, ctx(['j1'], 'j1'))).toEqual({ kind: 'progress', status: 'running' });
  });

  it('ignores in-flight progress for a tracked but NON-displayed job', () => {
    const evt = { jobId: 'j2', status: 'running', source: 'generation' };
    expect(jobEventAction(evt, ctx(['j1', 'j2'], 'j1'))).toEqual({ kind: 'ignore' });
  });
});
