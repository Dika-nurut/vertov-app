'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Gateway, ModelsResp } from '../_lib';
import { pct } from '../_fmt';

// isActive toggle + credit-cost edit, each an audited PATCH /v1/admin/models/:id.
export function ModelsTable({ data, apiUrl }: { data: ModelsResp; apiUrl: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const gateways = data.gateways;

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setErr(null);
    try {
      const res = await fetch(`${apiUrl}/v1/admin/models/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(`${id}: ${b?.error ?? res.status}`);
        return;
      }
      if (b.marginWarning) setErr(`${id}: ⚠ ${b.marginWarning}`);
      router.refresh();
    } catch {
      setErr('Сеть недоступна.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {err && <p className="mb-3 text-[13px] text-destructive">{err}</p>}
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="[&>th]:border-b-[2.5px] [&>th]:border-line [&>th]:px-3 [&>th]:pb-3 [&>th]:font-mono [&>th]:text-[9.5px] [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-faint">
            <th className="text-left">Модель</th>
            <th className="text-left">Тип</th>
            <th className="text-right">Workbook COGS</th>
            <th className="text-right">Маржа SSOT</th>
            <th className="text-left">API (основной)</th>
            <th className="text-left">Фолбэк</th>
            <th className="text-right">Фолбэк 7д</th>
            <th className="text-center">Активна</th>
          </tr>
        </thead>
        <tbody className="[&>tr>td]:border-b-[2.5px] [&>tr>td]:border-[color:var(--color-line-soft)] [&>tr>td]:px-3 [&>tr>td]:py-2.5 [&>tr:last-child>td]:border-b-0">
          {data.rows.map((m) => (
            <tr key={m.id} className={busy === m.id ? 'opacity-50' : ''}>
              <td className="text-left font-mono text-[12px]">{m.id}</td>
              <td className="text-left font-mono text-[9px] uppercase text-faint">{m.kind}</td>
              <td
                className="text-right tabular-nums text-faint"
                title="Legacy capability field; not used for workbook margin"
              >
                {m.priceUsdPerUnit == null ? '—' : `$${m.priceUsdPerUnit}`}
              </td>
              <td className="text-right tabular-nums text-faint">
                {m.workbookPricePointCount ? `${m.workbookPricePointCount} signed rung(s)` : '—'}
              </td>
              <td className="text-right">
                {m.marginPct == null ? (
                  <span
                    className="font-mono text-faint"
                    title="No complete signed workbook COGS coverage"
                  >
                    uncosted
                  </span>
                ) : (
                  <span
                    className={
                      'inline-block px-2 py-0.5 font-mono font-bold ' +
                      (m.marginPct >= 0.3
                        ? 'bg-positive text-[color:var(--color-positive-foreground)]'
                        : 'bg-destructive text-[color:var(--color-destructive-foreground)]')
                    }
                  >
                    {pct(m.marginPct, 0)}
                  </span>
                )}
              </td>
              <td className="text-left">
                <GatewaySelect
                  gateways={gateways}
                  value={m.gatewayOverride}
                  placeholder={m.effectiveGateway}
                  disabled={busy === m.id}
                  allowNull
                  onChange={(v) => patch(m.id, { gatewayOverride: v })}
                />
              </td>
              <td className="text-left">
                <GatewaySelect
                  gateways={gateways.filter((g) => g !== (m.gatewayOverride ?? m.effectiveGateway))}
                  value={m.fallbackGateway}
                  placeholder="— нет —"
                  disabled={busy === m.id}
                  allowNull
                  onChange={(v) => patch(m.id, { fallbackGateway: v })}
                />
              </td>
              <td className="text-right font-mono text-[11px] text-faint">
                {m.fallbackUsage7d && m.fallbackUsage7d.total > 0
                  ? `${m.fallbackUsage7d.fellBack}/${m.fallbackUsage7d.total}`
                  : '—'}
              </td>
              <td className="text-center">
                <button
                  type="button"
                  disabled={busy === m.id}
                  onClick={() => patch(m.id, { isActive: !m.isActive })}
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function GatewaySelect({
  gateways,
  value,
  placeholder,
  disabled,
  allowNull,
  onChange,
}: {
  gateways: readonly Gateway[];
  // A legacy stored chain label is displayed as the current value but no
  // longer appears among the options; picking anything re-pins the row.
  value: Gateway | (string & {}) | null;
  placeholder: string;
  disabled: boolean;
  allowNull: boolean;
  onChange: (v: Gateway | null) => void;
}) {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : (e.target.value as Gateway))}
      className="w-full border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-1.5 py-1 font-mono text-[11px] outline-none focus:border-line"
    >
      {allowNull && <option value="">{placeholder}</option>}
      {gateways.map((g) => (
        <option key={g} value={g}>
          {g}
        </option>
      ))}
    </select>
  );
}
