import { describe, expect, it } from 'vitest';
import { judgeDeliveredRank, deliveredRankBudget } from './delivered-rank';

/**
 * The anchor case is a real paid call, not a fixture: task
 * `d1f623742cc98f2af897ab45048eb63d`, 2026-08-11, wan 2.7 i2v on kie, 720p, 5 s,
 * USD 0,40 debited. It came back 1108×830 — the input frame's aspect at 0,2% off the
 * nominal 720p pixel count. Every dimension-based check calls that a downgrade.
 */
describe('judgeDeliveredRank: area, never dimensions', () => {
  it('accepts the real 720p i2v delivery that is not 1280×720', () => {
    // 830 is not 720, so a height check fails; 1108×830 is 99,8% of the 720p pixel
    // count, so the area check passes. That gap is the entire reason this module exists.
    const verdict = judgeDeliveredRank('720p', { width: 1108, height: 830 });
    expect(verdict.status).toBe('ok');
  });

  it('catches a real downgrade — 1080p sold, 720p delivered', () => {
    const verdict = judgeDeliveredRank('1080p', { width: 1280, height: 720 });
    expect(verdict.status).toBe('downgraded');
    if (verdict.status === 'downgraded') expect(verdict.ratio).toBeLessThan(0.5);
  });

  it('catches 720p sold, 480p delivered', () => {
    expect(judgeDeliveredRank('720p', { width: 854, height: 480 }).status).toBe('downgraded');
  });

  it('accepts a delivery ABOVE budget — more is not a defect', () => {
    expect(judgeDeliveredRank('720p', { width: 1920, height: 1080 }).status).toBe('ok');
  });

  it('accepts a vendor rounding to macroblock multiples', () => {
    // 1280×720 rounded down to the nearest 16 on both axes.
    expect(judgeDeliveredRank('720p', { width: 1264, height: 704 }).status).toBe('ok');
  });
});

describe('a `p` rung has two legitimate readings, and either one satisfies it', () => {
  it('accepts a SQUARE 720p — 720x720 is 720 lines, even at 56% of the 16:9 budget', () => {
    // Every active video model in the catalog offers 1:1. Under an area-only rule this
    // correct delivery scores 0,5625 and refunds itself.
    const verdict = judgeDeliveredRank('720p', { width: 720, height: 720 });
    expect(verdict.status).toBe('ok');
  });

  it('accepts a PORTRAIT 720p — the rung number is the SHORT side, not the height', () => {
    expect(judgeDeliveredRank('720p', { width: 720, height: 1280 }).status).toBe('ok');
  });

  it('still catches a downgrade that fails BOTH readings', () => {
    // 1280x720 sold as 1080p: 44% of the area budget and a 720 short side against a
    // nominal 1080. Neither reading is satisfied.
    expect(judgeDeliveredRank('1080p', { width: 1280, height: 720 }).status).toBe('downgraded');
  });

  it('does NOT let the short-side reading swallow a real downgrade', () => {
    // 648x648 sold as 720p: the short side is exactly 90% of 720, so an area-sized 10%
    // tolerance here would pass it — at 46% of the pixels. Encoder rounding is ~2%
    // (720 -> 704), not 10%, which is why the two tolerances differ.
    expect(judgeDeliveredRank('720p', { width: 648, height: 648 }).status).toBe('downgraded');
    // 704 is the macroblock-rounded 720 the tolerance actually exists for.
    expect(judgeDeliveredRank('720p', { width: 704, height: 704 }).status).toBe('ok');
  });

  it('catches a square delivery one full rung down', () => {
    // 480x480 sold as 720p: 25% of the budget, short side 480 against a nominal 720.
    expect(judgeDeliveredRank('720p', { width: 480, height: 480 }).status).toBe('downgraded');
  });
});

describe('what must never be judged by pixels', () => {
  it('does not judge a QUALITY TIER — low/medium/high are not sizes', () => {
    // gpt-image-2 sells OpenAI quality tiers, and the vendor spec exposes no size control
    // on that route. Calling a tier "downgraded" on pixel count would invent a promise.
    for (const tier of ['low', 'medium', 'high']) {
      const verdict = judgeDeliveredRank(tier, { width: 512, height: 512 });
      expect(verdict.status, tier).toBe('unknown');
    }
    expect(deliveredRankBudget('high')).toBeNull();
  });

  it('answers UNKNOWN, never downgraded, when the asset could not be measured', () => {
    // An unmeasured job must not trigger a refund — that is the failure mode that would
    // quietly hand money back on every job the prober cannot read.
    expect(judgeDeliveredRank('720p', null).status).toBe('unknown');
    expect(judgeDeliveredRank('720p', { width: 0, height: 0 }).status).toBe('unknown');
  });

  it('does not judge an IMAGE-LADDER rung, because its pixel meaning is vendor-specific', () => {
    // The catalog's 4K rungs live on seedream-5-lite and gemini-3-pro-image, both
    // `maxResolution: '4096x4096'` — a 4096-class frame, not the video ladder's
    // 3840x2160. Judging a correct 2816x1536 gemini delivery against 8,29 MP scores it
    // 0,52 and refunds every 4K image job we sell. Unmeasured means unknown.
    for (const rung of ['1K', '2K', '3K', '4K', '8K']) {
      const verdict = judgeDeliveredRank(rung, { width: 100, height: 100 });
      expect(verdict.status, rung).toBe('unknown');
      if (verdict.status === 'unknown') expect(verdict.reason).toMatch(/not yet measured/);
      expect(deliveredRankBudget(rung), rung).toBeNull();
    }
  });

  it('answers UNKNOWN for an area that cannot fit the column it is stored in', () => {
    // `jobs.delivered_pixels` is int4. A malformed container header claiming 50 000x50 000
    // would make the settle UPDATE throw, failing and refunding a job we already paid for.
    expect(judgeDeliveredRank('720p', { width: 50_000, height: 50_000 }).status).toBe('unknown');
  });

  it('answers UNKNOWN for a rung with no declared budget at all', () => {
    expect(judgeDeliveredRank('360p', { width: 100, height: 100 }).status).toBe('unknown');
    expect(judgeDeliveredRank(null, { width: 100, height: 100 }).status).toBe('unknown');
  });
});
