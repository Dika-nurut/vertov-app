import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_LOOPS, productLoop } from './product-loops';

const publicDir = resolve(__dirname, '../../public');

describe('product loops', () => {
  it('names the four tools in nav order', () => {
    expect(PRODUCT_LOOPS.map((l) => l.label)).toEqual(['Генерация', 'Сценарий', 'Борды', 'Студия']);
  });

  it('ships every loop and its poster from public/', () => {
    for (const l of PRODUCT_LOOPS) {
      expect(existsSync(resolve(publicDir, `.${l.src}`)), l.src).toBe(true);
      expect(existsSync(resolve(publicDir, `.${l.webm}`)), l.webm).toBe(true);
      expect(existsSync(resolve(publicDir, `.${l.poster}`)), l.poster).toBe(true);
    }
  });

  it('keeps each loop light enough for the landing (≤ 2 MB video, ≤ 150 KB poster)', () => {
    for (const l of PRODUCT_LOOPS) {
      expect(statSync(resolve(publicDir, `.${l.src}`)).size, l.src).toBeLessThanOrEqual(2_000_000);
      expect(statSync(resolve(publicDir, `.${l.webm}`)).size, l.webm).toBeLessThanOrEqual(
        2_000_000,
      );
      expect(statSync(resolve(publicDir, `.${l.poster}`)).size, l.poster).toBeLessThanOrEqual(
        150_000,
      );
    }
  });

  it('points the Студия loop at the projects list, as the home tile does', () => {
    expect(productLoop('studio').href).toBe('/studio/projects');
  });
});
