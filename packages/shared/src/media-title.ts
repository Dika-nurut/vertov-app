export const MEDIA_TITLE_MAX_LENGTH = 96;
export const UNTITLED_MEDIA_LABEL = 'Материал без названия';

type MediaKind = 'image' | 'video' | 'audio';

function compact(value: string | null | undefined): string {
  return value?.replace(/\s+/gu, ' ').trim() ?? '';
}

function bounded(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  if (maxLength <= 1) return characters.slice(0, maxLength).join('');
  return `${characters
    .slice(0, maxLength - 1)
    .join('')
    .trimEnd()}…`;
}

/** Stable persisted title; sibling outputs use a readable deterministic ordinal. */
export function generatedMediaTitle(input: {
  prompt?: string | null;
  kind: MediaKind;
  outputIndex?: number;
  outputCount?: number;
}): string {
  const fallback =
    input.kind === 'video'
      ? 'Сгенерированное видео'
      : input.kind === 'audio'
        ? 'Сгенерированное аудио'
        : 'Сгенерированное изображение';
  const base = compact(input.prompt) || fallback;
  const count = Math.max(1, Math.trunc(input.outputCount ?? 1));
  const index = Math.min(count, Math.max(1, Math.trunc(input.outputIndex ?? 1)));
  const suffix = count > 1 ? ` · ${index} из ${count}` : '';
  return `${bounded(base, MEDIA_TITLE_MAX_LENGTH - Array.from(suffix).length)}${suffix}`;
}

/** Canonical label for generated, uploaded, and legacy media surfaces. */
export function mediaDisplayTitle(input: {
  title?: string | null;
  originalName?: string | null;
}): string {
  return compact(input.title) || compact(input.originalName) || UNTITLED_MEDIA_LABEL;
}
