// Adaptive timeline ruler ticks (Phase III.2). The old ruler drew one tick per
// second with a label every 5s regardless of zoom — cramped when zoomed out,
// uselessly sparse when zoomed in. This picks a "nice" labelled interval so
// labels stay ~minLabelPx apart at any zoom, with minor ticks subdividing it,
// and formats labels as clock time (M:SS) once the edit runs past a minute.
//
// Pure + dependency-free so it unit-tests in a plain node env.

/** Human-friendly tick intervals in seconds (ascending). */
const NICE_SEC = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900];

export interface RulerTick {
  /** Tick time in seconds. */
  sec: number;
  /** Major ticks are taller and carry a label. */
  major: boolean;
  /** Label text (major ticks only). */
  label?: string;
}

/** Round to ms to kill float drift when accumulating fractional intervals. */
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Format a ruler label. Clock (`M:SS`) once the span ≥ 60s; otherwise seconds
 *  (`2s`, or `2.5s` when the interval is sub-second so the decimal matters). */
export function fmtRulerLabel(sec: number, useClock: boolean, decimals: boolean): string {
  if (useClock) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    // a rounding artefact can push s to 60 — carry it.
    return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
  }
  return decimals ? `${r3(sec).toFixed(1)}s` : `${Math.round(sec)}s`;
}

/** Minor-tick subdivisions per major interval — keep them visually even. */
function minorDiv(major: number): number {
  if (major < 1) return 2; // 0.5 → 0.25
  if (major <= 5) return 5; // 1/2/5 → fifths
  if (major <= 30) return 5; // 10/15/30 → fifths
  return 4; // 60+ → quarters
}

/**
 * Build the tick list for a ruler `span` seconds wide at `pps` px/sec. The
 * smallest NICE interval whose on-screen width ≥ `minLabelPx` becomes the major
 * (labelled) interval; minor ticks subdivide it. Always covers ≥10s so a tiny
 * project still shows a usable scale.
 */
export function rulerTicks(spanSec: number, pps: number, minLabelPx = 66): RulerTick[] {
  const span = Math.max(spanSec, 10);
  const safePps = pps > 0 ? pps : 1;
  const major = NICE_SEC.find((n) => n * safePps >= minLabelPx) ?? NICE_SEC[NICE_SEC.length - 1]!;
  const minor = major / minorDiv(major);
  const useClock = span >= 60;
  const decimals = major < 1;
  const ticks: RulerTick[] = [];
  const end = Math.ceil(span / minor) * minor;
  for (let i = 0; r3(i * minor) <= end + 1e-6; i++) {
    const sec = r3(i * minor);
    // major when sec is an integer multiple of the major interval
    const isMajor = Math.abs(sec / major - Math.round(sec / major)) < 1e-6;
    ticks.push(
      isMajor
        ? { sec, major: true, label: fmtRulerLabel(sec, useClock, decimals) }
        : { sec, major: false },
    );
  }
  return ticks;
}
