import { describe, expect, it } from 'vitest';
import { edgePayloadType, edgeSemanticPayload, PAYLOAD_LABEL } from './edge-payload';

describe('edgePayloadType', () => {
  it('prompt node emits text', () => {
    expect(edgePayloadType({ type: 'prompt', data: { text: 'hi' } })).toBe('text');
    expect(edgePayloadType({ type: 'aiprompt', data: { text: 'draft' } })).toBe('text');
  });

  it('media node emits its media kind', () => {
    expect(edgePayloadType({ type: 'media', data: { mediaKind: 'image' } })).toBe('image');
    expect(edgePayloadType({ type: 'media', data: { mediaKind: 'video' } })).toBe('video');
  });

  it('generate output follows its declared node contract, not a stale result kind', () => {
    expect(
      edgePayloadType({ type: 'generate', data: { mode: 'video', resultKind: 'image' } }),
    ).toBe('video');
    expect(
      edgePayloadType({ type: 'generate', data: { mode: 'image', resultKind: 'video' } }),
    ).toBe('image');
  });

  it('generate node falls back to its mode before a result exists', () => {
    expect(edgePayloadType({ type: 'generate', data: { mode: 'video' } })).toBe('video');
    expect(edgePayloadType({ type: 'generate', data: { mode: 'image' } })).toBe('image');
  });

  it('cast node (Персонаж/Локация) emits image — stills feed image slots', () => {
    expect(edgePayloadType({ type: 'cast', data: { castKind: 'character' } })).toBe('image');
    expect(edgePayloadType({ type: 'cast', data: { castKind: 'location' } })).toBe('image');
  });

  it('scene node emits the scene colour from its real context handle', () => {
    expect(edgePayloadType({ type: 'scene', data: {} }, 'context')).toBe('scene');
    expect(edgeSemanticPayload({ type: 'scene', data: {} }, 'context')).toBe('scene.context');
  });

  it('preserves exact semantic payloads behind the broad colour', () => {
    expect(edgeSemanticPayload({ type: 'media', data: { mediaKind: 'image' } })).toBe(
      'image.reference',
    );
    expect(edgeSemanticPayload({ type: 'media', data: { mediaKind: 'video' } })).toBe(
      'video.motionReference',
    );
    expect(edgeSemanticPayload({ type: 'cast', data: { castKind: 'character' } })).toBe(
      'cast.identityPack',
    );
    expect(edgeSemanticPayload({ type: 'generate', data: { mode: 'video' } })).toBe(
      'video.generated',
    );
  });

  it('unknown / missing sources yield null', () => {
    expect(edgePayloadType(undefined)).toBeNull();
    expect(edgePayloadType({ type: 'note', data: {} })).toBeNull();
  });

  it('every port type has a Russian label', () => {
    expect(PAYLOAD_LABEL).toEqual({
      text: 'текст',
      image: 'картинка',
      video: 'видео',
      scene: 'сцена',
    });
  });
});
