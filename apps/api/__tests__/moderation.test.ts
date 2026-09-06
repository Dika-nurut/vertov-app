import { describe, expect, it } from 'vitest';
import { screenPrompt } from '../src/moderation';

/**
 * M-1 — prompt pre-screen. The contract is deliberately narrow: block ONLY
 * child-sexual-exploitation (CSAE), in EN and RU, and let everything else
 * through (adult/NSFW, violence, etc. are the model's job). These tests pin both
 * halves: the severe cases MUST block, and benign-but-adjacent prompts MUST NOT
 * (the false-positive guard is the whole point of a severe-only screen).
 */

describe('screenPrompt — blocks severe CSAE (must-block)', () => {
  it.each([
    // standalone, unambiguous terms
    'lolicon illustration',
    'shotacon art',
    'a loli character, anime style',
    'child porn',
    'child-porn cartoon',
    'CSAM',
    'pedophilia themed',
    // RU standalone
    'детское порно',
    'детская порнография',
    'порно с детьми',
    'педофилия',
    // EN minor + sexual in proximity
    'a naked child on a beach',
    'nude toddler photo',
    'sexual content with a 12yo',
    'topless schoolgirl',
    // RU minor + sexual in proximity
    'голый ребёнок',
    'обнажённая школьница',
    'секс с несовершеннолетней',
  ])('blocks %j', (prompt) => {
    expect(screenPrompt(prompt)).toEqual({ blocked: true, category: 'csae' });
  });

  it('sees through punctuation obfuscation (child_porn / child—porn → child porn)', () => {
    expect(screenPrompt('child_porn cartoon').blocked).toBe(true);
    expect(screenPrompt('child—porn').blocked).toBe(true);
    expect(screenPrompt('CHILD.PORN').blocked).toBe(true);
  });

  it('is case-insensitive and diacritic-insensitive (ё→е)', () => {
    expect(screenPrompt('ГОЛЫЙ РЕБЁНОК').blocked).toBe(true);
  });
});

describe('screenPrompt — lets benign + adult content through (must-NOT-block)', () => {
  it.each([
    '',
    'a child playing in a sunny park',
    "children's book illustration, watercolor",
    'a teenager skateboarding at sunset',
    'школьница идёт в школу с рюкзаком',
    'ребёнок рисует красками',
    // adult/NSFW is intentionally NOT our job — models self-moderate it
    'a nude figure study, classical oil painting',
    'sexy red dress on a fashion model',
    'голая натурщица, академический рисунок',
    'erotic art, tasteful, adult',
    // co-mention far apart must not trip the proximity gate
    "a children's bookstore on one side of the street, and far away a poster for an adult nightclub with a sexy neon sign",
    // unrelated words that share a Cyrillic stem with sexual terms
    'забил гол в ворота на стадионе', // гол = goal, not голый
    'у него болит голова и пропал голос', // голова/голос
  ])('allows %j', (prompt) => {
    expect(screenPrompt(prompt).blocked).toBe(false);
  });
});
