import { describe, expect, it } from 'vitest';
import {
  buildRefMentions,
  imageMentionsInText,
  insertMentionToken,
  mentionQueryBeforeCursor,
} from './ref-mentions';

describe('buildRefMentions', () => {
  it('numbers character stills before location stills before loose image refs', () => {
    const mentions = buildRefMentions([
      { kind: 'image', url: 'https://seed.local/loose.png' },
      {
        kind: 'cast',
        castKind: 'location',
        name: 'Кафе',
        imageUrls: ['https://seed.local/cafe.png'],
      },
      {
        kind: 'cast',
        castKind: 'character',
        name: 'Алиса',
        imageUrls: ['https://seed.local/alice-1.png', 'https://seed.local/alice-2.png'],
      },
    ]);

    expect(mentions.map((m) => [m.token, m.label])).toEqual([
      ['@image1', 'Алиса · кадр 1'],
      ['@image2', 'Алиса · кадр 2'],
      ['@image3', 'Кафе · кадр 1'],
      ['@image4', 'loose.png'],
    ]);
  });

  it('numbers video refs separately and caps refs', () => {
    const mentions = buildRefMentions([
      {
        kind: 'cast',
        castKind: 'character',
        name: 'X',
        imageUrls: Array.from({ length: 12 }, (_, i) => `https://seed.local/${i}.png`),
      },
      { kind: 'video', url: 'https://seed.local/motion-1.mp4' },
      { kind: 'video', url: 'https://seed.local/motion-2.mp4' },
      { kind: 'video', url: 'https://seed.local/motion-3.mp4' },
      { kind: 'video', url: 'https://seed.local/motion-4.mp4' },
    ]);

    expect(mentions.filter((m) => m.kind === 'image')).toHaveLength(9);
    expect(mentions.filter((m) => m.kind === 'video').map((m) => m.token)).toEqual([
      '@video1',
      '@video2',
      '@video3',
    ]);
  });

  it('groups product stills with character stills and labels product motion refs', () => {
    const mentions = buildRefMentions([
      {
        kind: 'cast',
        castKind: 'location',
        name: 'Кафе',
        imageUrls: ['https://seed.local/cafe.png'],
      },
      {
        kind: 'cast',
        castKind: 'character',
        name: 'Алиса',
        imageUrls: ['https://seed.local/alice.png'],
      },
      {
        kind: 'cast',
        castKind: 'product',
        name: 'Бутылка',
        imageUrls: ['https://seed.local/bottle.png'],
        videoUrl: 'https://seed.local/bottle-motion.mp4',
      },
    ]);

    expect(mentions.filter((m) => m.kind === 'image').map((m) => m.label)).toEqual([
      'Алиса · кадр 1',
      'Бутылка · кадр 1',
      'Кафе · кадр 1',
    ]);
    expect(mentions.find((m) => m.kind === 'video')?.label).toBe('Бутылка · движение');
  });
});

describe('mentionQueryBeforeCursor', () => {
  it('returns the active @ query immediately before the cursor', () => {
    expect(mentionQueryBeforeCursor('use @ima', 8)).toEqual({ start: 4, query: 'ima' });
    expect(mentionQueryBeforeCursor('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryBeforeCursor('use @image1 now', 15)).toBeNull();
  });
});

describe('imageMentionsInText', () => {
  it('keeps prompt order and exposes dangling image mentions', () => {
    const mentions = buildRefMentions([
      { kind: 'image', url: 'https://cdn.example/one.png', label: 'Первый кадр' },
      { kind: 'image', url: 'https://cdn.example/two.png', label: 'Второй кадр' },
    ]);

    expect(imageMentionsInText('Use @image2, @image3, then @image2.', mentions)).toEqual([
      { token: '@image2', mention: mentions[1] },
      { token: '@image3', mention: undefined },
    ]);
  });
});

describe('insertMentionToken', () => {
  it('replaces the active query and leaves a trailing space', () => {
    expect(insertMentionToken('use @ima', 4, 8, '@image1')).toEqual({
      text: 'use @image1 ',
      cursor: 12,
    });
  });
});
