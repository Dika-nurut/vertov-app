'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { modelDisplayNameFromId } from '@/lib/models';
import type { Gateway, ModelsResp } from '../_lib';
import { kindLabel, pct } from '../_fmt';

const GATEWAY_LABELS: Record<Gateway, string> = {
  atlascloud: 'AtlasCloud',
  openrouter: 'OpenRouter',
  laozhang: 'LaoZhang',
  kie: 'KIE',
};

type GatewayField = 'gatewayOverride' | 'fallbackGateway';
type GatewayValue = Gateway | (string & {}) | null;

interface PendingGatewayChange {
  modelId: string;
  modelLabel: string;
  field: GatewayField;
  from: GatewayValue;
  to: GatewayValue;
  body: Record<string, unknown>;
  requiresForce?: boolean;
  violations?: unknown[];
  error?: string;
}

function gatewayLabel(value: string | null): string {
  if (!value) return 'Нет';
  return GATEWAY_LABELS[value as Gateway] ?? value;
}

function violationLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return 'Маршрут не прошёл проверку.';
  const issue = value as Record<string, unknown>;
  return (
    [issue.field, issue.gateway, issue.reason, issue.message]
      .filter(
        (part): part is string | number => typeof part === 'string' || typeof part === 'number',
      )
      .join(' · ') || 'Маршрут не прошёл проверку.'
  );
}

