import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, 'copy');

describe('public payment-provider copy', () => {
  it('names the current Tochka acquiring service in every legal locale', () => {
    for (const locale of ['en', 'ru']) {
      for (const page of ['offer', 'privacy', 'requisites']) {
        const text = readFileSync(join(ROOT, locale, `${page}.md`), 'utf8');
        expect(text, `${locale}/${page}`).toMatch(/Tochka Bank|Точка Банка/);
        expect(text, `${locale}/${page}`).not.toMatch(/YooKassa|ЮKassa/);
      }
    }
  });

  it('does not advertise the retired provider in the public pricing surfaces', () => {
    const pricing = readFileSync(join(__dirname, '../pricing/PricingClient.tsx'), 'utf8');
    const faq = readFileSync(join(__dirname, '../pricing/plan-content.ts'), 'utf8');
    expect(pricing).toContain('Точка Банк');
    expect(faq).toContain('Точка Банка');
    expect(`${pricing}\n${faq}`).not.toMatch(/ЮKassa|YooKassa/);
  });
});
