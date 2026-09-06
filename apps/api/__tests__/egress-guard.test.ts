import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CI guard (mirrors the no-infinite-loading guard): every call to a
 * Cloudflare-fronted foreign vendor from the api side MUST go through
 * `egressFetch` (apps/api/src/egress-fetch.ts) — a raw global `fetch()`/undici
 * `request()` to these hosts 403s from the prod VM's blocked IP
 * (docs/ops/egress-gateway.md). This caught scenario AI dead on prod (2026-07-07);
 * this test stops the whole class from recurring.
 *
 * Not covered here (by design): `@seed/provider-byteplus` clients route through
 * their OWN dispatcher; RU services (login.yandex.ru, smsc.ru, id.vk.com,
 * api.ok.ru) are deliberately DIRECT — they work from the RU IP and routing
 * auth data through a foreign hop is a 152-ФЗ problem.
 */

const FOREIGN_HOSTS =
  /(openrouter\.ai|api\.openai\.com|api\.anthropic\.com|api\.elevenlabs\.io|api\.groq\.com|generativelanguage\.googleapis\.com|api\.kie\.ai|laozhang|atlascloud|bytepluses\.com|dashscope)/;
const RAW_CALL = /\b(fetch|request)\s*\(/;

// Scan the api routes + the prompt-enhancer callers. The byteplus provider
// package is intentionally excluded (its clients carry their own egress).
const SCAN_DIRS = [
  join(__dirname, '..', 'src'),
  join(__dirname, '..', '..', '..', 'packages', 'providers', 'prompt-enhancer', 'src'),
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('egress guard: no raw foreign-vendor fetch from the api side', () => {
  it('every foreign-vendor call goes through egressFetch (not a raw global fetch/request)', () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of tsFiles(dir)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (!FOREIGN_HOSTS.test(line)) return;
          if (!RAW_CALL.test(line)) return; // a bare URL const is fine
          if (/egressFetch\s*\(/.test(line)) return; // wrapped — good
          if (/fetchImpl\s*\(|this\.fetch\s*\(|deps\.fetch/.test(line)) return; // injected fetch — good
          violations.push(`${file.split('/apps/')[1] ?? file}:${i + 1}  ${line.trim()}`);
        });
      }
    }
    expect(
      violations,
      `Raw foreign-vendor call(s) bypassing egress — route through egressFetch ` +
        `(apps/api/src/egress-fetch.ts) or they 403 on prod:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('passes egressFetch into Groq ASR while keeping source media fetch direct', () => {
    const studio = readFileSync(join(__dirname, '..', 'src', 'studio.ts'), 'utf8');
    const groq = readFileSync(
      join(__dirname, '..', '..', '..', 'packages', 'providers', 'asr', 'src', 'groq.ts'),
      'utf8',
    );

    expect(studio).toContain('groqFetch: egressFetch');
    expect(groq).toContain('fetch(audioUrl)');
    expect(groq).toContain('this.apiFetch(GROQ_API');
  });

  it('routes admin provider balance checks through the egress proxy when configured', () => {
    const admin = readFileSync(join(__dirname, '..', 'src', 'admin-panel.ts'), 'utf8');

    expect(admin).toContain('const egress = egressDispatcher(env)');
    expect(admin).toContain('...(egress ? { dispatcher: egress } : {})');
    expect(admin).toContain('https://openrouter.ai/api/v1/credits');
    expect(admin).toContain('https://api.atlascloud.ai/public/v1/balance');
  });
});
