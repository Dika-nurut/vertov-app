import { describe, expect, it } from 'vitest';
import { validateBoardCommit } from './board-commit-guard';

function boardWithNote(text: string) {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'note-1',
        type: 'note',
        version: 1,
        position: { x: 0, y: 0 },
        data: { text },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    tray: [],
  };
}

describe('board commit guard', () => {
  it('accepts a document that parses and fits', () => {
    expect(validateBoardCommit(boardWithNote('коротко'))).toEqual({ ok: true });
  });

  it('refuses a document the board schema rejects', () => {
    const broken = { ...boardWithNote('ok'), nodes: [{ id: 'x', type: 'note' }] };

    expect(validateBoardCommit(broken)).toEqual({
      ok: false,
      reason: 'Изменение не прошло проверку борда.',
    });
  });

  it('refuses a document that would exceed the persisted 1 MiB limit', () => {
    const nodes = Array.from({ length: 60 }, (_, index) => ({
      id: `note-${index}`,
      type: 'note',
      version: 1,
      position: { x: index, y: index },
      data: { text: 'я'.repeat(20_000) },
    }));

    const result = validateBoardCommit({ ...boardWithNote('ok'), nodes });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('1 МиБ');
  });
});
