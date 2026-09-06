import { describe, expect, it } from 'vitest';
import { renderStageFromEvent, renderStageLabel } from './render-stage';

describe('renderStageLabel', () => {
  it('maps known stages to RU labels', () => {
    expect(renderStageLabel('normalizing')).toBe('Нормализуем клипы…');
    expect(renderStageLabel('composing')).toBe('Собираем дорожку…');
    expect(renderStageLabel('uploading')).toBe('Готовим файл…');
  });
  it('returns null for unknown / absent stages', () => {
    expect(renderStageLabel(undefined)).toBeNull();
    expect(renderStageLabel(null)).toBeNull();
    expect(renderStageLabel('bogus')).toBeNull();
  });
});

describe('renderStageFromEvent', () => {
  const evt = (over: Partial<Parameters<typeof renderStageFromEvent>[0]>) => ({
    jobId: 'r1',
    status: 'running',
    source: 'studio',
    stage: 'composing',
    ...over,
  });

  it('returns the label for our running studio render', () => {
    expect(renderStageFromEvent(evt({}), 'r1')).toBe('Собираем дорожку…');
  });
  it('ignores other renders, generation events, and terminal status', () => {
    expect(renderStageFromEvent(evt({}), 'other')).toBeNull();
    expect(renderStageFromEvent(evt({ source: 'generation' }), 'r1')).toBeNull();
    expect(renderStageFromEvent(evt({ status: 'succeeded' }), 'r1')).toBeNull();
    expect(renderStageFromEvent(evt({}), null)).toBeNull();
  });
});
