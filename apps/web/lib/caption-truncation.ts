// Export schema caps texts at 12 (apps/api/src/studio.ts). When an .srt import
// or auto-caption run produces more cues than fit alongside the existing text
// track, we still keep the first `room` captions (partial results are useful)
// but the user must be told — silently dropping captions makes exports look
// complete when they aren't. Builds that user-visible message.
export function truncationMessage(
  added: number,
  total: number,
  kind: 'srt' | 'auto',
): string | null {
  if (added >= total) return null;
  const verb = kind === 'srt' ? 'Импортировано' : 'Распознано';
  return `${verb} ${added} из ${total} реплик — экспорт ограничен 12 субтитрами. Остальные не попадут в рендер.`;
}
