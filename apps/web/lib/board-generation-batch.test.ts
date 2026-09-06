import { describe, expect, it } from 'vitest';
import { boardBatchCost, boardTakesInSubmitOrder } from './board-generation-batch';

describe('board generation batches', () => {
  it('multiplies only video quotes by the requested take count', () => {
    expect(boardBatchCost(12, 'video', 4)).toBe(48);
    expect(boardBatchCost(48, 'image', 4)).toBe(48);
    expect(boardBatchCost(null, 'video', 4)).toBeNull();
  });

  it('accumulates resolved video assets in submit order and caps the take strip', () => {
    const assets = new Map([
      ['job-1', ['one.mp4']],
      ['job-2', ['two.mp4']],
      ['job-3', ['three.mp4', 'three-alt.mp4']],
    ]);

    expect(boardTakesInSubmitOrder(['job-1', 'job-2', 'job-3'], assets)).toEqual([
      'one.mp4',
      'two.mp4',
      'three.mp4',
      'three-alt.mp4',
    ]);
  });

  it('keeps a single job identical to the old take list', () => {
    expect(boardTakesInSubmitOrder(['job-1'], new Map([['job-1', ['one.mp4']]]))).toEqual([
      'one.mp4',
    ]);
  });
});

describe('boardTakesInSubmitOrder — reload de-duplication', () => {
  it('does not append an asset that is already in the recovered takes', () => {
    // After a reload mid-batch every job is resumed, including ones that had
    // already finished before the reload, so job-1's asset arrives twice.
    const takes = boardTakesInSubmitOrder(
      ['job-1', 'job-2'],
      new Map([
        ['job-1', ['https://x/1.mp4']],
        ['job-2', ['https://x/2.mp4']],
      ]),
      ['https://x/1.mp4'],
    );

    expect(takes).toEqual(['https://x/1.mp4', 'https://x/2.mp4']);
  });

  it('puts a re-resolved job back in submit order rather than where the reload left it', () => {
    // job-2 finished before the reload, so its asset is the recovered one; job-1
    // resolves afterwards. Submit order must win over recovery order.
    const takes = boardTakesInSubmitOrder(
      ['job-1', 'job-2'],
      new Map([
        ['job-1', ['https://x/1.mp4']],
        ['job-2', ['https://x/2.mp4']],
      ]),
      ['https://x/2.mp4'],
    );

    expect(takes).toEqual(['https://x/1.mp4', 'https://x/2.mp4']);
  });

  it('keeps a recovered take whose job has not re-resolved, and caps the strip', () => {
    const takes = boardTakesInSubmitOrder(
      ['job-1'],
      new Map([['job-1', ['https://x/c.mp4', 'https://x/d.mp4', 'https://x/e.mp4']]]),
      ['https://x/a.mp4'],
    );

    expect(takes).toEqual([
      'https://x/c.mp4',
      'https://x/d.mp4',
      'https://x/e.mp4',
      'https://x/a.mp4',
    ]);
  });
});
