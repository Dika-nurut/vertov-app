// Local ASR worker — runs whisper entirely in the user's browser (zero server
// cost) via @huggingface/transformers. transformers.js (~all its WASM/ONNX
// weight) is dynamic-import()ed HERE, inside the worker's own bundle, so the main
// app chunk never grows. Pattern adapted from OpenCut's transcription worker.
//
// Protocol: main posts { pcm: Float32Array (16kHz mono), language? }. We reply
// with { type:'progress', progress } during model download and again when
// inference starts, then exactly one { type:'result', segments } or
// { type:'error', error }. The pipeline is a singleton — the ~250MB model loads
// once and is reused across runs (main keeps the worker alive; see service.ts).
import { groupWordsIntoSegments, type RawAsrWord } from './group';
import type { WordSegment } from '../subtitle-import';

const MODEL_ID = 'onnx-community/whisper-small';

export type AsrProgress = { phase: 'download'; pct: number } | { phase: 'transcribe' };

export interface AsrRequest {
  /** Monotonic id from the caller — echoed on every reply so service.ts can
   * route replies to the right in-flight call even if the singleton worker
   * outlives an aborted/overlapping request. */
  requestId: number;
  pcm: Float32Array;
  language?: string;
}

export type AsrResponse =
  | { type: 'progress'; requestId: number; progress: AsrProgress }
  | { type: 'result'; requestId: number; segments: WordSegment[] }
  | { type: 'error'; requestId: number; error: string };

// `self` is typed as Window under the project's DOM lib (no webworker lib). Cast
// to the minimal worker surface we actually use so tsc stays happy without the
// lib swap (which conflicts with DOM across the rest of the app).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AsrRequest>) => void) | null;
  postMessage: (msg: AsrResponse) => void;
};

const post = (msg: AsrResponse) => ctx.postMessage(msg);

// Lazily built once; subsequent runs reuse the loaded weights.
let pipePromise: Promise<
  (audio: Float32Array, opts: Record<string, unknown>) => Promise<unknown>
> | null = null;

// The requestId of whichever call is currently running. Requests are
// serialized by the caller (service.ts rejects overlapping calls), so at most
// one is ever in flight — safe to read from the pipeline's progress_callback,
// which only fires during the (one-time) model download.
let currentRequestId = 0;

async function getPipeline() {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Optional self-hosted model mirror (RU users where the HF CDN is blocked).
      // When set, serve the ONNX weights from our Object Storage; the bucket must
      // mirror HF's `{model}/resolve/{revision}/` layout. Default = HF hub.
      const base = process.env.NEXT_PUBLIC_ASR_MODEL_BASE;
      if (base) {
        env.allowLocalModels = false;
        env.remoteHost = base;
        env.remotePathTemplate = '{model}/resolve/{revision}/';
      }
      const p = await pipeline('automatic-speech-recognition', MODEL_ID, {
        // q8 keeps whisper-small near ~250MB in the browser (fp32 would be ~1GB).
        dtype: 'q8',
        progress_callback: (e: { status?: string; progress?: number }) => {
          if (e?.status === 'progress') {
            post({
              type: 'progress',
              requestId: currentRequestId,
              progress: { phase: 'download', pct: Math.round(e.progress ?? 0) },
            });
          }
        },
      });
      return p as unknown as (
        audio: Float32Array,
        opts: Record<string, unknown>,
      ) => Promise<unknown>;
    })();
  }
  return pipePromise;
}

ctx.onmessage = async (e: MessageEvent<AsrRequest>) => {
  const { requestId, pcm, language } = e.data;
  currentRequestId = requestId;
  try {
    const transcriber = await getPipeline();
    // Download (if any) is done; inference has no progress events of its own.
    post({ type: 'progress', requestId, progress: { phase: 'transcribe' } });
    const out = (await transcriber(pcm, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      language,
      task: 'transcribe',
    })) as { chunks?: { text: string; timestamp: [number, number | null] }[] };
    const words: RawAsrWord[] = (out.chunks ?? []).map((c) => ({
      word: c.text,
      startSec: c.timestamp?.[0] ?? 0,
      endSec: c.timestamp?.[1] ?? null,
    }));
    const segments = groupWordsIntoSegments(words);
    post({ type: 'result', requestId, segments });
  } catch (err) {
    post({ type: 'error', requestId, error: err instanceof Error ? err.message : String(err) });
  }
};
