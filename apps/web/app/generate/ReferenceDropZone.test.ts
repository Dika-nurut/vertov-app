import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  hasAcceptedReferenceMedia,
  ReferenceDropZone,
  referenceRequiredCopy,
  type MediaLimits,
} from './ReferenceDropZone';
import { videoMediaLimits, type ModelCardSource } from '../../lib/generate-model-cards';

const noVideoReferenceModel: ModelCardSource = {
  id: 'seedance-2-0-reference-to-video',
  family: 'seedance',
  variant: '2.0-reference',
  kind: 'video',
  capabilities: {
    reference: true,
    maxRefs: 9,
    maxVideoRefs: 0,
    maxAudioRefs: 3,
  },
};
const videoReferenceModel: ModelCardSource = {
  ...noVideoReferenceModel,
  id: 'synthetic-video-reference-model',
  capabilities: { ...noVideoReferenceModel.capabilities, maxVideoRefs: 3 },
};

function renderDropZone(limits: MediaLimits): string {
  return renderToStaticMarkup(
    createElement(ReferenceDropZone, {
      apiUrl: 'http://localhost:3000',
      assetSrc: (url: string) => url,
      images: [],
      videos: [],
      audios: [],
      onChange: () => undefined,
      limits,
      role: 'reference',
    }),
  );
}

describe('ReferenceDropZone media affordances', () => {
  it.each([
    {
      name: 'image and audio references without video',
      limits: videoMediaLimits(noVideoReferenceModel),
      included: ['Референсы', 'до 9 фото', 'звук', 'image/*,audio/*'],
      excluded: ['видео', 'video/*'],
      requiredCopy: 'Добавь референс — фото или звук.',
    },
    {
      name: 'a model that accepts video references',
      limits: videoMediaLimits(videoReferenceModel),
      included: ['до 9 фото', 'видео', 'звук', 'image/*,video/*,audio/*'],
      excluded: [],
      requiredCopy: 'Добавь референс — фото, видео или звук.',
    },
  ])('$name advertises only accepted kinds', ({ limits, included, excluded, requiredCopy }) => {
    const markup = renderDropZone(limits);

    for (const text of included) expect(markup).toContain(text);
    for (const text of excluded) expect(markup).not.toContain(text);
    expect(referenceRequiredCopy(limits)).toBe(requiredCopy);
  });

  it('accepts audio alone for an r2v model that advertises audio but no video', () => {
    expect(
      hasAcceptedReferenceMedia(videoMediaLimits(noVideoReferenceModel), {
        images: [],
        videos: [],
        audios: ['reference.mp3'],
      }),
    ).toBe(true);
  });

  it('accepts images alone for a video-capable reference model', () => {
    expect(
      hasAcceptedReferenceMedia(videoMediaLimits(videoReferenceModel), {
        images: ['reference.png'],
        videos: [],
        audios: [],
      }),
    ).toBe(true);
  });
});
