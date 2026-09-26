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

const TIER_LABELS: Record<string, string> = {
  free: 'Free',
  start: 'Старт',
  creator: 'Креатор',
  studio: 'Студия',
  plus: 'Плюс',
  pro: 'Про',
  max: 'Макс',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Активен',
  banned: 'Заблокирован',
  deleted: 'Удалён',
  trialing: 'Пробный период',
  past_due: 'Просрочен',
  canceled: 'Отменён',
  succeeded: 'Успешно',
  failed: 'Ошибка',
  refunded: 'Возврат',
  queued: 'В очереди',
  running: 'В работе',
  pending: 'Ожидает',
  processing: 'В обработке',
};

const KIND_LABELS: Record<string, string> = {
  image: 'Изображение',
  'image-edit': 'Редактирование изображения',
  video: 'Видео',
  audio: 'Аудио',
  text: 'Текст',
};

export function tierLabel(value: string): string {
  return TIER_LABELS[value] ?? value;
}

export function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? value;
}

export function kindLabel(value: string): string {
  return KIND_LABELS[value] ?? value;
}
