/**
 * Auto-ducking: lower the music track under voiceover speech («автодакинг»).
 * Adapted from OpenReel's (MIT) AudioDucker — RMS speech presence → a ducking
 * envelope with attack / hold / release ramps.
 *
 * The pieces split by testability, same as beat-detect.ts:
 *   detectSpeechSegments — PURE (Float32Array in, windows out): unit-tested.
 *   buildDuckEnvelope    — PURE: merges raw speech windows into clean hold ranges.
 *   duckGainDbAt         — PURE: THE parity contract. Preview and the ffmpeg
 *                          `volume` expression both follow this exact function,
 *                          so preview == export holds frame-for-frame.
 *   analyzeVoiceoverDucking — runtime wrapper (Web Audio decode); not unit-tested
 *                          (jsdom has no audio decoder), kept thin.
 *
 * Contract on the stored spec (`music.duck = { db, segments }`):
 *   `segments` are the HOLD windows (music sits at `db` throughout). The
 *   attack (ramp 0 → db before each window) and release (ramp db → 0 after) are
 *   applied at evaluation time by `duckGainDbAt` — they are NOT baked into the
 *   windows. Attack/release are fixed constants, duplicated in the worker
 *   (apps/worker/src/studio-graph.ts DUCK_ATTACK_SEC / DUCK_RELEASE_SEC) — keep
 *   the two copies in sync. Only `db` travels on the spec.
 *
 * Lerp domain: the attack/release ramps interpolate in DECIBELS (perceptually
 * even), then convert to a linear gain once. The worker mirrors this — its
 * expression lerps dB the same way and takes pow(10, db/20) at the end — so both
 * sides evaluate the identical curve.
 */

export interface SpeechSegment {
  fromSec: number;
  toSec: number;
}
/** A hold window during which music is ducked (attack/release live at eval). */
export interface DuckSegment {
  fromSec: number;
  toSec: number;
}
export interface DuckResult {
  db: number;
  segments: DuckSegment[];
}

// Envelope defaults — the fixed ramp constants MUST match the worker copy.
export const DUCK_DB = -12;
export const DUCK_ATTACK_SEC = 0.25;
export const DUCK_RELEASE_SEC = 0.4;

export interface DetectOpts {
  /** RMS frame length. 50ms is short enough to catch phrase edges. */
  frameSec?: number;
  /** Speech threshold as a fraction of the p90 frame RMS. */
  thresholdFrac?: number;
  /** Absolute RMS floor so near-silence never reads as speech. */
  floorRms?: number;
  /** Bridge speech runs closer than this (breaths / stop consonants). */
  mergeGapSec?: number;
  /** Drop runs shorter than this (clicks / noise). */
  minSegSec?: number;
}

export interface EnvelopeOpts {
  duckDb?: number;
  attackSec?: number;
  releaseSec?: number;
}

/**
 * Detect speech (loud) segments over a mono channel via frame RMS + an adaptive
 * threshold (a fraction of the p90 RMS, with an absolute floor). Consecutive
 * loud frames form runs; runs closer than `mergeGapSec` merge; runs shorter than
 * `minSegSec` drop. Returns RAW windows (no attack/release padding — that is the
 * envelope's job). PURE.
 */
export function detectSpeechSegments(
  channel: Float32Array,
  sampleRate: number,
  opts: DetectOpts = {},
): SpeechSegment[] {
  const frameSec = opts.frameSec ?? 0.05;
  const thresholdFrac = opts.thresholdFrac ?? 0.2;
  const floorRms = opts.floorRms ?? 0.01;
  const mergeGapSec = opts.mergeGapSec ?? 0.3;
  const minSegSec = opts.minSegSec ?? 0.25;

  const frame = Math.max(1, Math.round(frameSec * sampleRate));
  const rms: number[] = [];
  for (let start = 0; start + frame <= channel.length; start += frame) {
    let sum = 0;
    for (let i = 0; i < frame; i++) {
      const s = channel[start + i]!;
      sum += s * s;
    }
    rms.push(Math.sqrt(sum / frame));
  }
  if (rms.length === 0) return [];

  // p90 of the frame RMS is a robust "loud" reference (ignores the top decile of
  // transients), and the threshold sits at a fraction of it — floored so a track
  // of pure silence can't produce a threshold of 0 that everything clears.
  const sorted = [...rms].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
  const threshold = Math.max(floorRms, thresholdFrac * p90);
  const secPerFrame = frame / sampleRate;

  const runs: SpeechSegment[] = [];
  let runStart = -1;
  for (let i = 0; i < rms.length; i++) {
    const loud = rms[i]! >= threshold;
    if (loud && runStart < 0) runStart = i;
    if (!loud && runStart >= 0) {
      runs.push({ fromSec: runStart * secPerFrame, toSec: i * secPerFrame });
      runStart = -1;
    }
  }
  if (runStart >= 0)
    runs.push({ fromSec: runStart * secPerFrame, toSec: rms.length * secPerFrame });

  const merged: SpeechSegment[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.fromSec - last.toSec < mergeGapSec) last.toSec = r.toSec;
    else merged.push({ ...r });
  }
  return merged.filter((s) => s.toSec - s.fromSec >= minSegSec);
}

