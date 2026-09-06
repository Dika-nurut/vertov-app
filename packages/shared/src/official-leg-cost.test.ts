import { describe, expect, it } from 'vitest';
import {
  officialLegCost,
  officialLegCostForRung,
  officialLegRung,
  officialLegSlug,
} from './official-leg-cost';

/**
 * The third leg of the image chain is priced per RUNG, unlike legs 0 and 1 which
 * carry one scalar each. We hold exactly one invoice figure —
 * `gemini-3-pro-image` @ 4K = $0.241344 — so every other rung is uncosted and
 * must refuse rather than route (finance ruling 2026-08-02, Ask 8).
 */

const NANO_BANANA_PRO_CAPS = {
  resolutions: ['1K', '2K', '4K'],
  openrouterFallbackSlug: 'google/gemini-3-pro-image',
  officialUsdPerUnit: { '4K': 0.241344 },
};

describe('which rung a request lands on', () => {
  it('reads the resolution the customer asked for', () => {
    expect(officialLegRung(NANO_BANANA_PRO_CAPS, { resolution: '4K' }, 'image')).toBe('4K');
  });

  it('accepts the legacy image `quality` alias, like the price selector does', () => {
    expect(officialLegRung(NANO_BANANA_PRO_CAPS, { quality: '2K' }, 'image')).toBe('2K');
  });

  it('ignores `quality` on video, where it is not a price dimension', () => {
    expect(officialLegRung({ resolutions: ['720p'] }, { quality: '480p' }, 'video')).toBe(
      'default',
    );
  });

  it('is `default` for a row that declares no resolution axis', () => {
    // gemini-2-5-flash-image and the flash-lite row are fixed at 1K; an empty
    // `resolutions` list is a contract, so a crafted param cannot invent a rung.
    expect(officialLegRung({ resolutions: [] }, { resolution: '4K' }, 'image')).toBe('default');
  });
});

describe('what the leg costs, and when it refuses to say', () => {
  it('gives the invoiced 4K figure for Nano Banana Pro', () => {
    expect(officialLegCost(NANO_BANANA_PRO_CAPS, { resolution: '4K' }, 'image')).toEqual({
      rung: '4K',
      usdPerUnit: 0.241344,
    });
  });

  it('has no figure for the 1K rung of that same row', () => {
    expect(officialLegCost(NANO_BANANA_PRO_CAPS, { resolution: '1K' }, 'image')).toEqual({
      rung: '1K',
      usdPerUnit: null,
    });
  });

  it('has no figure for a row that carries no cost map', () => {
    expect(
      officialLegCost(
        { resolutions: ['1K'], openrouterFallbackSlug: 'google/gemini-3.1-flash-image' },
        { resolution: '1K' },
        'image',
      ),
    ).toEqual({ rung: '1K', usdPerUnit: null });
  });

  it('rejects a scalar cost written in the shape legs 0 and 1 use', () => {
    // `priceUsdPerUnit` / `fallbackUsdPerUnit` are scalars, so this is an easy
    // mistake to make. Reading it as "applies to every rung" would re-introduce
    // exactly the blind rate this work exists to remove.
    expect(
      officialLegCost(
        { ...NANO_BANANA_PRO_CAPS, officialUsdPerUnit: 0.241344 },
        { resolution: '4K' },
      ),
    ).toEqual({ rung: '4K', usdPerUnit: null });
  });

  it('rejects a zero or negative rate', () => {
    expect(
      officialLegCost(
        { ...NANO_BANANA_PRO_CAPS, officialUsdPerUnit: { '4K': 0 } },
        {
          resolution: '4K',
        },
      ).usdPerUnit,
    ).toBeNull();
  });
});

describe('opting a row into the leg', () => {
  it('is the presence of an official slug on the row', () => {
    expect(officialLegSlug(NANO_BANANA_PRO_CAPS)).toBe('google/gemini-3-pro-image');
  });

  it('is absent for a row that never asked for the leg', () => {
    expect(officialLegSlug({ resolutions: [] })).toBeNull();
    expect(officialLegSlug(null)).toBeNull();
    expect(officialLegSlug({ openrouterFallbackSlug: '' })).toBeNull();
  });
});

/**
 * The admin gateway gate scores a leg against PRICE-POINT rows, which name their
 * rung directly and carry no request params. It must reach the same rate the
 * worker authorizes a generation at — a second derivation is how a panel blesses
 * a routing the worker refuses to serve.
 */
describe('the per-rung lookup both money-path sides share', () => {
  it('answers for a named rung, with no request params in hand', () => {
    expect(officialLegCostForRung(NANO_BANANA_PRO_CAPS, '4K')).toBe(0.241344);
  });

  it('says null for a rung the row does not price', () => {
    expect(officialLegCostForRung(NANO_BANANA_PRO_CAPS, '1K')).toBeNull();
  });

  it('says null for a row with no per-rung map at all', () => {
    expect(officialLegCostForRung({ resolutions: ['1K'] }, '1K')).toBeNull();
  });

  it('rejects the scalar shape legs 0 and 1 use, rather than reading it as every rung', () => {
    expect(officialLegCostForRung({ officialUsdPerUnit: 0.241344 }, '4K')).toBeNull();
  });

  it('agrees with the request-shaped lookup on the same row and rung', () => {
    const viaRequest = officialLegCost(NANO_BANANA_PRO_CAPS, { resolution: '4K' }, 'image');
    expect(officialLegCostForRung(NANO_BANANA_PRO_CAPS, viaRequest.rung)).toBe(
      viaRequest.usdPerUnit,
    );
  });
});