// isActive toggle + credit-cost edit, each an audited PATCH /v1/admin/models/:id.
export function ModelsTable({ data, apiUrl }: { data: ModelsResp; apiUrl: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pendingGateway, setPendingGateway] = useState<PendingGatewayChange | null>(null);
  const [forceReason, setForceReason] = useState('');
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
        if (res.status === 409 && b?.error === 'gateway_margin_guard') {
          setPendingGateway((current) =>
            current?.modelId === id
              ? (() => {
                  const next = { ...current };
                  delete next.error;
                  return {
                    ...next,
                    requiresForce: true,
                    violations: Array.isArray(b.violations) ? b.violations : [],
                  };
                })()
              : current,
          );
          setForceReason('');
          return;
        }
        const message = typeof b?.message === 'string' ? b.message : (b?.error ?? res.status);
        setErr(`${id}: ${message}`);
        setPendingGateway((current) =>
          current?.modelId === id ? { ...current, error: String(message) } : current,
        );
        return;
      }
      if (b.marginWarning) setErr(`${id}: ⚠ ${b.marginWarning}`);
      setPendingGateway(null);
      router.refresh();
    } catch {
      const message = 'Сеть недоступна.';
      setErr(message);
      setPendingGateway((current) =>
        current?.modelId === id ? { ...current, error: message } : current,
      );
    } finally {
      setBusy(null);
    }
  }

  function requestGatewayChange(
    model: ModelsResp['rows'][number],
    field: GatewayField,
    value: GatewayValue,
  ) {
    const from = model[field];
    if ((from ?? null) === (value ?? null)) return;
    setErr(null);
    setForceReason('');
    setPendingGateway({
      modelId: model.id,
      modelLabel: modelDisplayNameFromId(model.id),
      field,
      from,
      to: value,
      body: { [field]: value },
    });
  }

  async function applyGatewayChange() {
    if (!pendingGateway) return;
    if (pendingGateway.requiresForce && forceReason.trim().length < 3) {
      setPendingGateway((current) =>
        current
          ? { ...current, error: 'Укажите причину исключения (не менее 3 символов).' }
          : current,
      );
      return;
    }
    await patch(
      pendingGateway.modelId,
      pendingGateway.requiresForce
        ? { ...pendingGateway.body, force: true, forceReason: forceReason.trim() }
        : pendingGateway.body,
    );
  }

  return (
    <>
      {err && <p className="mb-3 text-[13px] text-destructive">{err}</p>}
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="[&>th]:border-b-[2.5px] [&>th]:border-line [&>th]:px-3 [&>th]:pb-3 [&>th]:font-mono [&>th]:text-[9.5px] [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-faint">
            <th className="text-left">Модель / ID</th>
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
              <td className="text-left">
                <span className="block text-[12px]">{modelDisplayNameFromId(m.id)}</span>
                <span className="block font-mono text-[10px] text-faint">{m.id}</span>
              </td>
              <td className="text-left font-mono text-[9px] uppercase text-faint">
                {kindLabel(m.kind)}
              </td>
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
                  placeholder={gatewayLabel(m.effectiveGateway)}
                  disabled={busy === m.id}
                  allowNull
                  onChange={(v) => requestGatewayChange(m, 'gatewayOverride', v)}
                />
              </td>
              <td className="text-left">
                <GatewaySelect
                  gateways={gateways.filter((g) => g !== (m.gatewayOverride ?? m.effectiveGateway))}
                  value={m.fallbackGateway}
                  placeholder="Нет"
                  disabled={busy === m.id}
                  allowNull
                  onChange={(v) => requestGatewayChange(m, 'fallbackGateway', v)}
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
                  onClick={() => void patch(m.id, { isActive: !m.isActive })}
                  className={
                    'inline-flex h-6 w-11 items-center border-[2.5px] border-line p-0.5 transition-colors ' +
                    (m.isActive ? 'bg-accent' : 'bg-[color:var(--color-surface2)]')
                  }
                  aria-pressed={m.isActive}
                  aria-label={m.isActive ? 'Отключить модель' : 'Включить модель'}
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
      <Dialog
        open={pendingGateway !== null}
        onOpenChange={(open) => {
          if (!open) setPendingGateway(null);
        }}
      >
        {pendingGateway && (
          <DialogContent data-testid="gateway-change-dialog">
            <DialogHeader>
              <DialogTitle>Подтвердите изменение маршрута</DialogTitle>
              <DialogDescription>
                Изменение применяется к новым задачам этой модели. Уже запущенные задачи не
                меняются.
              </DialogDescription>
            </DialogHeader>
            <div className="border-[2.5px] border-line bg-surface2 p-3 font-mono text-[11px]">
              <p className="font-bold text-fg">{pendingGateway.modelLabel}</p>
              <p className="mt-1 text-faint">ID: {pendingGateway.modelId}</p>
              <p className="mt-3 text-faint">
                {pendingGateway.field === 'gatewayOverride' ? 'Основной шлюз' : 'Резервный шлюз'}:{' '}
                <span className="text-fg">{gatewayLabel(pendingGateway.from)}</span> →{' '}
                <span className="text-fg">{gatewayLabel(pendingGateway.to)}</span>
              </p>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
              <li>Новые задачи будут направляться по выбранной цепочке.</li>
              <li>Изменение попадёт в аудит-лог администратора.</li>
              <li>Маржинальная защита API проверит маршрут перед применением.</li>
            </ul>
            {pendingGateway.requiresForce && (
              <div className="space-y-2 border-[2.5px] border-destructive bg-[color:var(--color-surface)] p-3">
                <p className="text-[13px] font-semibold text-destructive">
                  Маршрут ниже безопасного порога. Для исключения нужна причина.
                </p>
                {pendingGateway.violations && pendingGateway.violations.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-[12px] text-muted-foreground">
                    {pendingGateway.violations.map((violation, index) => (
                      <li key={index}>{violationLabel(violation)}</li>
                    ))}
                  </ul>
                )}
                <label className="block text-[12px] text-fg">
                  Причина исключения
                  <input
                    value={forceReason}
                    onChange={(event) => {
                      setForceReason(event.target.value);
                      setPendingGateway((current) =>
                        current
                          ? (() => {
                              const next = { ...current };
                              delete next.error;
                              return next;
                            })()
                          : current,
                      );
                    }}
                    className="mt-1 min-h-11 w-full border-2 border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
                    placeholder="Например: временный аварийный маршрут"
                  />
                </label>
              </div>
            )}
            {pendingGateway.error && (
              <p role="alert" className="text-[13px] text-destructive">
                {pendingGateway.error}
              </p>
            )}
            <DialogFooter>
              <button
                type="button"
                onClick={() => setPendingGateway(null)}
                className="border-[2.5px] border-line bg-surface2 px-4 py-2.5 text-sm font-bold"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={busy === pendingGateway.modelId}
                onClick={() => void applyGatewayChange()}
                className="border-[2.5px] border-line bg-accent px-4 py-2.5 text-sm font-bold text-[color:var(--color-primary-foreground)] disabled:opacity-60"
              >
                {busy === pendingGateway.modelId
                  ? 'Применяем…'
                  : pendingGateway.requiresForce
                    ? 'Применить исключение'
                    : 'Применить изменение'}
              </button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
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
      value={value !== null && gateways.includes(value as Gateway) ? value : ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : (e.target.value as Gateway))}
      className="w-full border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-1.5 py-1 font-mono text-[11px] outline-none focus:border-line"
    >
      {allowNull && <option value="">{placeholder}</option>}
      {gateways.map((g) => (
        <option key={g} value={g}>
          {GATEWAY_LABELS[g]} · {g}
        </option>
      ))}
    </select>
  );
}
