/**
 * Beat detection for the timeline's «Биты» toggle (snap-to-beat on the music
 * track). Adapted from OpenReel's (MIT) offline onset-detection approach:
 * time-domain energy flux + adaptive threshold + refractory peak-picking, no
 * FFT dependency so it stays cheap to unit-test.
 *
 * `detectBeats` is pure (Float32Array in, times out) — unit-tested against
 * synthetic click tracks. `analyzeMusicBeats` is the runtime wrapper that
 * decodes a real file via the Web Audio API; it isn't unit-tested (jsdom has
 * no audio decoder), just kept thin enough that bugs would have to live in
 * `detectBeats`.
 */

// Frame/hop for the energy envelope. Finer than the "1024/512" textbook
// default: a small hop keeps the per-onset time quantization well under the
// ~30ms precision snap-to-beat needs (a big rectangular energy window plus a
// coarse hop biases short percussive attacks by up to half a hop).
const FRAME = 512;
const HOP = 128;
const REFRACTORY_SEC = 0.25;
const THRESHOLD_WINDOW_SEC = 1; // adaptive-threshold sliding window, each side
const THRESHOLD_K = 1.5;
const GRID_TOLERANCE_SEC = 0.07;
const GRID_FIT_FRAC = 0.6;
const BPM_MIN = 60;
const BPM_MAX = 200;

export interface BeatResult {
  beats: number[];
  bpm: number | null;
}

/** Per-frame time-domain energy (sum of squares) over the whole channel. */
function frameEnergies(channel: Float32Array): number[] {
  const energies: number[] = [];
  for (let start = 0; start + FRAME <= channel.length; start += HOP) {
    let e = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = channel[start + i]!;
      e += s * s;
    }
    energies.push(e);
  }
  return energies;
}

/** Positive-only energy delta per frame (spectral-flux analogue, time-domain). */
function energyFlux(energies: number[]): number[] {
  const flux: number[] = [0];
  for (let i = 1; i < energies.length; i++) {
    flux.push(Math.max(0, energies[i]! - energies[i - 1]!));
  }
  return flux;
}

/** Adaptive threshold: mean + k*std over a sliding window centred on each frame. */
function adaptiveThreshold(flux: number[], framesPerSec: number): number[] {
  const radius = Math.max(1, Math.round(THRESHOLD_WINDOW_SEC * framesPerSec));
  const thresh: number[] = [];
  for (let i = 0; i < flux.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(flux.length - 1, i + radius);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += flux[j]!;
    const n = hi - lo + 1;
    const mean = sum / n;
    let variance = 0;
    for (let j = lo; j <= hi; j++) variance += (flux[j]! - mean) ** 2;
    const std = Math.sqrt(variance / n);
    thresh.push(mean + THRESHOLD_K * std);
  }
  return thresh;
}

/** Parabolic interpolation of the true peak position around index `i`. */
function interpolatePeak(flux: number[], i: number): number {
  const fm1 = flux[i - 1];
  const f0 = flux[i]!;
  const fp1 = flux[i + 1];
  if (fm1 == null || fp1 == null) return i;
  const denom = fm1 - 2 * f0 + fp1;
  if (denom === 0) return i;
  const delta = (0.5 * (fm1 - fp1)) / denom;
  return i + Math.max(-0.5, Math.min(0.5, delta));
}

/** Pick local-max frames above the adaptive threshold, enforcing a refractory
 * gap between accepted onsets so a single transient's flux never double-fires. */
function pickPeaks(flux: number[], thresh: number[], sampleRate: number): number[] {
  const refractoryFrames = (REFRACTORY_SEC * sampleRate) / HOP;
  const onsets: number[] = [];
  let lastAcceptedFrame = -Infinity;
  for (let i = 1; i < flux.length - 1; i++) {
    const v = flux[i]!;
    if (v <= thresh[i]!) continue;
    if (v < flux[i - 1]! || v < flux[i + 1]!) continue; // local max only
    if (i - lastAcceptedFrame < refractoryFrames) continue;
    const refined = interpolatePeak(flux, i);
    // Timestamp the frame at its CENTER, not its start: energy rises as soon as
    // the (wider-than-hop) window first overlaps a transient, which is biased
    // early relative to the transient itself unless we account for the frame
    // width the same way the energy sum implicitly does.
    onsets.push((refined * HOP + FRAME / 2) / sampleRate);
    lastAcceptedFrame = i;
  }
  return onsets;
}

