// useStudioExport — the render/export lifecycle (§C continuation state-lift).
//
// Owns the export SETTINGS (short-side res / fps / container + the settings
// popover open-state & anchor), the render HISTORY + its loader, the share-copied
// flag, and the render I/O: submit (`onExport`, building the full render-spec
// payload from the canonical project), poll-with-stall-guards (`pollRender`),
// `cancelRender`, and audio upload. `phase` (the central export STATUS, also used
// as the error channel by upload/tts/captions and to gate the preview) stays in
// StudioClient and is written here via the injected `setPhase`. Verbatim move —
// zero behaviour change; the floor + the api render-contract test guard it.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { trackEvent, PlausibleEvent } from '../_components/PlausibleEvents';
import { isIdentityTransform, isNeutralColor } from './_model';
import type {
  TClip,
  TText,
  PopText,
  TAudio,
  TSfx,
  Format,
  ExportPhase,
  RenderHistoryItem,
} from './_model';
import type { Track } from './_tracks';

/* ---- Render-poll stall guards (no infinite «Собираем…») ----
   Mirrors the /generate job poll: a per-fetch timeout, a queue-stall cutoff (a
   render still QUEUED long after submit means the worker isn't consuming), a
   connectivity cutoff (several failed polls in a row), and an overall deadline
   set just past the server render-reaper (30m) so the reaper's terminal status
   is normally what surfaces — the deadline is only the last-resort backstop. */
const RENDER_POLL_TIMEOUT_MS = 15_000;
const RENDER_QUEUE_STALL_MS = 90_000;
const RENDER_MAX_POLL_FAILS = 5;
const RENDER_DEADLINE_MS = 32 * 60_000;

