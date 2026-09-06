import { describe, expect, it } from 'vitest';
import { buildShotPlanPrompt, type ShotPlanPromptCastEntry } from '../src/shot-plan-prompt';

const CAST_EMPTY_INSTRUCTION = '«castNodeIds» оставляй пустым';
const LOCATION_EMPTY_INSTRUCTION = '«locationNodeId» опускай';

const character: ShotPlanPromptCastEntry = {
  id: 'character-1',
  castKind: 'character',
  name: 'Алиса',
};
const product: ShotPlanPromptCastEntry = {
  id: 'product-1',
  castKind: 'product',
  name: 'Красный велосипед',
};
const location: ShotPlanPromptCastEntry = {
  id: 'location-1',
  castKind: 'location',
  name: 'Кафе у моря',
};

function promptFor(dictionary: readonly ShotPlanPromptCastEntry[]): string {
  return buildShotPlanPrompt({
    memory: '',
    dictionary,
    scenes: [
      {
        sceneNodeId: 'scene-1',
        title: 'Тестовая сцена',
        sourceText: 'Алиса идёт по улице.',
      },
    ],
    maxShotsPerScene: 4,
  }).user;
}

function expectLocationInstructionIndependentOfCast(
  dictionary: readonly ShotPlanPromptCastEntry[],
): void {
  const withoutLocation = promptFor(dictionary);
  expect(withoutLocation).toContain(`Локаций на борде нет — ${LOCATION_EMPTY_INSTRUCTION}.`);

  const withLocation = promptFor([...dictionary, location]);
  expect(withLocation).toContain('Локации:\n- location-1 — Кафе у моря');
  expect(withLocation).not.toContain(LOCATION_EMPTY_INSTRUCTION);
}

describe('buildShotPlanPrompt cast dictionary', () => {
  it('characters only lists Персонажи without Товары or an empty cast instruction', () => {
    const user = promptFor([character]);

    expect(user).toContain('Персонажи:\n- character-1 — Алиса');
    expect(user).not.toContain('Товары:');
    expect(user).not.toContain(CAST_EMPTY_INSTRUCTION);
    expectLocationInstructionIndependentOfCast([character]);
  });

  it('products only lists Товары without Персонажи or an empty cast instruction', () => {
    const user = promptFor([product]);

    expect(user).toContain('Товары:\n- product-1 — Красный велосипед');
    expect(user).not.toContain('Персонажи:');
    expect(user).not.toContain(CAST_EMPTY_INSTRUCTION);
    expectLocationInstructionIndependentOfCast([product]);
  });

  it('characters and products list both sections with products after characters', () => {
    const user = promptFor([character, product]);

    expect(user).toContain('Персонажи:\n- character-1 — Алиса');
    expect(user).toContain('Товары:\n- product-1 — Красный велосипед');
    expect(user.indexOf('Персонажи:')).toBeLessThan(user.indexOf('Товары:'));
    expect(user).not.toContain(CAST_EMPTY_INSTRUCTION);
    expectLocationInstructionIndependentOfCast([character, product]);
  });

  it('neither characters nor products gives the empty cast instruction', () => {
    const user = promptFor([]);

    expect(user).not.toContain('Персонажи:');
    expect(user).not.toContain('Товары:');
    expect(user).toContain(`Персонажей и товаров на борде нет — ${CAST_EMPTY_INSTRUCTION}.`);
    expectLocationInstructionIndependentOfCast([]);
  });
});
