import { describe, expect, it } from 'vitest';
import { transcriptToCaptions } from './captions';

describe('transcriptToCaptions', () => {
  it('maps source timestamps into a trimmed timeline clip', () => {
    expect(
      transcriptToCaptions([{ text: 'hello', startSec: 4, endSec: 6 }], {
        timelineStartSec: 10,
        sourceInSec: 3,
        sourceOutSec: 8,
        speed: 1,
      }),
    ).toMatchObject([{ text: 'hello', fromSec: 11, toSec: 13 }]);
  });

  it('clips segments to the selected source range and accounts for speed', () => {
    expect(
      transcriptToCaptions([{ text: 'fast', startSec: 1, endSec: 5 }], {
        timelineStartSec: 2,
        sourceInSec: 2,
        sourceOutSec: 4,
        speed: 2,
      }),
    ).toMatchObject([{ text: 'fast', fromSec: 2, toSec: 3 }]);
  });

  it('drops empty or out-of-range segments', () => {
    expect(
      transcriptToCaptions(
        [
          { text: ' ', startSec: 0, endSec: 1 },
          { text: 'late', startSec: 5, endSec: 6 },
        ],
        { timelineStartSec: 0, sourceInSec: 0, sourceOutSec: 4, speed: 1 },
      ),
    ).toEqual([]);
  });
});
