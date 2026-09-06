// Local ASR service — the main-thread half of browser-side whisper. Fetches the
// clip (same-origin — it already plays in a <video>), decodes + downmixes to
// 16kHz mono PCM, hands it to the singleton whisper worker (transferable), and
// resolves the WordSegment[] the caption pipeline already understands. Keeps the
// worker alive between runs so the ~250MB model loads only once.
import type { WordSegment } from '../subtitle-import';
import type { AsrProgress, AsrRequest, AsrResponse } from './whisper.worker';

export type { AsrProgress } from './whisper.worker';

/** Local ASR is honest about long selections rather than silently truncating:
 * whisper-small on WASM is slow, so 5 min is the ceiling — enforced against the
 * SELECTED [inSec, outSec] window, not the whole source asset. */
const MAX_AUDIO_SEC = 5 * 60;
const TARGET_RATE = 16000;

/** Typed local-ASR failure: `'busy'` when a transcription is already running
 * (the worker is a serialized singleton — one call at a time), `'disposed'`
 * when the studio unmounted (or disposeLocalAsr ran) mid-call. Callers branch
 * on `.code` instead of matching on message text. */
export class LocalAsrError extends Error {
  constructor(
    public readonly code: 'busy' | 'disposed',
    message: string,
  ) {
    super(message);
    this.name = 'LocalAsrError';
  }
}

let worker: Worker | null = null;
// Bumped by disposeLocalAsr; a call in flight captures the epoch at start and
// refuses to (re)create the worker or apply a result once it's stale, so a
// pending fetch/decode continuation can't resurrect the ~250MB model after
// dispose.
let epoch = 0;
// True while a localTranscribe() call is running. The worker is a singleton,
// so overlapping calls would otherwise both resolve from whichever reply
// arrives first — reject the second call instead of racing.
let inFlight = false;
let nextRequestId = 1;
// Cancels the in-flight worker promise (removes listeners + rejects). Set while a
// call is awaiting the worker, cleared on settle. disposeLocalAsr() invokes it so
// terminating the worker mid-run — which fires NO message/error — still rejects
// the pending promise and releases the `inFlight` latch (otherwise the service
// would be wedged 'busy' forever after an unmount-during-transcription).
let cancelInFlight: ((reason: LocalAsrError) => void) | null = null;

/** Shift slice-relative timestamps back onto source time. Whisper transcribes
 * only the [inSec, outSec] window, so its 0-based times must be offset by +inSec
 * (both segment- and word-level) to match the server path's source-relative
 * output that the caption offset math expects. */
export function shiftSegments(segments: WordSegment[], offsetSec: number): WordSegment[] {
  return segments.map((s) => {
    const shifted: WordSegment = {
      ...s,
      startSec: s.startSec + offsetSec,
      endSec: s.endSec + offsetSec,
    };
    if (s.words) {
      shifted.words = s.words.map((w) => ({
        ...w,
        startSec: w.startSec + offsetSec,
        endSec: w.endSec + offsetSec,
      }));
    }
    return shifted;
  });
}

