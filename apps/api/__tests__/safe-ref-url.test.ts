import { describe, expect, it } from 'vitest';
import {
  firstUnsafeReferenceUrl,
  isSafeReferenceUrl,
  referenceAllowedOrigins,
} from '../src/safe-ref-url';

/**
 * SF-8 — generate `imageUrls`/`videoUrls`/`audioUrls` forwarded unvalidated.
 *
 * `params` is `z.record(z.unknown())`, so a crafted POST could slip an internal
 * URL into a reference array. `firstUnsafeReferenceUrl` is the exact validator
 * the `/v1/jobs` handler runs; pre-fix nothing inspected these arrays.
 */
const OWN = ['https://assets.seed.app', 'https://api.seed.app'];

describe('SF-8: isSafeReferenceUrl', () => {
  it('allows own-origin asset URLs', () => {
    expect(isSafeReferenceUrl('https://assets.seed.app/u/clip.mp4', OWN)).toBe(true);
    expect(isSafeReferenceUrl('https://api.seed.app/seed-assets/x.jpg', OWN)).toBe(true);
  });

  it('allows an external public reference (fetch is BL-5-guarded downstream)', () => {
    expect(isSafeReferenceUrl('https://cdn.example.com/pic.jpg', OWN)).toBe(true);
    expect(isSafeReferenceUrl('https://93.184.216.34/pic.jpg', OWN)).toBe(true);
  });

  it('does not treat userinfo or a lookalike host as an allowed origin', () => {
    const localOrigin = ['http://127.0.0.1:9000'];
    expect(
      isSafeReferenceUrl('http://127.0.0.1:9000@169.254.169.254/latest/meta-data/', localOrigin),
    ).toBe(false);
    expect(isSafeReferenceUrl('https://assets.seed.app.evil/pic.jpg', OWN)).toBe(true);
    expect(isSafeReferenceUrl('https://assets.seed.app:443@127.0.0.1/pic.jpg', OWN)).toBe(false);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://127.0.0.1:4001/metrics', // internal metrics
    'http://10.0.0.5/internal',
    'http://192.168.1.1/admin',
    'https://172.16.0.9/x',
    'http://[::1]:9000/x',
    'http://100.64.0.1/x', // CGNAT
  ])('blocks internal/private literal %s', (url) => {
    expect(isSafeReferenceUrl(url, OWN)).toBe(false);
  });

  it.each(['file:///etc/passwd', 'gopher://x/', 'data:text/plain,hi', 'not a url'])(
    'blocks non-http(s) / malformed %s',
    (url) => {
      expect(isSafeReferenceUrl(url, OWN)).toBe(false);
    },
  );
});

describe('SF-8: firstUnsafeReferenceUrl scans every reference source', () => {
  it('returns null when all URLs are safe', () => {
    expect(
      firstUnsafeReferenceUrl(
        { imageUrls: ['https://assets.seed.app/a.jpg'], videoUrls: ['https://cdn.ok/v.mp4'] },
        ['https://assets.seed.app/ref.jpg'],
        OWN,
      ),
    ).toBeNull();
  });

  it('flags an internal URL hidden in params.imageUrls', () => {
    expect(
      firstUnsafeReferenceUrl(
        { imageUrls: ['https://assets.seed.app/a.jpg', 'http://169.254.169.254/'] },
        [],
        OWN,
      ),
    ).toBe('http://169.254.169.254/');
  });

  it('flags an internal URL in referenceAssets', () => {
    expect(firstUnsafeReferenceUrl({}, ['http://127.0.0.1/x'], OWN)).toBe('http://127.0.0.1/x');
  });

  it('flags audioUrls and videoUrls too', () => {
    expect(firstUnsafeReferenceUrl({ audioUrls: ['http://10.1.2.3/a.mp3'] }, [], OWN)).toBe(
      'http://10.1.2.3/a.mp3',
    );
    expect(firstUnsafeReferenceUrl({ videoUrls: ['http://192.168.0.2/v.mp4'] }, [], OWN)).toBe(
      'http://192.168.0.2/v.mp4',
    );
  });

  it('flags an internal URL in a typed first/last frame', () => {
    expect(
      firstUnsafeReferenceUrl(
        { frameImages: [{ role: 'last', url: 'http://169.254.169.254/frame.png' }] },
        [],
        OWN,
      ),
    ).toBe('http://169.254.169.254/frame.png');
  });

  it('ignores non-array / non-string param shapes safely', () => {
    expect(firstUnsafeReferenceUrl({ imageUrls: 'not-array' }, [], OWN)).toBeNull();
    expect(firstUnsafeReferenceUrl({ imageUrls: [123, null] }, [], OWN)).toBeNull();
  });
});

describe('SF-8: referenceAllowedOrigins', () => {
  it('collects + de-slashes the configured asset origins', () => {
    const origins = referenceAllowedOrigins({
      ASSET_PUBLIC_URL: 'https://assets.seed.app/',
      API_PUBLIC_URL: 'https://api.seed.app',
    } as NodeJS.ProcessEnv);
    expect(origins).toContain('https://assets.seed.app');
    expect(origins).toContain('https://api.seed.app');
  });
});
