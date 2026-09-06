import { describe, expect, it } from 'vitest';
import { assetSrc } from './asset-src';

describe('assetSrc', () => {
  it('strips the bare-IP http origin to a same-origin /seed-assets path', () => {
    expect(assetSrc('http://109.199.97.163/seed-assets/u/j/0.mp4')).toBe('/seed-assets/u/j/0.mp4');
  });

  it('strips any https origin (tunnel / future domain) — origin-agnostic', () => {
    expect(assetSrc('https://x.trycloudflare.com/seed-assets/a/b.png')).toBe(
      '/seed-assets/a/b.png',
    );
    expect(assetSrc('https://vertov.space/seed-assets/a/b.png')).toBe('/seed-assets/a/b.png');
  });

  it('handles preset previews too', () => {
    expect(assetSrc('http://109.199.97.163/seed-preset-previews/p.jpg')).toBe(
      '/seed-preset-previews/p.jpg',
    );
  });

  it('handles curated showcase demo assets (landing витрина)', () => {
    expect(assetSrc('http://127.0.0.1:9000/seed-demo-assets/sunset-mountains.png')).toBe(
      '/seed-demo-assets/sunset-mountains.png',
    );
  });

  it('leaves already-relative paths unchanged (idempotent)', () => {
    expect(assetSrc('/seed-assets/u/j/0.mp4')).toBe('/seed-assets/u/j/0.mp4');
  });

  it('leaves unrelated/external/blob/data URLs unchanged', () => {
    expect(assetSrc('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png');
    expect(assetSrc('blob:https://app/123')).toBe('blob:https://app/123');
    expect(assetSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('does not rewrite other bucket paths', () => {
    expect(assetSrc('http://109.199.97.163/other-bucket/x.png')).toBe(
      'http://109.199.97.163/other-bucket/x.png',
    );
  });

  it('tolerates empty input', () => {
    expect(assetSrc('')).toBe('');
  });
});