/** Median inter-onset interval → an initial period estimate (seconds). */
function medianIoi(onsets: number[]): number | null {
  const iois = onsets
    .slice(1)
    .map((t, i) => t - onsets[i]!)
    .filter((d) => d > 0);
  if (iois.length === 0) return null;
  const sorted = [...iois].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Refine a coarse period estimate against ALL onsets (not just adjacent
 * pairs) via a through-the-origin least-squares fit against integer beat
 * multiples — this averages out the frame-quantization noise on any single
 * inter-onset gap and is what gets the BPM estimate genuinely tight. */
function refinePeriod(onsets: number[], coarsePeriod: number): number {
  const base = onsets[0]!;
  let sumKD = 0;
  let sumKK = 0;
  for (const o of onsets) {
    const k = Math.round((o - base) / coarsePeriod);
    if (k === 0) continue;
    sumKD += k * (o - base);
    sumKK += k * k;
  }
  if (sumKK === 0) return coarsePeriod;
  return sumKD / sumKK;
}

/** Median-IOI + regression-refined BPM, clamped into [60,200] by octave-folding
 * (halving/doubling), which is the usual ambiguity for tempo estimation. */
function estimateBpm(onsets: number[]): number | null {
  if (onsets.length < 2) return null;
  const coarse = medianIoi(onsets);
  if (coarse == null || coarse <= 0) return null;
  const period = onsets.length >= 3 ? refinePeriod(onsets, coarse) : coarse;
  if (period <= 0) return null;
  let bpm = 60 / period;
  while (bpm < BPM_MIN) bpm *= 2;
  while (bpm > BPM_MAX) bpm /= 2;
  return bpm;
}

/** Circular mean of `onsets mod period` — the phase that best aligns a regular
 * grid to the (noisy) detected onsets. */
function bestGridPhase(onsets: number[], period: number): number {
  let sumCos = 0;
  let sumSin = 0;
  for (const o of onsets) {
    const angle = ((o % period) / period) * 2 * Math.PI;
    sumCos += Math.cos(angle);
    sumSin += Math.sin(angle);
  }
  const meanAngle = Math.atan2(sumSin, sumCos);
  let phase = (meanAngle / (2 * Math.PI)) * period;
  if (phase < 0) phase += period;
  return phase;
}

/** Fraction of onsets that land within `GRID_TOLERANCE_SEC` of the nearest
 * `phase + n*period` grid point. */
function gridFitFraction(onsets: number[], phase: number, period: number): number {
  let hits = 0;
  for (const o of onsets) {
    const n = Math.round((o - phase) / period);
    const grid = phase + n * period;
    if (Math.abs(o - grid) <= GRID_TOLERANCE_SEC) hits++;
  }
  return hits / onsets.length;
}

/**
 * Onset (beat) detection over a mono PCM channel. Frames the signal, computes
 * energy flux, adaptive-thresholds + refractory-picks peaks, estimates BPM
 * from the median inter-onset interval (regression-refined), and — when the
 * onsets are regular enough — snaps to a clean BPM grid across the analyzed
 * span rather than returning the raw (noisier) onset times.
 */
export function detectBeats(channel: Float32Array, sampleRate: number): BeatResult {
  const energies = frameEnergies(channel);
  if (energies.length < 3) return { beats: [], bpm: null };
  const flux = energyFlux(energies);
  const framesPerSec = sampleRate / HOP;
  const thresh = adaptiveThreshold(flux, framesPerSec);
  const onsets = pickPeaks(flux, thresh, sampleRate);
  if (onsets.length === 0) return { beats: [], bpm: null };

  const bpm = estimateBpm(onsets);
  if (bpm == null) return { beats: onsets, bpm: null };

  const period = 60 / bpm;
  const phase = bestGridPhase(onsets, period);
  const fitFrac = gridFitFraction(onsets, phase, period);
  if (fitFrac < GRID_FIT_FRAC) return { beats: onsets, bpm: null };

  const span = channel.length / sampleRate;
  const grid: number[] = [];
  for (let t = phase; t < span; t += period) grid.push(t);
  return { beats: grid, bpm };
}

/** Fetch + decode a music file and mono-mixdown it, then run `detectBeats`.
 * Runtime-only (Web Audio); not unit-tested. */
export async function analyzeMusicBeats(url: string, maxSec = 120): Promise<BeatResult> {
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
    return detectBeats(mono, sampleRate);
  } finally {
    void ctx.close();
  }
}
