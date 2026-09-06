import { describe, expect, it } from 'vitest';
import { truncationMessage } from './caption-truncation';

describe('truncationMessage', () => {
  it('returns null when every caption fit (nothing was dropped)', () => {
    expect(truncationMessage(5, 5, 'srt')).toBeNull();
    expect(truncationMessage(0, 0, 'auto')).toBeNull();
  });

  it('surfaces a visible message for a partial srt import', () => {
    expect(truncationMessage(12, 15, 'srt')).toBe(
      'Импортировано 12 из 15 реплик — экспорт ограничен 12 субтитрами. Остальные не попадут в рендер.',
    );
  });

  it('surfaces a visible message for a partial auto-caption run', () => {
    expect(truncationMessage(3, 20, 'auto')).toBe(
      'Распознано 3 из 20 реплик — экспорт ограничен 12 субтитрами. Остальные не попадут в рендер.',
    );
  });

  it('surfaces a message even when nothing fit (full drop)', () => {
    expect(truncationMessage(0, 4, 'srt')).toBe(
      'Импортировано 0 из 4 реплик — экспорт ограничен 12 субтитрами. Остальные не попадут в рендер.',
    );
  });
});