function getWorker(): Worker {
  if (!worker) {
    // Next 15 (webpack) bundles this into its own worker chunk from the URL form.
    worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

/** Tear down the worker (and free the loaded model). Called when the studio
 * unmounts so a ~250MB model doesn't linger. */
export function disposeLocalAsr(): void {
  epoch++;
  // Reject any awaiting call BEFORE terminating — terminate() is silent, so
  // without this the promise would dangle and `inFlight` never clear.
  cancelInFlight?.(new LocalAsrError('disposed', 'Локальное распознавание отключено.'));
  worker?.terminate();
  worker = null;
}

/** True when this browser can run local ASR at all (WASM + Worker). The UI uses
 * this to hide the «Локально» engine on unsupported browsers. */
export function localAsrSupported(): boolean {
  return (
    typeof WebAssembly !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof OfflineAudioContext !== 'undefined'
  );
}

interface AudioCtor {
  new (): AudioContext;
}

/** Decode → (optional in/out slice) → mono → resample to 16kHz using an
 * OfflineAudioContext (1 channel auto-downmixes; the target sample rate
 * resamples). Returns the raw waveform for ONLY the selected window.
 *
 * The 5-minute ceiling is enforced against the SELECTED range, not the whole
 * source: the studio lets users caption a short IN/OUT-trimmed selection from a
 * much longer asset, so a 20s edit from a 6-minute source must succeed. */
async function decodeToMono16k(
  buf: ArrayBuffer,
  range?: { inSec: number; outSec: number },
): Promise<Float32Array> {
  const Ctor = (window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext) as
    | AudioCtor
    | undefined;
  if (!Ctor) throw new Error('Web Audio API недоступен в этом браузере.');
  const ac = new Ctor();
  let decoded: AudioBuffer;
  try {
    decoded = await ac.decodeAudioData(buf);
  } finally {
    void ac.close?.();
  }

  // Clamp the requested window to what actually decoded. No range (or an
  // inverted/empty one) means "whole asset".
  const startSec = range ? Math.max(0, Math.min(range.inSec, decoded.duration)) : 0;
  const endSec = range
    ? Math.max(startSec, Math.min(range.outSec, decoded.duration))
    : decoded.duration;
  const selectedSec = endSec - startSec;

  if (selectedSec > MAX_AUDIO_SEC) {
    throw new Error(
      'Выбранный фрагмент длиннее 5 минут — для локального распознавания выберите отрезок покороче.',
    );
  }

  const srcRate = decoded.sampleRate;
  const startFrame = Math.floor(startSec * srcRate);
  const endFrame = Math.min(decoded.length, Math.ceil(endSec * srcRate));
  const sliceLen = Math.max(1, endFrame - startFrame);

  // Render only [startFrame, endFrame) through the offline graph. We copy the
  // selected span of the (already downmixed by the 1-channel destination)
  // source into a fresh single-channel buffer, then resample that to 16kHz —
  // so decode/inference cost tracks the SELECTION, not the full source.
  const sliceBuf = new AudioBuffer({
    length: sliceLen,
    numberOfChannels: decoded.numberOfChannels,
    sampleRate: srcRate,
  });
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const full = decoded.getChannelData(ch);
    sliceBuf.copyToChannel(full.subarray(startFrame, endFrame), ch, 0);
  }

  const frames = Math.max(1, Math.ceil(selectedSec * TARGET_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = sliceBuf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

export interface LocalTranscribeOptions {
  onProgress?: (p: AsrProgress) => void;
  /** Whisper source language hint (e.g. 'russian'); omit to auto-detect. */
  language?: string;
  /** Source-time trim of the selected clip. When set, only [inSec, outSec] is
   * decoded/transcribed and the 5-min cap applies to that window; returned
   * timestamps are shifted back to SOURCE time (+inSec) so downstream offset
   * math (transcriptToCaptions/wordsToPopCaptions) treats both engines
   * identically. Omit to transcribe the whole asset. */
  inSec?: number;
  outSec?: number;
}

/** Transcribe a clip locally. Resolves segments in the same WordSegment[] shape
 * the server /captions path returns, so both engines feed one downstream. */
export async function localTranscribe(
  clipUrl: string,
  opts: LocalTranscribeOptions = {},
): Promise<WordSegment[]> {
  if (inFlight) {
    throw new LocalAsrError('busy', 'Распознавание уже идёт — дождитесь завершения.');
  }
  inFlight = true;
  const startEpoch = epoch;
  // Slice window in source time. Whisper sees only [inSec, outSec] and returns
  // times relative to the slice start, so we add this back to every timestamp to
  // land them on SOURCE time — the same coordinate space the server /captions
  // path returns, which transcriptToCaptions/wordsToPopCaptions already offset.
  const hasRange =
    typeof opts.inSec === 'number' && typeof opts.outSec === 'number' && opts.outSec > opts.inSec;
  const range = hasRange ? { inSec: opts.inSec!, outSec: opts.outSec! } : undefined;
  const offsetSec = range ? range.inSec : 0;
  try {
    const res = await fetch(clipUrl, { credentials: 'include' });
    if (!res.ok) throw new Error('Не удалось загрузить клип для распознавания.');
    const arr = await res.arrayBuffer();
    const pcm = await decodeToMono16k(arr, range);

    if (epoch !== startEpoch) {
      throw new LocalAsrError('disposed', 'Локальное распознавание отключено.');
    }
    const w = getWorker();
    const requestId = nextRequestId++;
    return await new Promise<WordSegment[]>((resolve, reject) => {
      const onMessage = (e: MessageEvent<AsrResponse>) => {
        const d = e.data;
        if (d.requestId !== requestId) return; // reply for a superseded call
        if (d.type === 'progress') {
          opts.onProgress?.(d.progress);
        } else if (d.type === 'result') {
          cleanup();
          if (epoch !== startEpoch) {
            reject(new LocalAsrError('disposed', 'Локальное распознавание отключено.'));
            return;
          }
          resolve(offsetSec ? shiftSegments(d.segments, offsetSec) : d.segments);
        } else if (d.type === 'error') {
          cleanup();
          reject(new Error(d.error));
        }
      };
      const onError = (ev: ErrorEvent) => {
        cleanup();
        // A worker-load/runtime failure disposes the singleton so the next attempt
        // rebuilds it cleanly.
        disposeLocalAsr();
        reject(new Error(ev.message || 'Локальное распознавание не запустилось.'));
      };
      const cleanup = () => {
        w.removeEventListener('message', onMessage as EventListener);
        w.removeEventListener('error', onError as EventListener);
        cancelInFlight = null;
      };
      // Let disposeLocalAsr() tear this exact call down (terminate fires no event).
      cancelInFlight = (reason) => {
        cleanup();
        reject(reason);
      };
      w.addEventListener('message', onMessage as EventListener);
      w.addEventListener('error', onError as EventListener);
      const req: AsrRequest = opts.language
        ? { requestId, pcm, language: opts.language }
        : { requestId, pcm };
      w.postMessage(req, [pcm.buffer]);
    });
  } finally {
    inFlight = false;
  }
}