/**
 * Merge arbitrary speech windows into sorted, non-overlapping hold windows.
 * Windows are merged when they overlap OR sit within `attackSec + releaseSec` of
 * each other — closer than that, the release ramp of one would collide with the
 * attack of the next and the music would pop back up for a fraction of a second,
 * so we hold it down instead. Attack/release themselves stay as eval-time ramps.
 * PURE.
 */
export function buildDuckEnvelope(
  segments: SpeechSegment[],
  opts: EnvelopeOpts = {},
): DuckSegment[] {
  const attackSec = opts.attackSec ?? DUCK_ATTACK_SEC;
  const releaseSec = opts.releaseSec ?? DUCK_RELEASE_SEC;
  const bridge = attackSec + releaseSec;
  const clean = segments
    .map((s) => ({ fromSec: Math.max(0, s.fromSec), toSec: Math.max(s.fromSec, s.toSec) }))
    .filter((s) => s.toSec > s.fromSec)
    .sort((a, b) => a.fromSec - b.fromSec);
  const out: DuckSegment[] = [];
  for (const s of clean) {
    const last = out[out.length - 1];
    if (last && s.fromSec - last.toSec < bridge) last.toSec = Math.max(last.toSec, s.toSec);
    else out.push({ ...s });
  }
  return out;
}

/**
 * THE parity contract. Ducking gain (dB, ≤ 0) at time `t` over the hold windows:
 *   0 outside every [from − attack, to + release]
 *   duckDb across the hold [from, to]
 *   a linear (in dB) attack ramp 0 → duckDb over [from − attack, from]
 *   a linear (in dB) release ramp duckDb → 0 over [to, to + release]
 * Overlapping ramps take the MINIMUM (most-ducked) contribution. Both the
 * preview (music volume = dbToLin(gainDb + this)) and the worker's ffmpeg
 * `volume` expression evaluate THIS curve — that is what makes preview == export.
 * PURE.
 */
export function duckGainDbAt(t: number, segments: DuckSegment[], opts: EnvelopeOpts = {}): number {
  const duckDb = opts.duckDb ?? DUCK_DB;
  const attackSec = Math.max(1e-4, opts.attackSec ?? DUCK_ATTACK_SEC);
  const releaseSec = Math.max(1e-4, opts.releaseSec ?? DUCK_RELEASE_SEC);
  let gain = 0;
  for (const s of segments) {
    const a = s.fromSec;
    const b = Math.max(s.fromSec, s.toSec);
    let c = 0;
    if (t < a - attackSec || t >= b + releaseSec) c = 0;
    else if (t < a) c = duckDb * ((t - (a - attackSec)) / attackSec);
    else if (t < b) c = duckDb;
    else c = duckDb * (1 - (t - b) / releaseSec);
    if (c < gain) gain = c;
  }
  return gain;
}

/**
 * Fetch + decode the voiceover, mono-mixdown, detect speech, build the envelope.
 * Runtime-only (Web Audio); not unit-tested. The returned `segments` are in the
 * voiceover's OWN timeline (0-based); the caller shifts them by the voiceover's
 * `fromSec` so the stored windows live in project-timeline seconds.
 */
export async function analyzeVoiceoverDucking(
  url: string,
  maxSec = 180,
  opts: DetectOpts & EnvelopeOpts = {},
): Promise<DuckResult> {
  const AC: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const sampleRate = audioBuffer.sampleRate;
    const maxSamples = Math.min(audioBuffer.length, Math.round(maxSec * sampleRate));
    const mono = new Float32Array(maxSamples);
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < maxSamples; i++) mono[i]! += data[i]! / audioBuffer.numberOfChannels;
    }
    const speech = detectSpeechSegments(mono, sampleRate, opts);
    const segments = buildDuckEnvelope(speech, opts);
    return { db: opts.duckDb ?? DUCK_DB, segments };
  } finally {
    void ctx.close();
  }
}
