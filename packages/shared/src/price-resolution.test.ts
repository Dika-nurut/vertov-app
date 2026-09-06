import { describe, expect, it } from 'vitest';
import { priceResolutionForRequest } from './price-resolution';

describe('priceResolutionForRequest', () => {
  it('pins a crafted rung to default when the model declares an empty menu', () => {
    expect(
      priceResolutionForRequest({ resolution: '2K', quality: 'low' }, { resolutions: [] }, 'image'),
    ).toBe('default');
  });

  it('does not treat video quality as a resolution alias', () => {
    expect(
      priceResolutionForRequest({ quality: '480p' }, { resolutions: ['480p', '720p'] }, 'video'),
    ).toBe('default');
    expect(
      priceResolutionForRequest(
        { resolution: '480p', quality: '720p' },
        { resolutions: ['480p', '720p'] },
        'video',
      ),
    ).toBe('480p');
  });
});