export function useStudioExport({
  apiUrl,
  workspaceProjectId,
  timeline,
  tracks,
  texts,
  popText,
  music,
  voiceover,
  sfx,
  format,
  bgColor,
  playhead,
  totalDur,
  setPhase,
  setPlaying,
}: {
  apiUrl: string;
  workspaceProjectId?: string;
  timeline: TClip[];
  tracks: Track[];
  texts: TText[];
  popText: PopText | null;
  music: TAudio | null;
  voiceover: TAudio | null;
  sfx: TSfx[];
  format: Format;
  bgColor: string | null;
  playhead: number;
  totalDur: number;
  setPhase: React.Dispatch<React.SetStateAction<ExportPhase>>;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  // E9: export settings — short-side resolution, fps, container
  const [exportRes, setExportRes] = useState<'720' | '1080' | '1440' | '2160'>('1080');
  const [exportFps, setExportFps] = useState<'24' | '25' | '30' | '50' | '60'>('30');
  const [exportFmt, setExportFmt] = useState<'mp4' | 'mov'>('mp4');
  const [shareCopied, setShareCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportBtnRef = useRef<HTMLButtonElement | null>(null);
  const [history, setHistory] = useState<RenderHistoryItem[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/v1/studio/renders`, { credentials: 'include' });
      if (!res.ok) return;
      const body = (await res.json()) as { renders?: RenderHistoryItem[] };
      if (Array.isArray(body.renders)) setHistory(body.renders);
    } catch {
      /* transient */
    }
  }, [apiUrl]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  /* ---------- audio upload ---------- */
  async function uploadAudio(file: File): Promise<TAudio | null> {
    try {
      const extMatch = /\.([a-z0-9]+)$/i.exec(file.name);
      const ext = (extMatch?.[1] ?? 'mp3').toLowerCase();
      const res = await fetch(`${apiUrl}/v1/studio/upload-audio?ext=${ext}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
      const body = await res.json();
      return {
        url: body.url,
        name: file.name,
        gainDb: 0,
        fromSec: 0,
        fadeIn: false,
        fadeOut: false,
      };
    } catch (err) {
      setPhase({ kind: 'failed', message: err instanceof Error ? err.message : 'Ошибка загрузки' });
      return null;
    }
  }

  /* ---------- export ---------- */
  async function onExport() {
    if (timeline.length === 0) return;
    setPlaying(false);
    setPhase({ kind: 'uploading' });
    try {
      const res = await fetch(`${apiUrl}/v1/studio/render`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(workspaceProjectId ? { projectId: workspaceProjectId } : {}),
          clips: timeline.map((c, i) => ({
            url: c.url,
            ...(c.assetId ? { assetId: c.assetId } : {}),
            inSec: c.inSec,
            outSec: c.outSec,
            ...(c.speed !== 1 ? { speed: c.speed } : {}),
            ...(c.muted ? { muted: true } : {}),
            ...(c.volumeDb !== 0 ? { volumeDb: c.volumeDb } : {}),
            ...(c.filter !== 'none' ? { filter: c.filter } : {}),
            ...(i < timeline.length - 1 && c.transition !== 'cut'
              ? { transition: c.transition, transitionSec: c.transitionSec }
              : {}),
            ...(c.transform && !isIdentityTransform(c.transform) ? { transform: c.transform } : {}),
            ...(c.color && !isNeutralColor(c.color) ? { color: c.color } : {}),
            ...(c.reversed ? { reversed: true } : {}),
            ...(c.flipH ? { flipH: true } : {}),
            ...(c.flipV ? { flipV: true } : {}),
            ...(c.freeze ? { freeze: c.freeze } : {}),
            ...(c.speedCurve ? { speedCurve: c.speedCurve } : {}),
            ...(c.animIn ? { animIn: c.animIn } : {}),
            ...(c.animOut ? { animOut: c.animOut } : {}),
            ...(c.keyframes && Object.values(c.keyframes).some((a) => a && a.length)
              ? { keyframes: c.keyframes }
              : {}),
            ...(c.mask && c.mask.shape !== 'none' ? { mask: c.mask } : {}),
            ...(typeof c.opacity === 'number' && c.opacity < 1 ? { opacity: c.opacity } : {}),
            ...(c.blendMode && c.blendMode !== 'normal' ? { blendMode: c.blendMode } : {}),
          })),
          // Phase II/III.3: upper tracks render first-class via the alpha path.
          // Each upper-track clip carries its full RENDERABLE instrument set +
          // absolute startSec. Mask/blend/keyframes are gated out — the worker
          // can't honour them on a layer yet (preview==export discipline).
          ...(() => {
            const upper = tracks
              .slice(1)
              .map((tr) =>
                tr.clips.map((c) => ({
                  url: c.url,
                  ...(c.assetId ? { assetId: c.assetId } : {}),
                  inSec: c.inSec,
                  outSec: c.outSec,
                  startSec: c.startSec ?? 0,
                  ...(c.speed !== 1 ? { speed: c.speed } : {}),
                  ...(c.muted ? { muted: true } : {}),
                  ...(c.volumeDb !== 0 ? { volumeDb: c.volumeDb } : {}),
                  ...(c.filter !== 'none' ? { filter: c.filter } : {}),
                  ...(c.transform && !isIdentityTransform(c.transform)
                    ? { transform: c.transform }
                    : {}),
                  ...(c.color && !isNeutralColor(c.color) ? { color: c.color } : {}),
                  ...(c.reversed ? { reversed: true } : {}),
                  ...(c.flipH ? { flipH: true } : {}),
                  ...(c.flipV ? { flipV: true } : {}),
                  ...(c.speedCurve ? { speedCurve: c.speedCurve } : {}),
                  ...(c.animIn ? { animIn: c.animIn } : {}),
                  ...(c.animOut ? { animOut: c.animOut } : {}),
                  ...(typeof c.opacity === 'number' && c.opacity < 1 ? { opacity: c.opacity } : {}),
                })),
              )
              .filter((clips) => clips.length > 0);
            return upper.length > 0 ? { tracks: upper } : {};
          })(),
          music: music
            ? {
                url: music.url,
                // Omitted when 0 like clips/tracks/sfx: the worker treats a
                // missing gainDb as 0 (addTrack default), so this only trims bytes.
                ...(music.gainDb !== 0 ? { gainDb: music.gainDb } : {}),
                fromSec: music.fromSec,
                fadeIn: music.fadeIn,
                fadeOut: music.fadeOut,
                ...(music.duck ? { duck: music.duck } : {}),
              }
            : null,
          voiceover: voiceover
            ? {
                url: voiceover.url,
                ...(voiceover.gainDb !== 0 ? { gainDb: voiceover.gainDb } : {}),
                fromSec: voiceover.fromSec,
                fadeIn: voiceover.fadeIn,
                fadeOut: voiceover.fadeOut,
              }
            : null,
          // Timed SFX — only url/atSec/gainDb render; gainDb omitted when 0.
          ...(sfx.length > 0
            ? {
                sfx: sfx.map((s) => ({
                  url: s.url,
                  atSec: s.atSec,
                  ...(s.gainDb !== 0 ? { gainDb: s.gainDb } : {}),
                })),
              }
            : {}),
          texts: texts
            .filter((t) => t.text.trim())
            .map((t) => ({
              text: t.text,
              fromSec: t.fromSec,
              toSec: Math.max(t.toSec, t.fromSec + 0.2),
              position: t.position,
              font: t.font,
              fade: t.fade,
              ...(t.sizeFrac ? { sizeFrac: t.sizeFrac } : {}),
              ...(t.plate ? { plate: t.plate } : {}),
            })),
          // Word-pop captions («по словам») ride their own render lane (up to 400
          // words, ONE shared style) — separate from the 12-text `texts` cap.
          ...(popText && popText.words.length > 0
            ? {
                popText: {
                  font: popText.font,
                  position: popText.position,
                  ...(popText.sizeFrac ? { sizeFrac: popText.sizeFrac } : {}),
                  ...(popText.plate ? { plate: popText.plate } : {}),
                  words: popText.words.slice(0, 400).map((w) => ({
                    text: w.text.slice(0, 40),
                    fromSec: w.fromSec,
                    toSec: Math.max(w.toSec, w.fromSec + 0.05),
                  })),
                },
              }
            : {}),
          // E9: scale the format's aspect so its SHORT side hits the chosen
          // resolution (even dims for yuv420p)
          ...(() => {
            const k = Number(exportRes) / Math.min(format.width, format.height);
            const even = (n: number) => Math.round(n / 2) * 2;
            return { width: even(format.width * k), height: even(format.height * k) };
          })(),
          fps: Number(exportFps),
          format: exportFmt,
          ...(bgColor ? { background: { type: 'color' as const, color: bgColor } } : {}),
          // S7: cover-frame = the frame under the playhead at export time.
          coverSec: Math.round(Math.max(0, Math.min(playhead, totalDur)) * 10) / 10,
        }),
      });
      if (res.status === 403) {
        // Guest-CJM: anonymous sessions get signup_required — export is free
        // but needs a real account. The header CTA already says so; this is
        // the backstop for any other path into onExport.
        const body = await res.json().catch(() => null);
        if (body?.error === 'signup_required') {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        throw new Error(`render HTTP ${res.status}`);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.error === 'asset_unavailable') {
          throw new Error(
            typeof body.message === 'string'
              ? body.message
              : 'Материал недоступен. Замените его перед экспортом.',
          );
        }
        // Actionable RU copy per render refusal — what to change, Generate-style.
        if (body?.error === 'render_too_long') {
          throw new Error(
            'Таймлайн слишком длинный для экспорта. Укоротите его и попробуйте снова.',
          );
        }
        if (body?.error === 'render_bad_aspect') {
          throw new Error(
            'Неподдерживаемое соотношение сторон кадра. Измените формат и повторите.',
          );
        }
        if (body?.error === 'too_many_track_clips') {
          throw new Error('Слишком много клипов на верхних дорожках. Уберите лишние и повторите.');
        }
        if (body?.error === 'asset_not_owned') {
          throw new Error(
            'Один из материалов вам не принадлежит. Замените его своим файлом перед экспортом.',
          );
        }
        if (
          res.status === 429 &&
          (body?.error === 'too_many_active_renders' || body?.error === 'rate_limit_exceeded')
        ) {
          throw new Error(
            'Слишком много сборок одновременно. Дождитесь завершения текущей и повторите.',
          );
        }
        if (res.status === 404 || body?.error === 'project_mismatch') {
          throw new Error(
            'Проект не найден или относится к другому проекту. Обновите страницу и проверьте проект.',
          );
        }
        throw new Error(`render HTTP ${res.status}`);
      }
      const body = await res.json();
      setPhase({ kind: 'rendering', renderId: body.renderId });
      trackEvent(PlausibleEvent.studioExportStarted);
      void loadHistory();
      void pollRender(body.renderId);
    } catch (err) {
      setPhase({ kind: 'failed', message: err instanceof Error ? err.message : 'Ошибка экспорта' });
    }
  }

  async function pollRender(renderId: string, startedAt = Date.now(), fails = 0) {
    const elapsed = Date.now() - startedAt;
    // Overall deadline backstop: a render that never terminates (hung worker,
    // reaper down) must not spin «Собираем…» forever. The server render-reaper
    // normally flips it to failed first, which we surface above.
    if (elapsed > RENDER_DEADLINE_MS) {
      setPhase({
        kind: 'failed',
        message: 'Сборка заняла слишком много времени и была остановлена. Попробуйте ещё раз.',
      });
      return;
    }
    // Connectivity backstop: a single blip just retries; sustained loss surfaces
    // a clear error instead of spinning (and a blip no longer kills a long render).
    const retry = (nextFails: number) => {
      if (nextFails >= RENDER_MAX_POLL_FAILS) {
        setPhase({
          kind: 'failed',
          message: 'Потеряно соединение с сервером. Проверьте интернет и попробуйте снова.',
        });
        return;
      }
      setTimeout(() => void pollRender(renderId, startedAt, nextFails), 2500);
    };
    try {
      const res = await fetch(`${apiUrl}/v1/studio/renders/${renderId}`, {
        credentials: 'include',
        signal: AbortSignal.timeout(RENDER_POLL_TIMEOUT_MS),
      });
      if (res.status === 404) {
        setPhase({ kind: 'failed', message: 'Задача сборки не найдена. Попробуйте ещё раз.' });
        return;
      }
      if (!res.ok) {
        retry(fails + 1);
        return;
      }
      const body = await res.json();
      if (body.status === 'succeeded') {
        setPhase({ kind: 'done', url: body.resultUrl });
        trackEvent(PlausibleEvent.studioExportSucceeded);
        void loadHistory();
        return;
      }
      if (body.status === 'failed') {
        void loadHistory();
        setPhase({ kind: 'failed', message: body.errorMessage ?? 'Сборка не удалась' });
        return;
      }
      if (body.status === 'canceled') {
        void loadHistory();
        setPhase({ kind: 'idle' });
        return;
      }
      // Queue stall: still queued long after submit → the worker isn't consuming
      // the queue. Surface immediately instead of an endless spinner.
      if (body.status === 'queued' && elapsed > RENDER_QUEUE_STALL_MS) {
        void loadHistory();
        setPhase({
          kind: 'failed',
          message:
            'Сервис сборки сейчас перегружен — задача не начала выполняться. Попробуйте чуть позже.',
        });
        return;
      }
      setTimeout(() => void pollRender(renderId, startedAt, 0), 2500);
    } catch {
      // Network blip or poll-fetch timeout — retry within the deadline. The
      // deadline + fail-count guards above guarantee this can't loop forever.
      retry(fails + 1);
    }
  }

  async function cancelRender(renderId: string) {
    try {
      const res = await fetch(`${apiUrl}/v1/studio/renders/${renderId}/cancel`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`cancel HTTP ${res.status}`);
      setPhase({ kind: 'idle' });
      void loadHistory();
    } catch (err) {
      setPhase({
        kind: 'failed',
        message: err instanceof Error ? err.message : 'Не удалось отменить',
      });
    }
  }

  return {
    exportRes,
    setExportRes,
    exportFps,
    setExportFps,
    exportFmt,
    setExportFmt,
    exportOpen,
    setExportOpen,
    exportBtnRef,
    shareCopied,
    setShareCopied,
    history,
    onExport,
    cancelRender,
    uploadAudio,
  };
}
