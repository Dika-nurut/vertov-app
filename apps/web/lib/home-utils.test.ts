import { describe, expect, it } from 'vitest';
import { assignVitrinaSizes, plural } from './home-utils';

describe('plural (Russian)', () => {
  const forms: [string, string, string] = ['кадр', 'кадра', 'кадров'];
  it('picks the "one" form for n%10==1 except 11', () => {
    expect(plural(1, forms)).toBe('кадр');
    expect(plural(21, forms)).toBe('кадр');
    expect(plural(101, forms)).toBe('кадр');
    expect(plural(11, forms)).toBe('кадров'); // the 11 exception
  });
  it('picks the "few" form for n%10 in 2..4 except 12..14', () => {
    expect(plural(2, forms)).toBe('кадра');
    expect(plural(3, forms)).toBe('кадра');
    expect(plural(34, forms)).toBe('кадра');
    expect(plural(12, forms)).toBe('кадров'); // 12..14 exception
    expect(plural(13, forms)).toBe('кадров');
    expect(plural(14, forms)).toBe('кадров');
  });
  it('picks the "many" form otherwise', () => {
    expect(plural(0, forms)).toBe('кадров');
    expect(plural(5, forms)).toBe('кадров');
    expect(plural(128, forms)).toBe('кадров');
  });
});

describe('assignVitrinaSizes', () => {
  it('gives images BIG sizes and videos always SMALL sizes', () => {
    const sizes = assignVitrinaSizes(['image', 'video', 'video', 'image', 'video']);
    expect(sizes[0]).toMatch(/^v-i-/); // image → big/tall/mid
    expect(sizes[1]).toMatch(/^v-v-/); // video → small
    expect(sizes[2]).toMatch(/^v-v-/);
    expect(sizes[3]).toMatch(/^v-i-/);
    expect(sizes[4]).toMatch(/^v-v-/);
  });
  it('preserves length and cycles per-kind independently', () => {
    const kinds = Array.from(
      { length: 12 },
      (_, i) => (i % 2 ? 'video' : 'image') as 'video' | 'image',
    );
    const sizes = assignVitrinaSizes(kinds);
    expect(sizes).toHaveLength(12);
    // every image cell is an image-size, every video cell a video-size
    kinds.forEach((k, i) => expect(sizes[i]).toMatch(k === 'image' ? /^v-i-/ : /^v-v-/));
  });
});
