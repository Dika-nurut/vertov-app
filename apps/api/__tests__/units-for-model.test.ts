import { describe, it, expect } from 'vitest';
import { unitsForModel } from '../src/units';

describe('unitsForModel', () => {
  describe('image kind', () => {
    it('defaults to 1 when `n` is missing', () => {
      const r = unitsForModel({ kind: 'image', params: {}, maxDurationSeconds: null });
      expect(r).toEqual({ ok: true, units: 1 });
    });

    it('returns ceil(n) when valid', () => {
      expect(unitsForModel({ kind: 'image', params: { n: 3 }, maxDurationSeconds: null })).toEqual({
        ok: true,
        units: 3,
      });
      expect(
        unitsForModel({ kind: 'image', params: { n: 2.4 }, maxDurationSeconds: null }),
      ).toEqual({ ok: true, units: 3 });
    });

    it('falls back to 1 for non-positive or NaN', () => {
      expect(unitsForModel({ kind: 'image', params: { n: 0 }, maxDurationSeconds: null })).toEqual({
        ok: true,
        units: 1,
      });
      expect(
        unitsForModel({ kind: 'image', params: { n: 'oops' }, maxDurationSeconds: null }),
      ).toEqual({ ok: true, units: 1 });
    });
  });

  describe('video kind', () => {
    it('rejects missing duration_seconds with a client-visible error', () => {
      const r = unitsForModel({ kind: 'video', params: {}, maxDurationSeconds: 10 });
      expect(r).toEqual({ ok: false, error: 'duration_seconds_required' });
    });

    it('rejects non-positive duration', () => {
      expect(
        unitsForModel({ kind: 'video', params: { duration_seconds: 0 }, maxDurationSeconds: 10 }),
      ).toEqual({ ok: false, error: 'duration_seconds_required' });
      expect(
        unitsForModel({ kind: 'video', params: { duration_seconds: -3 }, maxDurationSeconds: 10 }),
      ).toEqual({ ok: false, error: 'duration_seconds_required' });
    });

    it('caps at model.maxDurationSeconds when caller asks for more', () => {
      const r = unitsForModel({
        kind: 'video',
        params: { duration_seconds: 30 },
        maxDurationSeconds: 10,
      });
      expect(r).toEqual({ ok: true, units: 10 });
    });

    it('ceils fractional durations', () => {
      const r = unitsForModel({
        kind: 'video',
        params: { duration_seconds: 4.2 },
        maxDurationSeconds: 30,
      });
      expect(r).toEqual({ ok: true, units: 5 });
    });

    it('floors billing at the model minimum duration', () => {
      expect(
        unitsForModel({
          kind: 'video',
          params: { duration_seconds: 1 },
          minDurationSeconds: 4,
          maxDurationSeconds: 10,
        }),
      ).toEqual({ ok: true, units: 4 });
    });

    it('treats a non-positive cap as "no cap declared" rather than 0-cost', () => {
      const r = unitsForModel({
        kind: 'video',
        params: { duration_seconds: 8 },
        maxDurationSeconds: 0,
      });
      expect(r).toEqual({ ok: true, units: 8 });
    });

    it('passes a valid in-range duration through unchanged', () => {
      const r = unitsForModel({
        kind: 'video',
        params: { duration_seconds: 8 },
        maxDurationSeconds: 30,
      });
      expect(r).toEqual({ ok: true, units: 8 });
    });
  });
});
