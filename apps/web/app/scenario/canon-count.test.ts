import { describe, expect, it } from 'vitest';
import { canonCount, type MaterialsList, type MemoryNote } from './_lib';

describe('canonCount', () => {
  it('counts notes and attached files together', () => {
    const notes: MemoryNote[] = [
      { id: 'included', content: 'Вечный дождь', includeInAi: true },
      { id: 'excluded', content: 'Старый вариант', includeInAi: false },
    ];
    const materials: MaterialsList = {
      items: [
        {
          id: 'file',
          name: 'canon.md',
          chars: 42,
          includeInAi: 1,
          createdAt: '',
          updatedAt: '',
        },
      ],
      totalChars: 42,
    };

    expect(canonCount(notes, materials)).toBe(3);
  });

  it('counts a file-only canon', () => {
    const materials: MaterialsList = {
      items: [
        {
          id: 'file',
          name: 'canon.md',
          chars: 42,
          includeInAi: 1,
          createdAt: '',
          updatedAt: '',
        },
      ],
      totalChars: 42,
    };

    expect(canonCount([], materials)).toBe(1);
  });
});
