// Pure, client-safe helpers. NO server imports — safe to import from client
// components. (_lib.ts pulls in server-api/next/headers and must NOT be imported
// into a client bundle.)

export const WINDOWS = [7, 30, 90] as const;
export function parseDays(raw: string | string[] | undefined, fallback = 30): number {
  const v = Number(Array.isArray(raw) ? raw[0] : raw);
  return WINDOWS.includes(v as (typeof WINDOWS)[number]) ? v : fallback;
}

export function n(x: number): string {
  return Math.round(x).toLocaleString('ru-RU');
}
export function rub(x: number): string {
  return `${n(x)} ₽`;
}
export function pct(x: number | null, digits = 1): string {
  return x == null ? '—' : `${(x * 100).toFixed(digits)}%`;
}
export function ms(x: number | null): string {
  return x == null ? '—' : n(x);
}
export function dt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
