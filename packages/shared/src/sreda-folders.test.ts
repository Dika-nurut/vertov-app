import { describe, expect, it } from 'vitest';
import {
  SREDA_FOLDER_NAME_MAX_LENGTH,
  sredaFolderCreateSchema,
  sredaFolderPatchSchema,
  validateSredaFolderName,
} from './sreda-folders';

describe('Sreda folder contract', () => {
  it('normalizes valid names consistently', () => {
    expect(sredaFolderCreateSchema.parse({ name: '  Референсы  ', parentId: null })).toEqual({
      name: 'Референсы',
      parentId: null,
    });
    expect(validateSredaFolderName('  Монтаж  ')).toEqual({ ok: true, name: 'Монтаж' });
  });

  it.each(['', '   ', '.', '..', 'Кадры/финал', 'Кадры\\финал', 'Кадры\nфинал'])(
    'rejects an unsafe or ambiguous name: %j',
    (name) => {
      expect(sredaFolderCreateSchema.safeParse({ name }).success).toBe(false);
      expect(validateSredaFolderName(name).ok).toBe(false);
    },
  );

  it('enforces the same length and non-empty patch rules', () => {
    expect(
      sredaFolderCreateSchema.safeParse({ name: 'x'.repeat(SREDA_FOLDER_NAME_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(sredaFolderPatchSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(sredaFolderPatchSchema.parse({ name: '  Версия 2 ', expectedVersion: 3 })).toMatchObject(
      { name: 'Версия 2', expectedVersion: 3 },
    );
  });
});
