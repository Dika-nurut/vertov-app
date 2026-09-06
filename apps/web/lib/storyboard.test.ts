import { describe, expect, it } from 'vitest';
import { buildStoryboardHtml, shotStill } from './storyboard';
import type { ShotListRow } from './shot-list';

const row = (over: Partial<ShotListRow>): ShotListRow => ({
  id: 'g1',
  shotNumber: 1,
  title: 'Кадр 1',
  prompt: '',
  mode: 'video',
  status: 'idle',
  cast: [],
  locations: [],
  grammarLabel: '',
  ...over,
});

describe('shotStill', () => {
  it('uses the image take directly', () => {
    expect(shotStill(row({ resultKind: 'image', resultUrl: 'http://x/1.png' }))).toBe(
      'http://x/1.png',
    );
  });
  it('uses the last frame for a video take', () => {
    expect(
      shotStill(
        row({ resultKind: 'video', resultUrl: 'http://x/1.mp4', lastFrameUrl: 'http://x/f.png' }),
      ),
    ).toBe('http://x/f.png');
  });
  it('is undefined when there is no take', () => {
    expect(shotStill(row({}))).toBeUndefined();
  });
});

describe('buildStoryboardHtml', () => {
  it('renders one card per shot with number, title, and still', () => {
    const html = buildStoryboardHtml([
      row({ shotNumber: 1, title: 'герой', resultKind: 'image', resultUrl: 'http://x/1.png' }),
      row({ id: 'g2', shotNumber: 2, title: 'крыша', cast: ['Аня'] }),
    ]);
    expect(html).toContain('<img src="http://x/1.png"');
    expect(html).toContain('герой');
    expect(html).toContain('крыша');
    expect(html).toContain('Аня');
    expect(html).toContain('нет дубля'); // shot 2 has no take
    expect((html.match(/<figure class="shot">/g) ?? []).length).toBe(2);
  });

  it('escapes HTML in titles/prompts (no injection)', () => {
    const html = buildStoryboardHtml([row({ title: '<script>x</script>', prompt: 'a & b' })]);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
  });

  it('uses the board title and a valid HTML document shell', () => {
    const html = buildStoryboardHtml([], 'Мой проект');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Мой проект</title>');
    expect(html).toContain('0 кадров');
  });
});
