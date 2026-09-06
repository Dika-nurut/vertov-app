// useStudioMedia — the Studio caption/import cluster (§C continuation state-lift):
// .srt/.vtt caption import and auto-captions (Deepgram/local Whisper). AI voice
// generation is deliberately disabled; user-uploaded voiceover tracks remain
// supported by the editor and renderer.
'use client';

import { useState } from 'react';
import type { TClip, TText, PopText, ExportPhase } from './_model';
import { clipOutDur } from './_model';
import { transcriptToCaptions, type TranscriptSegment } from '../../lib/captions';
import {
  parseSubtitles,
  chunkCaptionSegments,
  wordsToPopCaptions,
  mergePopWords,
  type WordSegment,
} from '../../lib/subtitle-import';
import { truncationMessage } from '../../lib/caption-truncation';
import { localTranscribe, LocalAsrError, type AsrProgress } from '../../lib/local-asr/service';
import { nextUid } from './_uid';

/** Which transcription engine backs auto-captions: the server (Deepgram) path or
 * whisper running locally in the user's browser (zero server cost, «бета»). */
export type CaptionEngine = 'server' | 'local';

export function useStudioMedia({
  apiUrl,
  engine,
  timeline,
  clipStarts,
  selectedIdx,
  setTexts,
  setPopText,
  setPhase,
}: {
  apiUrl: string;
  engine: CaptionEngine;
  timeline: TClip[];
  clipStarts: number[];
  selectedIdx: number;
  setTexts: React.Dispatch<React.SetStateAction<TText[]>>;
  setPopText: React.Dispatch<React.SetStateAction<PopText | null>>;
  setPhase: React.Dispatch<React.SetStateAction<ExportPhase>>;
}) {
  const [captioning, setCaptioning] = useState(false);
  // Local-ASR progress surface: download % on the first run, then «Распознаю…».
  // null when the local engine isn't running.
  const [asrProgress, setAsrProgress] = useState<AsrProgress | null>(null);

  /** S6: import an .srt/.vtt as caption blocks on the text track. */
  const onSrtUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const caps = parseSubtitles(String(reader.result));
      if (caps.length) {
        let kept = caps.length;
        setTexts((ts) => {
          // Same 12-text render cap as autoCaption (api renderSchema texts.max(12)).
          const room = Math.max(0, 12 - ts.length);
          kept = Math.min(caps.length, room);
          return [
            ...ts,
            ...caps.slice(0, room).map((c) => ({
              uid: nextUid(),
              font: 'sans' as const,
              fade: true,
              position: 'bottom' as const,
              ...c,
            })),
          ];
        });
        const message = truncationMessage(kept, caps.length, 'srt');
        if (message) setPhase({ kind: 'failed', message });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  /** Fetch transcript segments for a clip from whichever engine is selected.
   * Both return the SAME WordSegment[] shape so the downstream is engine-blind. */
  async function fetchSegments(clip: TClip): Promise<WordSegment[]> {
    if (engine === 'local') {
      // Transcribe only the trimmed selection: the 5-min local cap must apply to
      // the picked window, not the whole source. localTranscribe shifts results
      // back to source time so the offset math below is engine-blind.
      return localTranscribe(clip.url, {
        onProgress: (p) => setAsrProgress(p),
        inSec: clip.inSec,
        outSec: clip.outSec,
      });
    }
    const res = await fetch(`${apiUrl}/v1/studio/captions`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clipUrl: clip.url }),
    });
    if (!res.ok) throw new Error('Не удалось получить субтитры');
    const body = (await res.json()) as { segments?: WordSegment[] };
    return body.segments ?? [];
  }

  /** LINE captions: transcript → chunked blocks on the text track, honouring the
   * 12-text export cap. Shared by both engines. Returns a user-facing truncation
   * message when the cap dropped some captions, or null when everything fit. */
  function applyLineCaptions(
    segments: WordSegment[],
    targetIdx: number,
    clip: TClip,
  ): string | null {
    const caps = transcriptToCaptions(segments as TranscriptSegment[], {
      timelineStartSec: clipStarts[targetIdx] ?? 0,
      sourceInSec: clip.inSec,
      sourceOutSec: clip.outSec,
      speed: clip.speed,
    });
    const chunked = chunkCaptionSegments(caps);
    if (!chunked.length) return null;
    let kept = chunked.length;
    setTexts((prev) => {
      // Export schema caps texts at 12 (apps/api/src/studio.ts); keep the
      // earliest captions and drop the rest rather than break every export.
      const room = Math.max(0, 12 - prev.length);
      kept = Math.min(chunked.length, room);
      return [...prev, ...chunked.slice(0, kept).map((c) => ({ uid: nextUid(), ...c }))];
    });
    return truncationMessage(kept, chunked.length, 'auto');
  }

  /** WORD-POP captions («по словам»): one cue per spoken WORD, MERGED into the
   * project-wide popText lane rather than replacing it — the lane is one shared
   * list, so captioning clip B must not wipe clip A's words (Codex review). Drops
   * only THIS clip's timeline window before adding, so re-captioning a clip
   * replaces just its own words; style is first-write-wins. Returns false when the
   * segments carry no per-word timings so the caller can fall back to line
   * captions. Shared by both engines. */
  function applyPopCaptions(segments: WordSegment[], targetIdx: number, clip: TClip): boolean {
    const hasWords = segments.some((s) => s.words && s.words.length > 0);
    if (!hasWords) return false;
    const pops = wordsToPopCaptions(segments, {
      timelineStartSec: clipStarts[targetIdx] ?? 0,
      sourceInSec: clip.inSec,
      sourceOutSec: clip.outSec,
      speed: clip.speed,
    });
    if (pops.length) {
      const from = clipStarts[targetIdx] ?? 0;
      const range = { fromSec: from, toSec: from + clipOutDur(clip) };
      setPopText((prev) => {
        const words = mergePopWords(prev?.words ?? [], pops, range);
        return prev ? { ...prev, words } : { font: 'sans', position: 'center', words };
      });
    }
    return true;
  }

  /** Shared auto-caption core for both modes and both engines. `popMode` picks the
   * word-pop lane vs chunked line captions; the transcript source is `fetchSegments`. */
  async function runAutoCaption(popMode: boolean) {
    const targetIdx = selectedIdx >= 0 ? selectedIdx : 0;
    const clip = timeline[targetIdx];
    if (!clip || captioning) return;
    if (clip.reversed || clip.speedCurve || clip.freeze) {
      setPhase({
        kind: 'failed',
        message: 'Авто-субтитры пока доступны для обычных клипов без реверса, ramp и freeze.',
      });
      return;
    }
    setCaptioning(true);
    setAsrProgress(null);
    try {
      const segments = await fetchSegments(clip);
      if (popMode) {
        // Word-pop needs per-word timings; fall back to line captions (and say so)
        // when the engine didn't return them.
        const ok = applyPopCaptions(segments, targetIdx, clip);
        if (!ok) {
          const message = applyLineCaptions(segments, targetIdx, clip);
          setPhase({
            kind: 'failed',
            message: message
              ? `Провайдер не вернул тайминги слов — добавил обычные субтитры. ${message}`
              : 'Провайдер не вернул тайминги слов — добавил обычные субтитры.',
          });
        }
      } else {
        const message = applyLineCaptions(segments, targetIdx, clip);
        if (message) setPhase({ kind: 'failed', message });
      }
    } catch (err) {
      setPhase({
        kind: 'failed',
        message:
          engine === 'local'
            ? err instanceof LocalAsrError && err.code === 'busy'
              ? 'Распознавание уже идёт'
              : err instanceof Error
                ? err.message
                : 'Локальное распознавание не удалось.'
            : 'Сеть недоступна',
      });
    } finally {
      setCaptioning(false);
      setAsrProgress(null);
    }
  }

  const autoCaption = () => runAutoCaption(false);
  const autoCaptionWords = () => runAutoCaption(true);

  return {
    captioning,
    asrProgress,
    onSrtUpload,
    autoCaption,
    autoCaptionWords,
  };
}
