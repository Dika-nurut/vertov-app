import { describe, expect, it } from 'vitest';
import {
  connectOffers,
  dropOfferValidationData,
  type DropOffer,
} from '../app/boards/[id]/BoardNodes';

describe('connectOffers', () => {
  it('does not offer another scene for an occupied AI-prompt scene input', () => {
    const origin = { type: 'aiprompt', data: {} } as const;
    const existingInputs = [
      {
        source: { type: 'scene' as const, data: {} },
        sourceHandle: 'context',
        targetHandle: 'scene',
      },
    ];

    expect(connectOffers(origin, 'scene', 'target', () => undefined, existingInputs)).toEqual([]);
    expect(connectOffers(origin, 'scene', 'target', () => undefined)).toHaveLength(1);
  });

  it('offers scene→cast in both directions and honours cast occupancy', () => {
    expect(connectOffers({ type: 'cast', data: {} }, 'scene', 'target', () => undefined)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'scene', t: 'scene' })]),
    );
    expect(
      connectOffers({ type: 'scene', data: {} }, 'context', 'source', () => undefined),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'cast-character', t: 'cast' })]),
    );
    expect(
      connectOffers({ type: 'cast', data: {} }, 'scene', 'target', () => undefined, [
        { source: { type: 'scene', data: {} }, sourceHandle: 'context', targetHandle: 'scene' },
      ]),
    ).toEqual([]);
  });

  it('validates a planned cast edge with one placeholder without mutating persisted data', () => {
    const data = { castKind: 'product', imageUrls: [] };
    const offer = { t: 'cast', wire: 'newSource' } as Pick<DropOffer, 't' | 'wire'>;

    expect(dropOfferValidationData(offer, data)).toEqual({
      castKind: 'product',
      imageUrls: ['planned-ref'],
    });
    expect(data.imageUrls).toEqual([]);
    expect(dropOfferValidationData({ t: 'cast', wire: 'newTarget' }, data)).toBe(data);
  });

  it('never offers connections from organizer-only text or frame nodes', () => {
    for (const type of ['text', 'frame'] as const) {
      expect(connectOffers({ type, data: {} }, null, 'source', () => undefined)).toEqual([]);
      expect(connectOffers({ type, data: {} }, null, 'target', () => undefined)).toEqual([]);
    }
  });
});
