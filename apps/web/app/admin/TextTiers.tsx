'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProviderBalancesResp } from './_lib';
import { dt } from './_fmt';

type TextTier = NonNullable<ProviderBalancesResp['textModels']>[number];

// «Сценарий» text-tier cards with the admin ON/OFF switch — same idiom as the
// generation models table (audited PATCH, then router.refresh()).
export function TextTiers({ items, apiUrl }: { items: TextTier[]; apiUrl: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(t: TextTier) {
    setBusy(t.id);
    setErr(null);
    try {
      const res = await fetch(`${apiUrl}/v1/admin/text-tiers/${encodeURIComponent(t.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isActive: !t.isActive }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(`${t.id}: ${b?.error ?? res.status}`);
        return;
      }
      router.refresh();
    } catch {
      setErr('Сеть недоступна.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3.5">
      {err && <p className="mb-2 text-[13px] text-destructive">{err}</p>}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        {items.map((m) => (
          <div
            key={m.id}
            className={
              'border-[2.5px] bg-surface p-4 ' +
              (m.isActive
                ? 'border-[color:var(--color-line-soft)]'
                : 'border-[color:var(--color-line-soft)] opacity-60')
            }
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
                {m.labelRu} · текст
              </span>
              <span className="bg-accent2 px-1.5 font-mono text-[8px] uppercase text-[color:var(--color-accent2-foreground)]">
                {m.route.primary === 'kie' ? 'kie → openrouter' : 'openrouter'}
              </span>
            </div>
            <div className="my-1.5 truncate font-mono text-[12px]" title={m.model}>
              {m.model}
            </div>
            <div className="font-mono text-[10px] text-faint">
              OR ${m.priceUsdPerMTok.input}/${m.priceUsdPerMTok.output} ·{' '}
              {m.creditsPerCall['project']} кр/чат
              {m.route.kiePriceUsdPerMTok &&
                ` · kie $${m.route.kiePriceUsdPerMTok.input}/$${m.route.kiePriceUsdPerMTok.output}`}
            </div>
            <div className="mt-3 flex items-center justify-between border-t-2 border-[color:var(--color-line-soft)] pt-2.5">
              <span className="font-mono text-[9px] uppercase tracking-widest text-faint">
                {m.isActive ? 'включён' : `выключен · ${dt(m.updatedAt)}`}
              </span>
              <button
                type="button"
                disabled={busy === m.id}
                onClick={() => toggle(m)}
                className={
                  'inline-flex h-6 w-11 items-center border-[2.5px] border-line p-0.5 transition-colors ' +
                  (m.isActive ? 'bg-accent' : 'bg-[color:var(--color-surface2)]')
                }
                aria-pressed={m.isActive}
                title={m.isActive ? 'Выключить' : 'Включить'}
              >
                <span
                  className={
                    'size-4 bg-line transition-transform ' + (m.isActive ? 'translate-x-4' : '')
                  }
                />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
