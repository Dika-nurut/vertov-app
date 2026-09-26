import { describe, expect, it } from 'vitest';
import { rateLimitMessage, retryAfterSeconds } from './rate-limit';

describe('retryAfterSeconds', () => {
  it('parses delay seconds', () => {
    expect(retryAfterSeconds('45')).toBe(45);
    expect(retryAfterSeconds(' 7 ')).toBe(7);
  });

  it('returns null for absent or garbled values', () => {
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds('')).toBeNull();
    expect(retryAfterSeconds('soon')).toBeNull();
    expect(retryAfterSeconds('-3')).toBeNull();
  });

  it('parses an HTTP date into a non-negative delay', () => {
    const future = new Date(Date.now() + 90_000).toUTCString();
    const secs = retryAfterSeconds(future);
    expect(secs).not.toBeNull();
    expect(secs!).toBeGreaterThan(0);
    expect(secs!).toBeLessThanOrEqual(90);
  });
});

describe('rateLimitMessage', () => {
  it('names the wait in seconds when Retry-After is short', () => {
    expect(rateLimitMessage('45')).toBe('Слишком много попыток, попробуйте через 45 с');
  });

  it('rounds long waits up to minutes', () => {
    expect(rateLimitMessage('60')).toBe('Слишком много попыток, попробуйте через минуту');
    expect(rateLimitMessage('150')).toBe('Слишком много попыток, попробуйте через 3 мин');
  });

  it('falls back to a plain nudge without a usable header', () => {
    expect(rateLimitMessage(null)).toBe('Слишком много попыток, попробуйте позже');
    expect(rateLimitMessage('soon')).toBe('Слишком много попыток, попробуйте позже');
  });
});
