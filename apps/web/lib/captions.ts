export interface TranscriptSegment {
  text: string;
  startSec: number;
  endSec: number;
}

export interface CaptionMapOptions {
  timelineStartSec: number;
  sourceInSec: number;
  sourceOutSec: number;
  speed: number;
}

export interface CaptionOverlay {
  text: string;
  fromSec: number;
  toSec: number;
  position: 'bottom';
  font: 'sans';
  fade: true;
}

const MAX_CAPTION_CHARS = 90;

export function transcriptToCaptions(
  segments: TranscriptSegment[],
  opts: CaptionMapOptions,
): CaptionOverlay[] {
  const speed = Math.max(0.25, opts.speed || 1);
  const out: CaptionOverlay[] = [];
  for (const s of segments) {
    const text = (s.text ?? '').trim();
    if (!text) continue;

    const srcStart = Math.max(opts.sourceInSec, s.startSec);
    const srcEnd = Math.min(opts.sourceOutSec, Math.max(s.endSec, s.startSec + 0.3));
    if (srcEnd <= srcStart) continue;

    const fromSec = opts.timelineStartSec + (srcStart - opts.sourceInSec) / speed;
    const toSec = opts.timelineStartSec + (srcEnd - opts.sourceInSec) / speed;
    out.push({
      text: text.length > MAX_CAPTION_CHARS ? `${text.slice(0, MAX_CAPTION_CHARS - 1)}...` : text,
      fromSec: Math.max(0, Math.round(fromSec * 10) / 10),
      toSec: Math.max(fromSec + 0.3, Math.round(toSec * 10) / 10),
      position: 'bottom',
      font: 'sans',
      fade: true,
    });
  }
  return out;
}
