import { describe, it, expect, vi, afterEach } from 'vitest';
import { shiftSegments, localTranscribe, disposeLocalAsr } from './service';
import { transcriptToCaptions } from '../captions';
import type { WordSegment } from '../subtitle-import';

// The local ASR path decodes/transcribes ONLY the trimmed [inSec, outSec]
// selection, so whisper returns times relative to the slice start (0-based).
// shiftSegments adds inSec back so results land on SOURCE time — the exact
// coordinate space the server /captions path already returns, which lets the
// downstream caption mapping stay engine-blind.

describe('shiftSegments', () => {
  it('offsets segment- and word-level timestamps onto source time', () => {
    // A 20s edit taken from an offset of 300s (5:00) into a 6-minute source:
    // whisper saw a 20s slice and reported 0-based times.
    const sliceRelative: WordSegment[] = [
      {
        text: 'привет мир',
        startSec: 0.2,
        endSec: 1.8,
        words: [
          { word: 'привет', startSec: 0.2, endSec: 1.0 },
          { word: 'мир', startSec: 1.0, endSec: 1.8 },
        ],
      },
    ];

    const shifted = shiftSegments(sliceRelative, 300);

    expect(shifted[0]!.startSec).toBeCloseTo(300.2);
    expect(shifted[0]!.endSec).toBeCloseTo(301.8);
    expect(shifted[0]!.words?.[0]).toEqual({ word: 'привет', startSec: 300.2, endSec: 301.0 });
    expect(shifted[0]!.words?.[1]).toEqual({ word: 'мир', startSec: 301.0, endSec: 301.8 });
    // Non-timing fields survive untouched.
    expect(shifted[0]!.text).toBe('привет мир');
  });

  it('leaves segments without per-word timings word-free (no words:undefined)', () => {
    const shifted = shiftSegments([{ text: 'без слов', startSec: 1, endSec: 2 }], 10);
    expect(shifted[0]).toEqual({ text: 'без слов', startSec: 11, endSec: 12 });
    expect('words' in shifted[0]!).toBe(false);
  });

  it('a 20s selection from a 6-min source maps to the right timeline window', () => {
    // Regression for the Codex finding: before the fix, the 5-min cap rejected
    // the whole 6-min source. Now only the 20s slice is transcribed; after
    // shifting to source time, transcriptToCaptions (sourceInSec=300) offsets it
    // onto the timeline exactly as the server engine's output would.
    const sourceRelative = shiftSegments(
      [{ text: 'реплика', startSec: 2, endSec: 5 }],
      300, // inSec
    );

    const caps = transcriptToCaptions(sourceRelative, {
      timelineStartSec: 0,
      sourceInSec: 300,
      sourceOutSec: 320,
      speed: 1,
    });

    expect(caps).toHaveLength(1);
    // (302 - 300)/1 = 2s into the clip on the timeline.
    expect(caps[0]!.fromSec).toBeCloseTo(2);
    expect(caps[0]!.toSec).toBeCloseTo(5);
    expect(caps[0]!.text).toBe('реплика');
  });
});

describe('disposeLocalAsr releases the in-flight latch', () => {
  // jsdom has no Worker/Web-Audio; stub the minimum so localTranscribe reaches
  // the "awaiting the worker" state. The fake worker NEVER replies, so the call
  // stays in flight until disposeLocalAsr() tears it down.
  const flush = () => new Promise((r) => setTimeout(r, 0));
  afterEach(() => {
    disposeLocalAsr();
    vi.unstubAllGlobals();
  });

  function installAudioStubs() {
    const fakeDecoded = {
      duration: 1,
      sampleRate: 16000,
      length: 16000,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(16000),
    };
    vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    class FakeAudioContext {
      decodeAudioData = async () => fakeDecoded;
      close() {}
    }
    // The web suite runs in `node` (no jsdom) — the service reads
    // `window.AudioContext`, so provide a minimal window.
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal(
      'AudioBuffer',
      class {
        length: number;
        constructor(o: { length: number }) {
          this.length = o.length;
        }
        copyToChannel() {}
        getChannelData() {
          return new Float32Array(this.length);
        }
      },
    );
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        frames: number;
        destination = {};
        constructor(_ch: number, frames: number) {
          this.frames = frames;
        }
        createBufferSource() {
          return { buffer: null, connect() {}, start() {} };
        }
        startRendering = async () => ({ getChannelData: () => new Float32Array(this.frames) });
      },
    );
    // A worker that accepts listeners + postMessage but NEVER answers.
    vi.stubGlobal(
      'Worker',
      class {
        addEventListener() {}
        removeEventListener() {}
        postMessage() {}
        terminate() {}
      },
    );
  }

  it('rejects the pending promise as `disposed` and does NOT wedge future calls as `busy`', async () => {
    installAudioStubs();
    const p = localTranscribe('blob:clip');
    p.catch(() => {}); // avoid an unhandled-rejection warning before we await
    await flush(); // let fetch+decode settle so we're parked on the worker

    disposeLocalAsr();
    await expect(p).rejects.toMatchObject({ code: 'disposed' });

    // The bug: before the fix, the terminated call's promise dangled and
    // `inFlight` stayed true, so this second call rejected as 'busy' forever.
    const p2 = localTranscribe('blob:clip');
    p2.catch(() => {});
    await flush();
    disposeLocalAsr();
    await expect(p2).rejects.toMatchObject({ code: 'disposed' });
  });
});
