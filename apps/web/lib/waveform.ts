/**
 * Waveform peak extraction (B-2a). Pure + side-effect-free so the downsampling
 * is unit-tested; the Studio <Waveform> component does the Web-Audio decode and
 * renders the returned peaks as SVG bars.
 */

/**
 * Downsample raw mono samples to `buckets` peak magnitudes in [0,1]. Each bucket
 * takes the max absolute amplitude of its slice, then the whole set is
 * normalized by the global max so quiet tracks still show their shape. An empty
 * input yields all-zero buckets (the component renders nothing for that).
 */
export function computePeaks(samples: ArrayLike<number>, buckets: number): number[] {
  const b = Math.max(1, Math.floor(buckets));
  const n = samples.length;
  if (n === 0) return new Array(b).fill(0);

  const size = Math.ceil(n / b);
  const peaks: number[] = [];
  for (let i = 0; i < b; i++) {
    const start = i * size;
    const end = Math.min(start + size, n);
    let max = 0;
    for (let j = start; j < end; j++) {
      const a = Math.abs(samples[j] ?? 0);
      if (a > max) max = a;
    }
    peaks.push(max);
  }

  const globalMax = peaks.reduce((m, p) => Math.max(m, p), 0);
  return globalMax > 0 ? peaks.map((p) => p / globalMax) : peaks;
}
