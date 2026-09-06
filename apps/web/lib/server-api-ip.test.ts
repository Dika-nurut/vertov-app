import { describe, expect, it } from 'vitest';
import { apiBaseUrl, forwardedClientIp } from './server-api';

describe('SSR API client IP forwarding', () => {
  it('takes the real client from the incoming forwarded chain', () => {
    const headers = new Headers({ 'x-forwarded-for': '198.51.100.27, 127.0.0.1' });
    expect(forwardedClientIp(headers)).toBe('198.51.100.27');
  });

  it('falls back to the incoming proxy-provided client header', () => {
    expect(forwardedClientIp(new Headers({ 'x-real-ip': '198.51.100.28' }))).toBe('198.51.100.28');
  });
});

describe('browser API origin', () => {
  it('exposes the public origin separately from the internal SSR origin', () => {
    expect(apiBaseUrl()).toBe(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');
  });
});
