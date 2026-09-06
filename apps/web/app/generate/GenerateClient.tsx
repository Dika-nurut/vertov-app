'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
// Icons: Phosphor (the project's chosen family), aliased to the prior lucide
// names so call-sites stay unchanged. Default weight reads crisp on dark.
import {
  ArrowRight,
  Check,
  ImageSquare as ImageIcon,
  CircleNotch as Loader2,
  DownloadSimple as Download,
  ShareNetwork as Share2,
  SpeakerHigh,
  SpeakerSlash,
  ArrowsClockwise as RefreshCw,
  ArrowCounterClockwise as RotateCcw,
  Plus,
  ArrowsOut as Maximize2,
  Minus,
  Wallet,
  Info,
  Clock,
  Rectangle as RectangleHorizontal,
  MonitorPlay,
  SlidersHorizontal,
  Crop,
  Stack as Layers,
  SquaresFour,
  FilmSlate as Film,
  LockSimple as Lock,
  FilmReel as Clapperboard,
  PencilSimple as Pencil,
  At as AtSign,
  Lightning as Zap,
  X,
  Repeat,
  Scissors,
  Eye,
} from '@phosphor-icons/react/dist/ssr';
import { invalidateBalance, BALANCE_INVALIDATE_EVENT } from '../_components/BalanceWidget';
import { FREE_MEDIA_RETENTION_COPY } from '@seed/shared/media-retention';
import { lockedModelCtaLabel, subscriptionTierAllows, subscriptionTierRank } from './entitlements';
import { JOB_EVENT, JOB_SUBMITTED_EVENT } from '../_components/JobsTray';
import { jobEventAction, type JobBusEvent } from '@/lib/job-events';
import {
  fmtClock,
  fmtEtaHint,
  inflightGenerationsReducer,
  inflightProgressPct,
  inflightStageLabel,
  inflightStatus,
  isActiveInflightJobStatus,
  restoreOwnedInflightJobs,
  type InflightGeneration,
} from '@/lib/inflight-generations';
import { jobFailureGuidance } from '@/lib/job-failure';
import { isModelLocked, tierRank, TIER_LABEL } from '@/lib/model-tier';
import { Button } from '@/components/ui/button';
import { TokenStar } from '@/components/ui/token-star';
import { PixelGlyph } from '@/components/ui/pixel-glyph';
import { assetSrc } from '@/lib/asset-src';
import type { Locale } from '@/lib/locale';
import { postOnboarding } from '@/lib/onboarding-state';
import { useMediaQuery } from '@/lib/use-media-query';
import { OnboardingTour } from '../_components/OnboardingTour';
import { modelDisplayName, modelDisplayNameFromId } from '@/lib/models';
import {
  videoDurations,
  videoResolutions,
  videoAspectRatios,
  videoMediaCaps,
  snapDuration,
  capabilitySigns,
  supportsAudioControl,
  supportsNegativePrompt,
  type ModelCaps,
} from '@/lib/model-capabilities';
import {
  modelCardName,
  modelCards,
  videoMediaLimits,
  videoMediaParams,
  videoPriceParams,
  type ModelCard,
} from '@/lib/generate-model-cards';
import {
  unfilledRequiredSlots,
  type PresetMergeMode,
  type PresetSlot,
} from '@seed/shared/preset-merge';
import { composeSubmitPrompt } from '@/lib/preset-submit';
import {
  QUOTE_PLACEHOLDER_PROMPT,
  estimatePriceToShow,
  hasKnownJobEstimate,
  recalculatingPriceToShow,
  useJobEstimate,
} from '@/lib/useJobEstimate';
import { cardVisual } from '../../lib/visual-hash';
import { PillControl } from './PillControl';
import { MediaPicker, type MediaPickerItem } from './MediaPicker';
import { PromptEditor } from './PromptEditor';
import {
  hasAcceptedReferenceMedia,
  ReferenceDropZone,
  referenceRequiredCopy,
  type ReferenceMediaItem,
} from './ReferenceDropZone';
import { GenerateSteps } from './GenerateSteps';
import { GenerationsGrid, type GenerationTile, type GenFilter } from './GenerationsGrid';
import { ModelEffectPicker } from './ModelEffectPicker';
import { uploadMediaFile } from '../../lib/upload';
import { haptics } from '../../lib/haptics';
import { sound } from '../../lib/sound';
import { trackEvent, PlausibleEvent } from '../_components/PlausibleEvents';
import { SupportLink } from '../_components/SupportLink';
import { useProjectContext } from '../_components/ProjectContextProvider';
import { withProjectContext } from '@/lib/project-context';
import {
  boardImageQualitiesFor,
  boardImageQualityLabel,
  pickSignedRung,
} from '@seed/shared/board-contract';

export interface ModelRow {
  id: string;
  family: string;
  variant: string;
  displayName?: string | null;
  kind: 'image' | 'image-edit' | 'video' | 'voice';
  /**
   * Cheapest per-unit credit rate across the model's active workbook rows, as
   * projected by /v1/models (`minUnitCredits`). Ordering-only: the actual charge
   * always comes from the estimate/submit price resolution.
   */
  minUnitCredits: number;
  unitKind: 'image' | 'second' | '1k_chars';
  maxResolution: string | null;
  maxDurationSeconds: number | null;
  capabilities?: Record<string, unknown> | null;
  // Minimum plan tier required (P-B2/DEC-3). May be absent on older API rows.
  tierMin?: string | null;
  /** Median provider latency (ms) — drives the progress ETA. */
  expectedLatencyMsP50?: number | null;
}

/**
 * The draft chip promises a runnable 480p render, so a fast model qualifies only when its
 * capability bag explicitly offers that rung. An absent resolution menu is not evidence of
 * support: the chip must disappear rather than promise a cheaper render the selected
 * provider cannot deliver (owner ruling 2026-08-10).
 *
 * «Черновик» must also stay runnable from a bare prompt — the fast reference twin matches
 * /fast/ too but demands an attachment, which is what the `role !== 'reference'` clause
 * excludes.
 */
export function isDraftVideoCandidate(model: ModelCaps): boolean {
  return (
    /fast/i.test(model.id ?? '') &&
    videoMediaCaps(model).role !== 'reference' &&
    videoResolutions(model)?.includes('480p') === true
  );
}

/**
 * Generate's video resolution menu for the selected model.
 *
 * An explicitly EMPTY `resolutions` array is a CONTRACT, not missing metadata: the provider
 * renders one fixed output and the customer has no lever. `videoResolutions` collapses both
 * cases to null, so the legacy triple below was once being offered to models that declare no
 * rungs — Gemini Omni showed 480p and 1080p against a single signed 720p row, i.e. two
 * options no leg sells. `priceSelectorFromParams` and the Board's image controls already read
 * an empty list this way; the video picker did not. (Pricing is unaffected either way — an
 * empty declared list pins the price key to 'default' regardless of what the request carries.)
 *
 * Fast Seedance models do not support 1080p. Super-resolution was removed: no active backend
 * advertises or serves an upscale capability.
 *
 * Pure and exported so the Boards↔Generate parity test drives the EXACT list the component
 * renders rather than a copy of this logic — a copy would assert itself, not the product.
 */
export function generateVideoResolutionOptions(
  // `ModelCaps` rather than this file's `ModelRow`: the only fields read are the id, the
  // capability bag and `maxResolution`, and typing it structurally lets the Boards parity
  // test drive this with a raw seed row instead of casting one into a UI type.
  model: ModelCaps | null | undefined,
  isVideo: boolean,
): string[] {
  const vResolutions = isVideo && model ? videoResolutions(model) : null;
  const isFastVideo = isVideo && /fast/i.test(model?.id ?? '');
  const declaredResolutionList = (model?.capabilities as Record<string, unknown> | undefined)?.[
    'resolutions'
  ];
  const declaresNoResolutionLever =
    isVideo && Array.isArray(declaredResolutionList) && declaredResolutionList.length === 0;
  return vResolutions
    ? vResolutions
    : declaresNoResolutionLever
      ? [model?.maxResolution ?? '720p']
      : isFastVideo
        ? ['480p', '720p']
        : ['480p', '720p', '1080p'];
}

type VAspect = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | 'adaptive';
type ReferenceKind = 'image' | 'video' | 'audio';
type ReferenceAttachment = {
  id: string;
  kind: ReferenceKind;
  url: string;
};
const VIDEO_ASPECTS: VAspect[] = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
// Proportional w×h (px) for the little frame-shape icon on each ratio button.
const VASPECT_ICON: Record<VAspect, { w: number; h: number }> = {
  '16:9': { w: 16, h: 9 },
  '9:16': { w: 9, h: 16 },
  '1:1': { w: 13, h: 13 },
  '4:3': { w: 15, h: 11 },
  '3:4': { w: 11, h: 15 },
  '21:9': { w: 18, h: 8 },
  adaptive: { w: 14, h: 11 },
};
type Phase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'polling'; jobId: string; status: string }
  // The finished receipt must be derived from the persisted workflow, never
  // from mutable controls in the form. A user can change model/resolution while
  // a render is running, and showing those new controls under an old result is
  // materially misleading (e.g. 720p below a real 1080p video).
  | {
      kind: 'done';
      jobId: string;
      assets: string[];
      modelId?: string;
      model?: ResultModel;
      params?: Record<string, unknown>;
      creditsReserved?: number;
    }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string; stillRunning?: boolean; jobId?: string; modelId?: string }
  | { kind: 'insufficient' };

type ResultModel = {
  family: string;
  variant: string;
  displayName?: string | null;
  kind: string;
  capabilities?: Record<string, unknown> | null;
};

interface SizeOption {
  id: string;
  ratio: string;
  label: string;
  w: number;
  h: number;
}

function sizesFor(_maxResolution: string | null): SizeOption[] {
  // Seedream (via Evolink) takes a ratio + quality. Offer the common ratios;
  // the id IS the ratio string sent to the API, quality is fixed at 2K.
  return [
    { id: '1:1', ratio: '1:1', label: 'Квадрат', w: 1, h: 1 },
    { id: '3:4', ratio: '3:4', label: 'Портрет', w: 3, h: 4 },
    { id: '16:9', ratio: '16:9', label: 'Альбом', w: 16, h: 9 },
    { id: '9:16', ratio: '9:16', label: 'Сторис', w: 9, h: 16 },
  ];
}

/* ---- Client-side stall guards (no infinite loading) ----
   A wedged backend must never spin the UI forever. Every in-flight job is
   bounded by: a per-fetch timeout (a hung socket can't stall a poll); a
   queue-stall cutoff (a job still QUEUED long after submit means the worker
   isn't consuming → fail fast, nothing was charged); a connectivity cutoff
   (several failed polls in a row → surface a clear error); and an overall
   render deadline (a job that never reaches a terminal status is abandoned
   with a clear message). The server reaper refunds reserved credits. */
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_FETCH_TIMEOUT_MS = 15_000;
const QUEUE_STALL_MS = 90_000;
const MAX_POLL_FAILS = 5;
/** Shown when the deadline passes with no terminal status — the job keeps
 *  rendering server-side and lands in «Архив» + the tray. Used by both the poll
 *  loop and the clock-tick backstop. */
const STILL_RENDERING_MSG =
  'Рендер занимает дольше обычного — он продолжается в фоне. Готовый ролик появится в «Архиве» и в трее. Токены спишутся только при успешной генерации.';
/** Generous per-job render deadline scaled off the model's median latency,
 *  floored per kind and capped just above the server reaper (~15 min). */
function renderDeadlineMs(latencyP50: number | null | undefined, video: boolean): number {
  const floor = video ? 360_000 : 120_000; // 6 min video · 2 min image
  const scaled = latencyP50 ? latencyP50 * 5 : 0;
  return Math.min(Math.max(floor, scaled), 960_000); // hard cap 16 min
}
/** Friendly wording for a fetch that timed out / aborted vs a generic error. */
function networkErrorMessage(err: unknown): string {
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'Сервер не ответил вовремя. Проверьте соединение и попробуйте снова.';
  }
  return err instanceof Error ? err.message.slice(0, 120) : 'Сетевая ошибка';
}

function randomKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const OWNED_GENERATE_JOBS_KEY = 'vertov:generate-owned-jobs';
const OWNED_GENERATE_JOB_MAX = 24;
const OWNED_GENERATE_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const OWNED_GENERATE_RESTORE_MAX_PAGES = 10;
const REPEAT_REFERENCE_TIMEOUT_MS = 4_000;

type OwnedGenerateJob = { id: string; submittedAt: number };

function readOwnedGenerateJobs(): OwnedGenerateJob[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(OWNED_GENERATE_JOBS_KEY) ?? '[]');
    const cutoff = Date.now() - OWNED_GENERATE_JOB_TTL_MS;
    const jobs = Array.isArray(parsed)
      ? parsed.filter(
          (job): job is OwnedGenerateJob =>
            typeof job === 'object' &&
            job !== null &&
            typeof (job as OwnedGenerateJob).id === 'string' &&
            typeof (job as OwnedGenerateJob).submittedAt === 'number' &&
            (job as OwnedGenerateJob).submittedAt >= cutoff,
        )
      : [];
    const bounded = jobs
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, OWNED_GENERATE_JOB_MAX);
    sessionStorage.setItem(OWNED_GENERATE_JOBS_KEY, JSON.stringify(bounded));
    return bounded;
  } catch {
    sessionStorage.removeItem(OWNED_GENERATE_JOBS_KEY);
    return [];
  }
}

function rememberOwnedGenerateJob(jobId: string): void {
  const jobs = readOwnedGenerateJobs().filter((job) => job.id !== jobId);
  jobs.unshift({ id: jobId, submittedAt: Date.now() });
  sessionStorage.setItem(
    OWNED_GENERATE_JOBS_KEY,
    JSON.stringify(jobs.slice(0, OWNED_GENERATE_JOB_MAX)),
  );
}

function forgetOwnedGenerateJob(jobId: string): void {
  sessionStorage.setItem(
    OWNED_GENERATE_JOBS_KEY,
    JSON.stringify(readOwnedGenerateJobs().filter((job) => job.id !== jobId)),
  );
}

/** Per-URL media check — a video job with return_last_frame returns mp4 + png. */
function isVideoAsset(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

/**
 * The `quality`/`resolution` value Generate sends for an image model, derived
 * from its whole capability bag — the ONE place estimate and submit compute it,
 * so they can never disagree (pricing-resolver.ts's `priceSelectorFromParams`
 * keys the charge on this same field). Finance's signed `default_resolution` is
 * primary when it is one of the model's declared resolutions. For un-seeded models,
 * `'2K'` when declared remains the fallback; otherwise use the middle entry of a
 * non-empty declared list (e.g. gpt-image-2's `['low','medium','high']` → `'medium'`);
 * otherwise omit the field.
 */
export function resolveImageQuality(capabilities: unknown): string | undefined {
  const resolutions =
    capabilities && typeof capabilities === 'object'
      ? (capabilities as Record<string, unknown>)['resolutions']
      : undefined;
  if (!Array.isArray(resolutions) || resolutions.length === 0) return undefined;
  const middle = resolutions[Math.floor((resolutions.length - 1) / 2)];
  const legacyDefault = resolutions.includes('2K')
    ? '2K'
    : typeof middle === 'string'
      ? middle
      : undefined;
  return pickSignedRung(resolutions, capabilities, undefined, legacyDefault);
}

/**
 * Resolve the video rung used by both the estimate and submit paths. The user pick
 * must stay separate from the derived default: pre-filling the pick with `'720p'`
 * made it impossible for finance's signed default to apply when the customer touched
 * nothing. A null pick therefore gets the signed default first, while an explicit pick
 * still wins and un-seeded models retain the historical `'720p'` fallback.
 */
/**
 * "The customer has not picked a rung." The pick must be representable as absent: while
 * this state was pre-filled with the literal `'720p'` — a rung EVERY video model offers —
 * {@link resolveVideoResolution} returned it before it ever consulted finance's signed
 * default, so veo-3-1 opened on 720p and grok-imagine-video on 720p (69 credits) instead
 * of the signed 480p (37). The helper was correct throughout; the value feeding it was not.
 *
 * Exported so the tests exercise the same symbol the state initialises with, which is as
 * close to first paint as this suite reaches — apps/web has no DOM environment, so nothing
 * here renders the component. Re-pinning the initialiser to a literal would therefore pass
 * the suite; that case belongs to the e2e floor, not to a unit test pretending to cover it.
 */
export const NO_VIDEO_RESOLUTION_PICK = null;

export function resolveVideoResolution(
  resolution: string | null,
  resolutionOptions: readonly string[],
  capabilities: unknown,
): string {
  return pickSignedRung(resolutionOptions, capabilities, resolution, '720p') ?? '720p';
}

/**
 * «Повторить» replays a past job's params verbatim. That breaks when a model gains a
 * rung ladder after the job ran: the stored params carry no `resolution`, and the price
 * resolver keys a rung-less request on the literal `'default'`, which has no active row
 * once the model declares a menu — so the repeat dead-ends on `config_not_available`
 * instead of the price refusal the button is designed around.
 *
 * flux-2-pro is the case that forced it (rev. 14 re-banded `default` → `1K` and opened
 * `2K`), and there the filled rung is not a guess: `buildKieImageBody` PINNED `'1K'`
 * while flux sold one sizeless rung, so every historical job rendered at 1K and cost the
 * 11 credits that rung still costs. Filling the cheapest declared rung reproduces the
 * original job rather than approximating it.
 *
 * A rung the params DO carry is never touched, and a model with no declared menu is left
 * exactly as it was.
 */
export function withLegacyRung(
  params: Record<string, unknown>,
  model: { capabilities?: Record<string, unknown> | null } | null | undefined,
): Record<string, unknown> {
  if (typeof params['resolution'] === 'string') return { ...params };
  const declared = model?.capabilities?.['resolutions'];
  if (!Array.isArray(declared) || declared.length === 0) return { ...params };
  const cheapest = declared[0];
  return typeof cheapest === 'string' ? { ...params, resolution: cheapest } : { ...params };
}

/** A manual quality pick applies only to the model on which it was made. */
export function imageQualityForModel(
  modelId: string,
  selected: { modelId: string; quality: string } | null,
  options: readonly string[],
  fallback: string | undefined,
): string | undefined {
  return selected?.modelId === modelId && options.includes(selected.quality)
    ? selected.quality
    : fallback;
}

/** Every deliberate model pick invalidates video-only draft mode. */
export function modelSelectionState(modelId: string): { modelId: string; draft: false } {
  return { modelId, draft: false };
}

/** A preset's rung follows the model it targets; image and video keep separate state. */
export function presetResolutionState(
  target: Pick<ModelRow, 'kind'> | null | undefined,
  targetModelId: string | null | undefined,
  currentModelId: string,
  resolution: string,
  /** Where the rung goes when the preset names a model we cannot see — a retired or
   * deactivated row drops out of the catalogue, and guessing "image" there would file a
   * video preset's rung under the image selector. Fall back to the mode on screen. */
  currentKind: 'image' | 'video',
): {
  imageQuality: { modelId: string; quality: string } | null;
  videoResolution: { modelId: string; resolution: string } | null;
} {
  const modelId = targetModelId ?? currentModelId;
  const kind = target?.kind ?? currentKind;
  return kind === 'video'
    ? { imageQuality: null, videoResolution: { modelId, resolution } }
    : { imageQuality: { modelId, quality: resolution }, videoResolution: null };
}

/** Repeat shows the receipt's reservation, with a stale-price acknowledgement as fallback. */
export function repeatCostForJob(
  jobId: string,
  creditsReserved: unknown,
  acknowledged: { jobId: string; cost: number } | null,
): number | null {
  if (typeof creditsReserved === 'number' && creditsReserved > 0) return creditsReserved;
  return acknowledged?.jobId === jobId ? acknowledged.cost : null;
}

/** Image-only request fields assembled once for the quote and final submit. */
export function imageGenerationParams(
  size: string,
  imageQuality: string | undefined,
  count: number,
  imageUrls: readonly string[] | undefined = undefined,
): Record<string, unknown> {
  return {
    size,
    // The API's image adapter and price resolver both key this axis on
    // `resolution`, including vendor words such as low/medium/high.
    ...(imageQuality ? { resolution: imageQuality } : {}),
    n: count,
    ...(imageUrls?.length ? { imageUrls } : {}),
  };
}

/**
 * Video multi-take submits fan out to one job per take, each reserving the
 * server quote. Images remain one server-side batch, whose quote already
 * includes `n`.
 */
export function totalGenerateCost(
  quotedCost: number | null,
  count: number,
  isVideo: boolean,
): number | null {
  if (quotedCost === null || !isVideo) return quotedCost;
  return quotedCost * count;
}

/* --------------------------- Small UI atoms -------------------------- */

const STATUS_META: Record<Phase['kind'], { label: string; dot: string; text: string }> = {
  idle: {
    label: 'Готово к работе',
    dot: 'bg-[color:var(--color-faint)]',
    text: 'text-[color:var(--color-faint)]',
  },
  submitting: {
    label: 'Запуск…',
    dot: 'bg-[color:var(--color-accent)]',
    text: 'text-[color:var(--color-accent)]',
  },
  polling: {
    label: 'Генерация…',
    dot: 'bg-[color:var(--color-accent)]',
    text: 'text-[color:var(--color-accent)]',
  },
  done: { label: 'Готово', dot: 'bg-positive', text: 'text-positive' },
  failed: { label: 'Ошибка', dot: 'bg-destructive', text: 'text-destructive' },
  unavailable: { label: 'Недоступно', dot: 'bg-destructive', text: 'text-destructive' },
  insufficient: { label: 'Нужны токены', dot: 'bg-destructive', text: 'text-destructive' },
};

function StatusBadge({ kind }: { kind: Phase['kind'] }) {
  const m = STATUS_META[kind];
  const animated = kind === 'submitting' || kind === 'polling';
  const isError = kind === 'failed' || kind === 'insufficient';
  // Errors stay coral; every other state is the lime status chip (owner: same
  // green as the «кр» chip). Borderless — no «lame» bone outline.
  if (isError) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] bg-[rgba(var(--destructive-rgb),0.16)] px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-destructive)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-destructive)]" />
        {m.label}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em]"
      style={{ background: 'var(--color-accent2)', color: 'var(--color-accent2-foreground)' }}
    >
      <span
        className={
          'h-1.5 w-1.5 rounded-full bg-[color:var(--color-accent2-foreground)] ' +
          (animated ? 'seed-pulse-dot' : '')
        }
      />
      {m.label}
    </span>
  );
}

/** Subscription plan info for "plan + cycle" cost framing. */
export interface PlanInfo {
  tier: string;
  title: string | null;
  creditsPerCycle: number;
  remainingThisCycle: number;
  usedThisCycle: number;
  currentPeriodEnd: string;
}

/** Example/preset pack for the idle gallery (P-M1) and the /presets catalog. */
export interface PresetRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  modelId: string;
  /** Catalogue identity for labels; null when a historical preset's model is gone. */
  model?: { family: string; variant: string; displayName?: string | null } | null;
  promptTemplate: string;
  paramsJson: Record<string, unknown>;
  samplePreviewUrl: string;
  // Optional because web and API deploy independently; an older API may not expose these yet.
  previewWidth?: number | null;
  previewHeight?: number | null;
  /** Catalog facet: scene | camera | effect | style (absent on older rows). */
  category?: string;
  /** 'image' → the preset wants a user photo (i2v input slot). */
  inputKind?: string;
  /** How promptTemplate merges with the user's prompt (default: replace). */
  mergeMode?: PresetMergeMode;
  /** {key} slot definitions for slots-mode templates. */
  slots?: PresetSlot[];
  /** Negative prompt sent to engines that accept it (image diffusion). */
  negativePrompt?: string;
  /** image | video — separates image cinema presets from video motion chips. */
  modality?: string;
  /** >1 → generates a series of N outputs (capped at 4); 1 = ordinary preset. */
  seriesCount?: number;
  /** Bundled reference images auto-applied when this preset is chosen. */
  referenceAssetUrls?: string[];
}

/** Short RU label for the applied-preset chip, by catalog facet. */
function presetKindLabel(category?: string): string {
  switch (category) {
    case 'camera':
      return 'Кино';
    case 'style':
      return 'Стиль';
    case 'effect':
      return 'Эффект';
    default:
      return 'Пресет';
  }
}

/* --------------------------- Result states --------------------------- */

function FailedState({
  message,
  onRetry,
  stillRunning = false,
  jobId,
  modelId,
}: {
  message: string;
  onRetry: () => void;
  stillRunning?: boolean;
  jobId?: string;
  modelId?: string;
}) {
  // `stillRunning` = the client stopped watching at its deadline, but the job is
  // NOT failed — it keeps rendering server-side and lands in «Архив» + the tray.
  // Neutral (accent) tone, not the destructive treatment, and NO refund claim
  // (a job that finishes is charged, not refunded).
  const tone = stillRunning ? 'var(--color-accent)' : 'var(--color-destructive)';
  return (
    <div
      data-testid="error-state"
      className="seed-fade-up rounded-[var(--radius-md)] border-[2.5px] bg-[color:var(--color-surface)] p-6 sm:p-8"
      style={{ borderColor: tone, boxShadow: `5px 5px 0 0 ${tone}` }}
    >
      <p className="eyebrow" style={{ color: tone }}>
        {stillRunning ? 'Долго рендерится' : 'Сбой генерации'}
      </p>
      <h3 className="mt-2 font-display text-xl font-black uppercase tracking-[-0.01em] text-[color:var(--color-fg)]">
        {stillRunning ? 'Рендер ещё идёт' : 'Не удалось сгенерировать'}
      </h3>
      <p className="mt-2 max-w-md text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        {message}
      </p>
      {!stillRunning && (
        /* Refund is async — don't assert it landed; the failed path above
           already re-polled the balance via invalidateBalance(). */
        <p className="mt-2 flex items-center gap-1.5 text-[13px] text-[color:var(--color-positive)]">
          <Check size={14} /> Возврат токенов обрабатывается — баланс обновится автоматически.
        </p>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="press-inset mt-6 inline-flex h-10 items-center gap-2 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 text-[13px] font-semibold text-[color:var(--color-fg)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors hover:bg-[color:var(--color-surface2)]"
      >
        <RefreshCw size={16} /> {stillRunning ? 'Новая генерация' : 'Попробовать снова'}
      </button>
      {!stillRunning && (
        <SupportLink
          href={`mailto:support@vertov.space?subject=Vertov+issue&body=Job:+${jobId ?? ''}%0AModel:+${modelId ?? ''}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block text-center text-[13px] text-[color:var(--color-muted-foreground)] underline transition-colors hover:text-[color:var(--color-accent)]"
        >
          Не помогло? Напишите в поддержку — приложим логи. Ответим в течение 5 рабочих дней.
        </SupportLink>
      )}
    </div>
  );
}

function UnavailableState({ message, onReset }: { message: string; onReset: () => void }) {
  return (
    <div className="seed-fade-up rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-6 shadow-[5px_5px_0_0_var(--color-shadow)] sm:p-8">
      <p className="eyebrow text-[color:var(--color-muted-foreground)]">Параметры недоступны</p>
      <h3 className="mt-2 font-display text-xl font-black uppercase tracking-[-0.01em] text-[color:var(--color-fg)]">
        Рецепт не сохранён
      </h3>
      <p className="mt-2 max-w-md text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        {message}
      </p>
      <button
        type="button"
        onClick={onReset}
        className="press-inset mt-6 inline-flex h-10 items-center gap-2 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 text-[13px] font-semibold text-[color:var(--color-fg)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors hover:bg-[color:var(--color-surface2)]"
      >
        <Plus size={16} /> Создать ещё
      </button>
    </div>
  );
}

function InsufficientState({ balance, cost }: { balance: number; cost: number }) {
  return (
    <div className="seed-fade-up rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-6 shadow-[5px_5px_0_0_var(--color-shadow)] sm:p-8">
      <div className="flex items-baseline justify-between gap-4">
        <p className="eyebrow text-[color:var(--color-muted-foreground)]">Баланс</p>
        <p className="tnum inline-flex items-center gap-1 text-[13px] text-[color:var(--color-faint)]">
          <TokenStar size={11} />
          {balance} / {cost}
        </p>
      </div>
      <h3 className="mt-2 max-w-lg font-display text-xl font-black uppercase tracking-[-0.01em] text-[color:var(--color-fg)]">
        Ещё немного — и кадр твой
      </h3>
      <p
        className="mt-2 max-w-md text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]"
        data-testid="error-message"
      >
        Недостаточно токенов. Для этой генерации нужно <TokenStar size={11} /> {cost}. Пополни счёт
        — обычно это занимает меньше минуты.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <a
          href="/pricing"
          className="press-inset inline-flex h-10 items-center gap-2 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors"
        >
          <Wallet size={16} /> Пополнить баланс
        </a>
        <a
          href="/pricing"
          className="text-[13px] text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-fg)]"
        >
          Все тарифы
        </a>
      </div>
    </div>
  );
}

/* ------------------------------ Screen ------------------------------- */

type Gateway = 'openrouter' | 'atlascloud';

export function GenerateClient({
  models: allModels,
  apiUrl,
  fromJobId,
  viaSlug = null,
  initialPreset = null,
  initialPrompt = null,
  initialModelId = null,
  initialDuration = null,
  initialCount = null,
  initialBalance = 0,
  plan: initialPlan = null,
  planTier = null,
  isAnonymous = false,
  lockedCtaHref = '/pricing',
  initialPaidMediaStorage = false,
  onboarding = false,
  locale = 'ru',
  devTools = false,
}: {
  models: ModelRow[];
  apiUrl: string;
  fromJobId: string | null;
  /** Public showcase slug this remix came from (/g/:slug, J-2 follow-up).
   *  When the visitor is not the job owner, /v1/jobs/:id 404s and the prefill
   *  fetch falls back to the public /v1/g/:slug/prefill recipe. */
  viaSlug?: string | null;
  /** Preset prefill from /generate?preset=<slug> (fetched server-side). */
  initialPreset?: PresetRow | null;
  /** Prompt prefill from /generate?prompt=… (landing prompt bar, kept through login). */
  initialPrompt?: string | null;
  /** Kinobar prefills from /generate?model=…&sec=…&n=… (landing hero, 2026-07-06).
   *  model also flips the initial mode to video when it names a video model;
   *  it is honored only if present in the catalog AND usable on the plan;
   *  an anonymous guest is the deliberate pre-paywall exception. */
  initialModelId?: string | null;
  initialDuration?: number | null;
  initialCount?: number | null;
  initialBalance?: number;
  plan?: PlanInfo | null;
  /** The LIVE plan's tier (`planAccess.tier`), or null when nothing entitles the
   *  viewer today. Deliberately NOT `plan.tier`: the manageable row above can be
   *  an elapsed subscription, and gating on it would show a whole catalogue as
   *  unlocked and then 403 every submit (W0/D4). */
  planTier?: string | null;
  /** Anonymous guest session. Guests may inspect and submit the selected
   *  creative model so /v1/jobs can return signup_required before the tier,
   *  credit, or provider gates. A real free-tier account remains gated. */
  isAnonymous?: boolean;
  /** Where the locked-model upsell points — /pricing, or /settings/billing for an
   *  elapsed subscriber whose only working recovery path lives there (W0/D6). */
  lockedCtaHref?: string;
  initialPaidMediaStorage?: boolean;
  /** Show the guided walkthrough (?onboarding=1 from auth redirect). */
  onboarding?: boolean;
  locale?: Locale;
  devTools?: boolean;
}) {
  const projectContext = useProjectContext();
  const workspaceProject = projectContext.mode === 'valid' ? projectContext.project : null;
  const projectContextReady =
    projectContext.mode === 'standalone' || projectContext.mode === 'valid';

  // Dev-only gateway switch (Evolink ⇄ AtlasCloud). Persisted across visits and
  // sent as `provider` on POST /v1/jobs so the worker routes the job. Hidden in
  // production; absent `provider` → server uses the PROVIDER_GATEWAY default.
  const [gateway, setGateway] = useState<Gateway>('openrouter');
  useEffect(() => {
    if (!devTools || typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('seed.gateway');
    if (saved === 'atlascloud' || saved === 'openrouter') setGateway(saved);
  }, [devTools]);
  // Guided onboarding walkthrough: the query selects the surface, but a
  // definitive profile response decides whether a fresh account may see it.
  // Completion and dismissal persist through the existing idempotent endpoint.
  const [tourStep, setTourStep] = useState(0);
  const [tourActive, setTourActive] = useState(false);
  const isMobileViewport = useMediaQuery('(max-width: 767px)');
  const tourStepCount = isMobileViewport ? 3 : 4;
  useEffect(() => {
    if (!onboarding || isAnonymous || typeof window === 'undefined') return;
    const controller = new AbortController();
    fetch(`${apiUrl}/v1/me/profile`, { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        const me: unknown = await response.json().catch(() => null);
        if (!me || typeof me !== 'object' || Array.isArray(me)) return null;
        if (!Object.prototype.hasOwnProperty.call(me, 'onboardedAt')) return null;
        return (me as { onboardedAt: unknown }).onboardedAt === null;
      })
      .then((isFresh) => {
        if (isFresh && !controller.signal.aborted) {
          setTourStep(0);
          setTourActive(true);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [onboarding, apiUrl, isAnonymous]);
  const advanceTour = useCallback(() => {
    setTourStep((s) => Math.min(s + 1, tourStepCount - 1));
    trackEvent(PlausibleEvent.onboardingStepCompleted, {
      step: ['model', 'prompt', 'submit', 'done'][Math.min(tourStep + 1, 3)] ?? 'manual',
    });
  }, [tourStep, tourStepCount]);
  const endTour = useCallback(() => {
    setTourActive(false);
    if (!isAnonymous) void postOnboarding(apiUrl, {});
  }, [apiUrl, isAnonymous]);
  function changeGateway(g: Gateway) {
    setGateway(g);
    if (typeof window !== 'undefined') window.localStorage.setItem('seed.gateway', g);
  }

  // Image + video models in the picker. Voice is still parked.
  // Explicit Image | Video mode — the FIRST choice the user makes. It drives the
  // model list (so mode is no longer an implicit side-effect of the model).
  const [mode, setMode] = useState<'image' | 'video'>(() =>
    allModels.find((m) => m.id === initialModelId)?.kind === 'video' ? 'video' : 'image',
  );
  const models = useMemo(
    () => allModels.filter((m) => (mode === 'video' ? m.kind === 'video' : m.kind === 'image')),
    [allModels, mode],
  );

  // The user's plan tier drives entitlement gating. Real guests are a distinct
  // pre-paywall state: they may reach submit so /v1/jobs can return
  // signup_required before tier/credit/provider work. A real free-tier account
  // stays locked to the catalogue's actual free rows.
  // Sourced from the LIVE plan (`planAccess`), which is the same row the server
  // gate in jobs-routes.ts resolves — so a signed-in picker and the 403 cannot
  // disagree.
  // The ranking itself lives in lib/model-tier so /boards gates identically.
  const userTier = planTier ?? 'free';
  const canUseModel = useMemo(
    () => (m: ModelRow) => isAnonymous || !isModelLocked(m, userTier),
    [isAnonymous, userTier],
  );

  // P-B1/P-B2/DEC-2: signed-in users never default to an out-of-plan model.
  // Prefer the intended affordable default; else the cheapest model the plan
  // can actually use; else (nothing usable — e.g. a signed-in free account in
  // video mode) the lowest-tier cheapest, shown locked with an upsell. A real
  // anonymous guest is allowed through this presentation gate only so the
  // server's pre-paywall signup wall remains reachable.
  const defaultModel = useMemo(() => {
    const preferredId = mode === 'video' ? 'seedance-2-0-fast' : 'seedream-5-0-pro';
    const preferred = models.find((m) => m.id === preferredId);
    if (preferred && canUseModel(preferred)) return preferred;
    // A reference-to-video card can't run without an attachment, so it must
    // never be auto-selected — the screen would open already blocked.
    const candidates = models.filter(
      (m) => m.kind !== 'video' || videoMediaCaps(m).role !== 'reference',
    );
    const usable = candidates
      .filter(canUseModel)
      .sort((a, b) => a.minUnitCredits - b.minUnitCredits);
    if (usable[0]) return usable[0];
    return (
      [...candidates].sort(
        (a, b) =>
          // Models with an unrecognised tier remain locked and sort after known rows.
          (subscriptionTierRank(a.tierMin) ?? Number.MAX_SAFE_INTEGER) -
            (subscriptionTierRank(b.tierMin) ?? Number.MAX_SAFE_INTEGER) ||
          a.minUnitCredits - b.minUnitCredits,
      )[0] ??
      preferred ??
      models[0] ??
      null
    );
  }, [models, mode, canUseModel]);
  const [modelId, setModelId] = useState<string>(() => {
    if (initialModelId) {
      const m = models.find((x) => x.id === initialModelId);
      if (m && canUseModel(m)) return m.id;
    }
    return defaultModel?.id ?? '';
  });
  const model = useMemo(() => models.find((m) => m.id === modelId) ?? null, [models, modelId]);
  const isVideo = mode === 'video';

  // Cheapest usable fast video model — the target of «Черновик». Only video has
  // distinct fast variants, so the draft chip is video-only.
  const draftVideoModel = useMemo(
    () =>
      models
        .filter((m) => canUseModel(m) && isDraftVideoCandidate(m))
        .sort((a, b) => a.minUnitCredits - b.minUnitCredits)[0] ?? null,
    [models, canUseModel],
  );

  // When mode flips, jump to that mode's default model.
  useEffect(() => {
    if (!models.some((m) => m.id === modelId)) selectModel(defaultModel?.id ?? '');
  }, [mode, models, modelId, defaultModel]);
  // Draft is video-only; leaving video clears it.
  useEffect(() => {
    setDraft(false);
  }, [mode]);
  const sizes = useMemo(() => sizesFor(model?.maxResolution ?? null), [model]);
  const [size, setSize] = useState<string>(sizes[0]?.id ?? '1:1');
  // null means the user has not chosen a tier yet, so retain the historical
  // default from resolveImageQuality for the selected model.
  const [selectedImageQuality, setSelectedImageQuality] = useState<{
    modelId: string;
    quality: string;
  } | null>(null);
  // Image batch — Evolink supports n=1..15 natively. Offer a sane few.
  const [count, setCount] = useState<number>(initialCount ?? 1);
  // Video params
  const [duration, setDuration] = useState<number>(initialDuration ?? 5);
  const [durationAuto, setDurationAuto] = useState<boolean>(false);
  // null means the user has not chosen a rung; effectiveResolution derives finance's
  // signed default until an explicit pick is made. A pick belongs to its model.
  const [resolution, setResolution] = useState<{
    modelId: string;
    resolution: string;
  } | null>(NO_VIDEO_RESOLUTION_PICK);
  const [vAspect, setVAspect] = useState<VAspect>('16:9');
  const [genAudio, setGenAudio] = useState<boolean>(true);
  const [watermark, setWatermark] = useState<boolean>(false);
  const [returnLastFrame, setReturnLastFrame] = useState<boolean>(false);
  // Draft mode (video): one tap routes to the cheapest fast model + 480p so
  // exploring a shot is a fraction of the full-quality credit cost.
  const [draft, setDraft] = useState<boolean>(false);
  function selectModel(nextModelId: string) {
    const next = modelSelectionState(nextModelId);
    setDraft(next.draft);
    setModelId(next.modelId);
  }
  // True while a result is being handed off to Studio (disables the button).
  const [handingOff, setHandingOff] = useState<boolean>(false);
  // References carry identity and provenance, so an accepted one-shot can
  // consume its own entry without deleting an equal URL the user attached.
  const [referenceMedia, setReferenceMedia] = useState<ReferenceAttachment[]>([]);
  const imageReferences = referenceMedia.filter((reference) => reference.kind === 'image');
  const videoReferences = referenceMedia.filter((reference) => reference.kind === 'video');
  const audioReferences = referenceMedia.filter((reference) => reference.kind === 'audio');
  const imageUrls = imageReferences.map((reference) => reference.url);
  const videoUrls = videoReferences.map((reference) => reference.url);
  const audioUrls = audioReferences.map((reference) => reference.url);
  function replaceReferenceKind(kind: ReferenceKind, urls: string[]) {
    setReferenceMedia((current) => {
      const replacement = urls.map((url) => ({ id: randomKey(), kind, url }));
      return [...current.filter((reference) => reference.kind !== kind), ...replacement];
    });
  }
  function replaceReferenceEntries(
    kind: ReferenceKind,
    entries: Array<ReferenceMediaItem | MediaPickerItem>,
  ) {
    setReferenceMedia((current) => {
      const byId = new Map(current.map((reference) => [reference.id, reference]));
      const replacement = entries.map((entry) => byId.get(entry.id) ?? { ...entry, kind });
      return [...current.filter((reference) => reference.kind !== kind), ...replacement];
    });
  }
  // Returns the new entry's id so a one-shot caller can consume exactly that
  // entry later — provenance lives with the caller, not on the record.
  function attachReference(kind: ReferenceKind, url: string) {
    const reference = { id: randomKey(), kind, url };
    setReferenceMedia((current) => [reference, ...current]);
    return reference.id;
  }
  const [webSearch, setWebSearch] = useState<boolean>(false);
  const [editOn, setEditOn] = useState<boolean>(false);
  const [repeatValidation, setRepeatValidation] = useState(false);
  // Seed: null → provider randomises. Set → reproducible; «Вариации» bumps it.
  const [seedValue, setSeedValue] = useState<number | null>(null);
  const [prompt, setPrompt] = useState<string>(initialPrompt ?? '');
  // Context anchor: typing a prompt advances from the prompt step. Manual Next
  // remains available so the tour never traps a user who wants to move faster.
  const [tourPromptAnchored, setTourPromptAnchored] = useState(false);
  useEffect(() => {
    if (!tourActive || tourStep !== 1 || prompt.trim().length === 0 || tourPromptAnchored) return;
    setTourPromptAnchored(true);
    setTourStep(2);
    trackEvent(PlausibleEvent.onboardingStepCompleted, { step: 'prompt' });
  }, [tourActive, tourStep, prompt, tourPromptAnchored]);
  const [presetApplied, setPresetApplied] = useState(false);
  // A non-replace preset (prefix/suffix/slots) whose recipe is composited around
  // the user's own prompt at submit time. `null` for legacy replace-mode packs
  // (those write the template straight into the textarea, as before).
  const [appliedPreset, setAppliedPreset] = useState<PresetRow | null>(null);
  const [appliedPresetSlug, setAppliedPresetSlug] = useState<string | null>(null);
  // Per-slot fills for a multi-slot slots-mode preset (the apply sheet). A
  // single-slot preset needs none — the textarea drops into that slot.
  const [slotValues, setSlotValues] = useState<Record<string, string>>({});
  // P-M1 / D-m4 / F-m6: one-tap example gallery for the idle stage.
  const [presets, setPresets] = useState<PresetRow[]>([]);
  // Stage drag-drop (video mode): drop a photo onto the canvas → first frame.
  const [stageDrag, setStageDrag] = useState(false);
  // Elapsed seconds for the in-flight job — drives the ETA progress bar.
  const [elapsedSec, setElapsedSec] = useState(0);
  const jobStartedRef = useRef<number | null>(null);
  const [inflight, setInflight] = useState<InflightGeneration[]>([]);
  // Video motion/effect chips only. Image cinema presets are also category
  // 'camera' but modality 'image' — exclude them so their {subject}-slot
  // template is never folded into a video prompt as a raw effect phrase.
  const motionPresets = useMemo(
    () =>
      presets.filter(
        (p) => (p.category === 'camera' || p.category === 'effect') && p.modality !== 'image',
      ),
    [presets],
  );
  // Exactly ONE effect at a time. The visible prompt stays clean — the effect's
  // phrase is appended to the submitted prompt behind the scenes (submitJob).
  const [selectedEffect, setSelectedEffect] = useState<PresetRow | null>(null);
  // Slugs the picker highlights — 0 or 1.
  const appliedMotionSet = useMemo(
    () => new Set<string>(selectedEffect ? [selectedEffect.slug] : []),
    [selectedEffect],
  );
  // When the user applies an enhancement, we track the EN string here.
  // It replaces the textarea value AND is what gets sent to /v1/jobs.
  const [appliedEnhancement, setAppliedEnhancement] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // D3 feedback — a two-beat success buzz + confirmation chime when a render
  // lands; a soft warn + error tone on failure. Haptics are touch-only; sound is
  // global-mute + reduced-motion gated (lib/sound). Fires once per transition.
  useEffect(() => {
    if (phase.kind === 'done') {
      haptics.success();
      sound.complete();
    } else if (phase.kind === 'failed' && !phase.stillRunning) {
      haptics.warn();
      sound.error();
    }
  }, [phase.kind]);
  // Batch results: null → grid view (when >1 asset), index → single view.
  const [selectedAsset, setSelectedAsset] = useState<number | null>(0);
  // F-m8: keep a small filmstrip of this session's results so iterating with
  // «Создать ещё» doesn't lose prior outputs.
  const [sessionResults, setSessionResults] = useState<
    {
      url: string;
      isVideo: boolean;
      label: string;
      jobId: string;
      modelId?: string;
      model?: ResultModel;
      params?: Record<string, unknown>;
      creditsReserved?: number;
    }[]
  >([]);
  // Pressing either sidebar card (Модель / Эффект) opens a Higgsfield-style
  // picker IN the preview panel — `pickerView` drives which grid it shows.
  // Closed on mode flip.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerView, setPickerView] = useState<'model' | 'effect'>('model');
  useEffect(() => {
    setPickerOpen(false);
  }, [mode]);
  // Idempotency key for the NEXT submission — regenerated after each accepted
  // job so several generations can run concurrently; double-clicks during one
  // in-flight POST still dedupe on the same key.
  const idemRef = useRef<string>(randomKey());
  // React does not commit the `submitting` phase synchronously. A second click,
  // form submit, or ⌘/Ctrl+Enter in that window would otherwise enter
  // `submitJob` again. Keep this guard synchronous and scoped only to the
  // logical submit (including its intentional multi-take fan-out); release it
  // as soon as every POST settles so later generations remain independent.
  const submitGuardRef = useRef(false);
  // Concurrent generation: every submitted job polls independently; only the
  // job currently on stage drives `phase`. Others finish into the session
  // filmstrip + header jobs tray.
  const displayedJobRef = useRef<string | null>(null);
  // Every job THIS screen launched (membership test for the job-event bus, so a
  // background result still lands). The displayed one additionally drives `phase`.
  const trackedJobsRef = useRef<Set<string>>(new Set());
  const receiptCacheRef = useRef<
    Map<
      string,
      {
        resultAssets?: string[];
        modelId?: string;
        model?: ResultModel | null;
        params?: Record<string, unknown>;
        creditsReserved?: number;
      }
    >
  >(new Map());
  const receiptRequestRef = useRef(0);
  const oneShotReferenceRef = useRef<string | null>(null);
  const repeatValidationRef = useRef(false);
  // The price a «Повторить» was last refused at, per source job. It is the number the
  // server named in its `quote_stale` and the user has been shown, so the next press
  // binds to it instead of re-offering the old charge the catalogue has moved past.
  const repeatQuoteRef = useRef<{ jobId: string; cost: number } | null>(null);
  // Deadline of the on-stage job, mirrored from submitJob so the elapsed-clock
  // tick can enforce it even if the poll loop / event bus were both dropped.
  const jobDeadlineRef = useRef<number | null>(null);
  // Latest model label, read by the bus-driven resolver (which captures an early
  // closure) so the session-filmstrip label never goes stale.
  const modelLabelRef = useRef('');
  const unmountedRef = useRef(false);
  // Live credit balance + plan allowance — kept in sync with the header widget.
  const [balance, setBalance] = useState<number>(initialBalance);
  const [plan, setPlan] = useState<PlanInfo | null>(initialPlan);
  const [paidMediaStorage, setPaidMediaStorage] = useState(initialPaidMediaStorage);
  // Result canvas — target for the fullscreen action.
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // Keep balance + plan-allowance fresh: on focus + on the shared invalidate
  // event (fired after every ledger mutation, same channel the header widget
  // listens on). Refreshing the subscription recomputes remaining-this-cycle.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const [balRes, subRes, storageRes] = await Promise.all([
          fetch(`${apiUrl}/v1/credits/balance`, { credentials: 'include' }),
          fetch(`${apiUrl}/v1/billing/subscription`, { credentials: 'include' }),
          fetch(`${apiUrl}/v1/billing/media-storage`, { credentials: 'include' }),
        ]);
        if (balRes.ok) {
          const body = (await balRes.json()) as { available?: number };
          if (!cancelled && typeof body.available === 'number') setBalance(body.available);
        }
        if (subRes.ok) {
          const body = (await subRes.json().catch(() => null)) as PlanInfo | null;
          if (!cancelled) setPlan(body && typeof body.creditsPerCycle === 'number' ? body : null);
        }
        if (storageRes.ok) {
          const body = (await storageRes.json().catch(() => null)) as { paid?: unknown } | null;
          if (!cancelled && typeof body?.paid === 'boolean') setPaidMediaStorage(body.paid);
        }
      } catch {
        /* keep stale values */
      }
    }
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener('focus', onChange);
    window.addEventListener(BALANCE_INVALIDATE_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onChange);
      window.removeEventListener(BALANCE_INVALIDATE_EVENT, onChange);
    };
  }, [apiUrl]);

  function enterFullscreen() {
    const el = canvasRef.current;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => {});
  }

  async function shareAsset(url: string) {
    const abs = url.startsWith('http') ? url : `${window.location.origin}${url}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Vertov', url: abs });
        return;
      }
    } catch {
      /* fall through to clipboard */
    }
    try {
      await navigator.clipboard.writeText(abs);
    } catch {
      /* no-op */
    }
  }

  // P-M1: load the example gallery once (RU locale).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiUrl}/v1/preset-packs?lang=ru`, { credentials: 'include' });
        if (!res.ok) return;
        const body = (await res.json()) as { items?: PresetRow[] };
        // Full catalog: scenes feed the idle gallery, camera/effect rows
        // become the inline motion chips in video mode.
        if (!cancelled && Array.isArray(body.items)) setPresets(body.items);
      } catch {
        /* gallery is optional — silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  // Layout-A preview: the idle stage shows the user's OWN past generations
  // («Твои генерации»). Pulled from the gallery feed; empty → the 01·02·03
  // steps. Refreshed when a new render lands so the freshest tile shows.
  const [history, setHistory] = useState<GenerationTile[]>([]);
  const [historyFilter, setHistoryFilter] = useState<GenFilter>('all');
  // Mobile (< lg) single-column pane switch: «Управление» (dock) ⇄ «Результат».
  const [pane, setPane] = useState<'controls' | 'preview'>('controls');
  const loadHistory = useCallback(async () => {
    if (!projectContextReady) return;
    try {
      const url = new URL(`${apiUrl}/v1/gallery`);
      url.searchParams.set('limit', '24');
      if (workspaceProject) url.searchParams.set('projectId', workspaceProject.id);
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return;
      const body = (await res.json()) as {
        rows?: {
          id: string;
          assetUrl: string;
          thumbnailUrl: string | null;
          kind: 'image' | 'video';
          jobId: string | null;
        }[];
      };
      if (!Array.isArray(body.rows)) return;
      setHistory(
        body.rows.map((r, i) => ({
          id: r.id,
          src: assetSrc(r.thumbnailUrl || r.assetUrl),
          assetUrl: r.assetUrl,
          jobId: r.jobId,
          kind: r.kind,
          prompt: null,
          isNew: i === 0,
        })),
      );
    } catch {
      /* history is optional — silent */
    }
  }, [apiUrl, projectContextReady, workspaceProject]);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);
  // Refresh the «Твои генерации» grid whenever a render lands.
  useEffect(() => {
    if (phase.kind === 'done') void loadHistory();
  }, [phase.kind, loadHistory]);

  // P-M1: one-tap apply — prefill prompt + settings + model from a preset.
  function applyPreset(p: PresetRow) {
    trackEvent(PlausibleEvent.presetApplied, { pack: p.slug });
    setAppliedPresetSlug(p.slug);
    const target = allModels.find((m) => m.id === p.modelId);
    if (target) {
      setMode(target.kind === 'video' ? 'video' : 'image');
      if (subscriptionTierAllows(userTier, target.tierMin)) selectModel(target.id);
    }
    setAppliedEnhancement(null);
    const mergeMode: PresetMergeMode = p.mergeMode ?? 'replace';
    if (mergeMode === 'replace') {
      // Legacy scene packs: the preset IS the prompt (byte-identical to before).
      setPrompt(p.promptTemplate);
      setAppliedPreset(null);
      setSlotValues({});
      setPresetApplied(true);
    } else {
      // prefix/suffix/slots: keep the user's own prompt as their subject; the
      // recipe is composited around it at submit time via mergePresetPrompt.
      setAppliedPreset(p);
      const seeded: Record<string, string> = {};
      for (const s of p.slots ?? []) if (s.default?.trim()) seeded[s.key] = s.default;
      setSlotValues(seeded);
      setPresetApplied(false);
    }
    const pp = p.paramsJson ?? {};
    if (typeof pp['size'] === 'string') setSize(pp['size'] as string);
    if (typeof pp['n'] === 'number') setCount(Math.max(1, Math.min(4, pp['n'] as number)));
    if (typeof pp['duration_seconds'] === 'number' && (pp['duration_seconds'] as number) > 0) {
      setDuration(pp['duration_seconds'] as number);
    }
    if (typeof pp['resolution'] === 'string') {
      const routed = presetResolutionState(
        target,
        target && subscriptionTierAllows(userTier, target.tierMin) ? target.id : null,
        modelId,
        pp['resolution'],
        target?.kind === 'video' || (!target && mode === 'video') ? 'video' : 'image',
      );
      if (routed.imageQuality) setSelectedImageQuality(routed.imageQuality);
      if (routed.videoResolution) setResolution(routed.videoResolution);
    }
    if (typeof pp['aspect_ratio'] === 'string') setVAspect(pp['aspect_ratio'] as VAspect);
    if (p.seriesCount != null && p.seriesCount > 1) {
      setCount(Math.max(1, Math.min(4, p.seriesCount)));
    }
    if (p.referenceAssetUrls && p.referenceAssetUrls.length > 0) {
      replaceReferenceKind('image', p.referenceAssetUrls);
    }
  }

  /** Remove a composited (non-replace) preset recipe, restoring plain prompting. */
  function clearAppliedPreset() {
    setAppliedPreset(null);
    setAppliedPresetSlug(null);
    setSlotValues({});
    presetAppliedRef.current = false;
  }

  // The applied preset's merge spec + the user's effective subject text, shared
  // by submit, the required-slot gate, and the apply sheet so they never drift.
  const presetSpec = useMemo(
    () =>
      appliedPreset
        ? {
            promptTemplate: appliedPreset.promptTemplate,
            mergeMode: (appliedPreset.mergeMode ?? 'replace') as PresetMergeMode,
            slots: appliedPreset.slots ?? [],
          }
        : null,
    [appliedPreset],
  );
  // Slots that still need a value before submit (single-slot presets are
  // satisfied by the textarea; multi-slot presets by the apply sheet).
  const pendingSlots = useMemo(
    () => (presetSpec ? unfilledRequiredSlots(presetSpec, prompt, slotValues) : []),
    [presetSpec, prompt, slotValues],
  );

  /** Select/deselect THE single effect. The visible prompt is untouched — the
   * effect's phrase is folded into the submitted prompt in submitJob. */
  function toggleMotion(p: PresetRow) {
    setSelectedEffect((cur) => (cur?.slug === p.slug ? null : p));
  }

  /** Stage drop (video mode): uploaded photo becomes the first frame. */
  async function onStageDrop(e: React.DragEvent) {
    e.preventDefault();
    setStageDrag(false);
    if (!isVideo) return;
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    const url = await uploadMediaFile(apiUrl, file);
    if (url) replaceReferenceKind('image', [url, ...imageUrls.slice(0, 1)]);
  }

  // Catalog prefill (/generate?preset=<slug> from the /presets page) —
  // applied once on mount. Runs the same path as the idle-gallery tiles.
  const presetAppliedRef = useRef(false);
  useEffect(() => {
    if (!initialPreset || presetAppliedRef.current) return;
    presetAppliedRef.current = true;
    applyPreset(initialPreset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPreset]);

  // Prefill from remix link (/generate?from=<jobId>) — fetch source job once.
  // A visitor who does not own the job gets 404 from /v1/jobs/:id; with the
  // public showcase handle (?via=<slug>, J-2 follow-up) the SAME recipe then
  // comes from /v1/g/<slug>/prefill — logged-out and logged-in strangers alike
  // land on a prefilled draft, which is the whole point of the share loop.
  useEffect(() => {
    if (!fromJobId) return;
    let cancelled = false;
    const applyRecipe = (body: {
      modelId?: string | null;
      params?: Record<string, unknown> | null;
      referenceAssets?: string[] | null;
    }) => {
      if (cancelled) return;
      // Restore the FULL recipe — mode, model, and every generation param —
      // so «Повторить» reproduces the job, not just its prompt.
      const source = allModels.find((m) => m.id === body.modelId);
      if (source) {
        setMode(source.kind === 'video' ? 'video' : 'image');
        if (subscriptionTierAllows(userTier, source.tierMin)) selectModel(source.id);
      }
      const p = body.params as Record<string, unknown> | undefined;
      // A preset owns prompt composition, so the remix restores only its source controls and refs.
      // CAS against the latest prompt state, not just the ref: the user can clear a preset
      // (resetting the ref) and start typing while this fetch is in flight — a stale
      // response must not clobber what they typed. Functional set skips the write when
      // the current text already diverged from the source value this fetch saw.
      const sourcePrompt = typeof p?.['prompt'] === 'string' ? (p['prompt'] as string) : null;
      if (sourcePrompt !== null && !presetAppliedRef.current) {
        setPrompt((current) =>
          current === sourcePrompt ? current : current === '' ? sourcePrompt : current,
        );
      }
      if (p && typeof p['size'] === 'string') setSize(p['size'] as string);
      if (p && typeof p['n'] === 'number') setCount(Math.max(1, Math.min(4, p['n'] as number)));
      if (p && typeof p['seed'] === 'number') setSeedValue(p['seed'] as number);
      if (p && typeof p['duration_seconds'] === 'number') {
        const d = p['duration_seconds'] as number;
        if (d === -1) setDurationAuto(true);
        else if (d > 0) setDuration(d);
      }
      if (p && typeof p['resolution'] === 'string') {
        setResolution({
          modelId: source && subscriptionTierAllows(userTier, source.tierMin) ? source.id : modelId,
          resolution: p['resolution'],
        });
      }
      if (p && typeof p['aspect_ratio'] === 'string') setVAspect(p['aspect_ratio'] as VAspect);
      // Owner remix: refs ride `params.imageUrls` (as before). Public prefill
      // carries the SAME already-public assets under `referenceAssets` instead —
      // the /g page shows them, so serving them here leaks nothing new.
      if (Array.isArray(p?.['imageUrls']) && (p['imageUrls'] as unknown[]).length > 0) {
        replaceReferenceKind(
          'image',
          (p['imageUrls'] as unknown[]).filter((u): u is string => typeof u === 'string'),
        );
      } else if (Array.isArray(body.referenceAssets)) {
        replaceReferenceKind(
          'image',
          body.referenceAssets.filter(
            (u) => typeof u === 'string' && !/\.(mp4|mov|webm)(\?|$)/i.test(u),
          ),
        );
      }
      if (p && Array.isArray(p['videoUrls'])) {
        replaceReferenceKind(
          'video',
          (p['videoUrls'] as unknown[]).filter((u): u is string => typeof u === 'string'),
        );
      }
      if (p && Array.isArray(p['audioUrls'])) {
        replaceReferenceKind(
          'audio',
          (p['audioUrls'] as unknown[]).filter((u): u is string => typeof u === 'string'),
        );
      }
    };

    (async () => {
      try {
        const res = await fetch(`${apiUrl}/v1/jobs/${fromJobId}`, { credentials: 'include' });
        if (cancelled) return;
        if (res.ok) {
          applyRecipe(await res.json());
          return;
        }
        // Not the owner (or job gone): fall back to the public recipe.
        if (viaSlug) {
          const pub = await fetch(`${apiUrl}/v1/g/${encodeURIComponent(viaSlug)}/prefill`, {
            credentials: 'include',
          });
          if (cancelled) return;
          if (pub.ok) applyRecipe(await pub.json());
        }
      } catch {
        /* best effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromJobId, viaSlug, apiUrl, models]);

  // Keep size valid when the model changes.
  useEffect(() => {
    if (sizes.length && !sizes.some((s) => s.id === size)) setSize(sizes[0]!.id);
  }, [sizes, size]);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Capability-driven option space (S4): a model that declares discrete
  // durations / resolutions / aspect ratios drives the controls from its own
  // schema; models that don't (legacy Seedance) keep the static behavior below.
  const vDurations = isVideo && model ? videoDurations(model) : null;
  const vAspects = isVideo && model ? videoAspectRatios(model) : null;

  const maxDur = vDurations ? Math.max(...vDurations) : (model?.maxDurationSeconds ?? 10);
  const minDur = vDurations ? Math.min(...vDurations) : 4;
  // Snap to a supported duration when discrete (Veo 4/6/8) so the charged
  // second-count matches the delivered clip; else clamp to [4, cap].
  const clampedDuration = vDurations
    ? snapDuration(duration, vDurations)
    : Math.max(4, Math.min(duration, maxDur));
  const resolutionOptions = generateVideoResolutionOptions(model, isVideo);
  const effectiveResolution = resolveVideoResolution(
    resolution?.modelId === modelId ? resolution.resolution : NO_VIDEO_RESOLUTION_PICK,
    resolutionOptions,
    model?.capabilities,
  );
  // Aspect ratios: the model's declared vendor enum, or the full legacy set.
  // Never offer `adaptive`: kie and other video vendors reject that literal.
  const aspectOptions: VAspect[] = vAspects
    ? vAspects.filter((a): a is VAspect => a in VASPECT_ICON && a !== 'adaptive')
    : VIDEO_ASPECTS;
  const effectiveAspect: VAspect = aspectOptions.includes(vAspect)
    ? vAspect
    : (aspectOptions[0] ?? '16:9');
  // Bumped when a submit is refused with `quote_stale`, to pull a fresh quote for
  // inputs that did not change — the price moved, not the request.
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  // Capability-driven mode flags. Hoisted above the estimate params: the image
  // quality selector needs it too.
  const caps = (model?.capabilities ?? {}) as Record<string, unknown>;
  // Keep the exact capability filtering used by Boards. An explicit [] means
  // this model exposes no image-quality selector at all.
  const imageQualityOptions = !isVideo && model ? boardImageQualitiesFor(model) : [];
  // Estimate and submit MUST agree (goal invariant 4) — computed once, used at
  // both call sites below.
  const defaultImageQuality = resolveImageQuality(caps);
  const imageQuality = imageQualityForModel(
    modelId,
    selectedImageQuality,
    imageQualityOptions,
    defaultImageQuality,
  );
  // Video: count = N independent «дубли» (multi-take), so each POST reserves
  // this one-job quote. Image: count = server-side batch (n), already in the quote.
  // The estimate carries the same media fields as the submit body. This is
  // deliberately broader than today's price selector: reference count is
  // becoming price-relevant, so stripping it here would make the quote stale
  // before POST /v1/jobs can bind expectedCost.
  //
  // `videoPriceParams` derives `videoUrls` through the SAME `videoMediaParams`
  // gate the submit body uses below, so a stale video attachment surviving a
  // model switch can no longer quote FLAT while the charge goes PARAMETRIC
  // (paths audit B3, goal invariant 4).
  const estimateParams: Record<string, unknown> = isVideo
    ? model
      ? videoPriceParams(model, {
          durationSeconds: clampedDuration,
          resolution: effectiveResolution,
          generateAudio: genAudio,
          refs: { images: imageUrls, videos: videoUrls, audios: audioUrls },
        })
      : { duration_seconds: clampedDuration, resolution: effectiveResolution }
    : imageGenerationParams(
        size,
        imageQuality,
        count,
        !isVideo &&
          (caps['reference'] === true ||
            caps['multi_image'] === true ||
            (caps['edit'] === true && editOn))
          ? imageUrls
          : undefined,
      );
  const estimate = useJobEstimate({
    apiUrl,
    modelId: model?.id,
    // The price is keyed by model + parameters; the prompt never moves it. Quoting
    // with a placeholder (the request schema wants a non-empty string) puts the real
    // number on the button as soon as a model is picked, instead of a dash that only
    // resolves once something is typed — and it stops every keystroke from re-quoting.
    // Submitting still needs a real prompt: `canSubmit` checks that separately.
    prompt: QUOTE_PLACEHOLDER_PROMPT,
    params: estimateParams,
    source: 'generate',
    enabled: Boolean(model),
    requiresPrompt: false,
    refreshToken: quoteRefresh,
  });
  // The server estimate is the only displayed price. A loading or transport
  // failure shows no number rather than a mutable catalog-rate placeholder.
  const priceRefusal = estimate.refusal;
  const quotedCost = estimatePriceToShow(estimate);
  const cost = totalGenerateCost(quotedCost, count, isVideo);
  // The outgoing number, kept only to grey out while the new one is counted.
  const recalculatingCost = totalGenerateCost(recalculatingPriceToShow(estimate), count, isVideo);
  const isBusy = phase.kind === 'submitting' || phase.kind === 'polling';
  // Only an in-flight POST blocks the button — a job that's already polling
  // doesn't: fire several generations and watch them in the tray/filmstrip.
  const isSubmitting = phase.kind === 'submitting';
  // Is the currently selected model out of the user's plan? (P-B2)
  const modelLocked = model ? !canUseModel(model) : false;

  const videoMode = isVideo ? (caps['mode'] as string | undefined) : undefined; // text|image|reference
  const editCapable = !isVideo && caps['edit'] === true;
  // Image models that take reference images (multi-reference / image-to-image,
  // e.g. Seedream 4) get the same asset-input UI as video — attach references to
  // steer style/subject/composition. Optional: a text-only prompt still works.
  const imageRefCapable = !isVideo && (caps['reference'] === true || caps['multi_image'] === true);
  // Keep the picker aligned with the selected model's server-side capability.
  // The fallback preserves the legacy affordance for older catalog rows while
  // the API remains the final authority on the request.
  const imageReferenceLimit = Math.max(0, Math.floor(Number(caps['maxRefs'] ?? 10)));
  const webSearchCapable = caps['websearch'] === true || videoMode === 'text';
  const needsImageInput = videoMode === 'image';
  // What media the picked VIDEO card takes — frames (keyframe anchors), typed
  // references, or nothing at all. Same derivation the board ports use, so a
  // model can't grow different inputs on /generate and /boards.
  const videoMedia = isVideo && model ? videoMediaCaps(model) : null;
  const isReferenceMode = videoMedia?.role === 'reference';
  const referenceMediaLimits = isReferenceMode && model ? videoMediaLimits(model) : null;
  const hasUnsupportedReferenceMedia =
    imageUrls.length > 0 || videoUrls.length > 0 || audioUrls.length > 0;
  // Audio is a per-model capability (only Seedance 2.0 + its reference variant
  // can score a clip) — don't offer or send it on models that can't.
  const audioCapable = isVideo && model ? supportsAudioControl(model) : false;
  // Edit mode is entered only from a result («Редактировать»); the standalone
  // upload-your-own-photo toggle was removed.
  const isEditing = editCapable && editOn;
  const frameVideoModel = useMemo(
    () =>
      allModels.find(
        (candidate) =>
          candidate.kind === 'video' &&
          canUseModel(candidate) &&
          videoMediaCaps(candidate).role === 'frame',
      ) ?? null,
    [allModels, canUseModel],
  );
  const referenceVideoModel = useMemo(
    () =>
      allModels.find(
        (candidate) =>
          candidate.kind === 'video' &&
          canUseModel(candidate) &&
          videoMediaCaps(candidate).role === 'reference' &&
          videoMediaCaps(candidate).video > 0,
      ) ?? null,
    [allModels, canUseModel],
  );
  const imageEditModel = useMemo(
    () =>
      allModels.find(
        (candidate) =>
          candidate.kind !== 'video' &&
          canUseModel(candidate) &&
          ((candidate.capabilities ?? {}) as Record<string, unknown>)['edit'] === true,
      ) ?? null,
    [allModels, canUseModel],
  );

  // Picker cards — ONE per catalog row, twins included. The card IS the mode
  // choice: «Seedance 2.0 · кадры» and «Seedance 2.0 · референсы» are separate
  // tools with different inputs, exactly as /boards lists them as separate rows.
  // There is deliberately no presence-based auto-swap any more: the user's model
  // pick is authoritative, which is what makes the first/last-frame path
  // reachable on the base Seedance rows again.
  const videoCards = useMemo(() => modelCards(allModels, 'video'), [allModels]);
  const imageCards = useMemo(() => modelCards(allModels, 'image'), [allModels]);
  const currentCard = useMemo(
    () => (isVideo ? videoCards : imageCards).find((c) => c.model.id === modelId) ?? null,
    [isVideo, videoCards, imageCards, modelId],
  );
  // One label per model everywhere it's named (picker, sidebar, quick-switch
  // chips, result captions) — a card that reads «… · кадры» in the grid must not
  // read «2.0-fast» in the chip row.
  const cardName = useMemo(() => {
    return (m: ModelRow) => modelCardName(m, allModels);
  }, [allModels]);
  const receiptModelLabel = (modelId?: string, receiptModel?: ResultModel | null): string => {
    const catalogueModel = modelId
      ? allModels.find((candidate) => candidate.id === modelId)
      : undefined;
    if (catalogueModel) return cardName(catalogueModel);
    if (receiptModel && modelId) {
      return modelCardName(
        { id: modelId, ...receiptModel, capabilities: receiptModel.capabilities ?? {} },
        allModels,
      );
    }
    if (receiptModel) return modelDisplayName(receiptModel);
    return modelId ? modelDisplayNameFromId(modelId) : 'Модель недоступна';
  };
  // Capability signs shown on the sidebar «Модель» card itself.
  const sidebarModelSigns = model ? capabilitySigns(model) : [];

  // F-M5: do NOT wipe uploaded media on a model switch — that was silent data
  // loss (e.g. after uploading 9 refs). Media is only ever *sent* when the new
  // model's mode calls for it (see onSubmit guards), so carrying it is harmless
  // and lets the user switch back without re-uploading. Only reset the
  // model-specific flags that don't make sense to carry.
  // Skip the mount run: it would wipe the kinobar's ?n= prefill (initialCount)
  // before the user ever touched the model picker.
  const prevModelIdRef = useRef(modelId);
  useEffect(() => {
    if (prevModelIdRef.current === modelId) return;
    prevModelIdRef.current = modelId;
    setEditOn(false);
    setWebSearch(false);
    setCount(1);
  }, [modelId]);

  // Validation: certain cards require source media. A reference card is a
  // deliberate pick now (not an implicit consequence of attaching something),
  // so "reference mode ⇒ there must be an attachment" still reads correctly —
  // it's exactly the state where the user picked the reference tool and hasn't
  // fed it yet.
  const missingMedia =
    (needsImageInput && imageUrls.length === 0) ||
    (isReferenceMode &&
      !hasAcceptedReferenceMedia(referenceMediaLimits!, {
        images: imageUrls,
        videos: videoUrls,
        audios: audioUrls,
      })) ||
    (isEditing && imageUrls.length === 0);
  // A chosen effect (video) provides the prompt, so it alone can satisfy submit.
  const canSubmit =
    !!model &&
    (prompt.trim().length > 0 || (isVideo && !!selectedEffect)) &&
    projectContextReady &&
    !isSubmitting &&
    !missingMedia &&
    // A debounce, in-flight estimate, timeout, or 5xx has no authoritative
    // price. Never make the action clickable until this exact request is quoted.
    hasKnownJobEstimate(estimate) &&
    // The server already refused to price this exact request; submitting it
    // would 400 with the same code. Block it here and say why.
    !priceRefusal &&
    pendingSlots.length === 0;

  function reset() {
    // Detach the stage from the current job; any in-flight polls keep running
    // and land in the filmstrip/tray when they finish.
    displayedJobRef.current = null;
    idemRef.current = randomKey();
    setSelectedAsset(0);
    setPhase({ kind: 'idle' });
  }

  // Full reset — clears the prompt + all settings back to defaults.
  function resetAll() {
    reset();
    setSessionResults([]);
    setPrompt('');
    setAppliedEnhancement(null);
    setPresetApplied(false);
    if (!appliedPreset) {
      setAppliedPresetSlug(null);
      presetAppliedRef.current = false;
    }
    setCount(1);
    setDuration(5);
    setDurationAuto(false);
    setResolution(null);
    setSelectedImageQuality(null);
    setVAspect('16:9');
    setGenAudio(true);
    setWatermark(false);
    setReturnLastFrame(false);
    setWebSearch(false);
    setEditOn(false);
    setSeedValue(null);
    setReferenceMedia([]);
    setDraft(false);
    if (sizes[0]) setSize(sizes[0].id);
  }

  // «Черновик»: route to the cheapest fast model + 480p for cheap exploration;
  // toggling off restores the mode's full-quality default. A manual model pick
  // (model picker) clears draft so the chip never lies about the active model.
  function toggleDraft() {
    if (!isVideo || !draftVideoModel) return;
    const next = !draft;
    setDraft(next);
    if (next) {
      // The one model change that must NOT clear draft — it is the change draft mode is
      // made of. Deliberately not `selectModel`, which exists to clear it everywhere else.
      setModelId(draftVideoModel.id);
      setResolution({ modelId: draftVideoModel.id, resolution: '480p' });
    } else {
      if (defaultModel) selectModel(defaultModel.id);
      setResolution(null);
    }
  }

  /** Apply a finished job's row to the UI: append its assets to the session
   *  filmstrip (always, so a background result still lands) and, when it's the
   *  job on stage, flip `phase` to done/failed. Returns true if terminal.
   *  Shared by the poll loop AND the job-event bus so completion is picked up on
   *  whichever channel survives. Reads only refs + stable setters, so a stale
   *  closure (the bus effect captures it once) stays correct. */
  function applyJobResult(
    jobId: string,
    body: {
      status?: string;
      resultAssets?: string[];
      errorCode?: string | null;
      errorMessage?: string | null;
      modelId?: string;
      model?: ResultModel | null;
      params?: Record<string, unknown>;
      creditsReserved?: number;
    },
  ): boolean {
    const isDisplayed = displayedJobRef.current === jobId;
    if (body.status === 'succeeded') {
      stopTrackingJob(jobId);
      // the finished asset must replace its card in the grid even when the
      // stage is detached — the grid's only source is the gallery
      void loadHistory();
      invalidateBalance();
      trackEvent(PlausibleEvent.generateSucceeded, {
        kind: isVideoAsset(body.resultAssets?.[0] ?? '') ? 'video' : 'image',
      });
      endTour();
      // including jobs that finished while another was on stage.
      const assets: string[] = body.resultAssets ?? [];
      setSessionResults((prev) => {
        const next = [...prev];
        for (const url of assets) {
          if (!next.some((r) => r.url === url)) {
            next.push({
              url,
              isVideo: isVideoAsset(url),
              label:
                body.model || body.modelId
                  ? receiptModelLabel(body.modelId, body.model)
                  : modelLabelRef.current,
              jobId,
              ...(body.modelId ? { modelId: body.modelId } : {}),
              ...(body.model ? { model: body.model } : {}),
              ...(body.params ? { params: body.params } : {}),
              ...(typeof body.creditsReserved === 'number'
                ? { creditsReserved: body.creditsReserved }
                : {}),
            });
          }
        }
        return next;
      });
      if (isDisplayed) {
        setSelectedAsset(assets.length > 1 ? null : 0);
        setPhase({
          kind: 'done',
          jobId,
          assets,
          ...(body.modelId ? { modelId: body.modelId } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(body.params ? { params: body.params } : {}),
          ...(typeof body.creditsReserved === 'number'
            ? { creditsReserved: body.creditsReserved }
            : {}),
        });
      }
      return true;
    }
    if (body.status === 'failed' || body.status === 'refunded') {
      stopTrackingJob(jobId);
      invalidateBalance();
      trackEvent(PlausibleEvent.generateFailed); // no error strings per spec prop rules
      if (isDisplayed)
        setPhase({
          kind: 'failed',
          message: jobFailureGuidance(body.errorCode, body.errorMessage).message,
          jobId,
          ...(body.modelId ? { modelId: body.modelId } : {}),
        });
      return true;
    }
    return false;
  }

  function stopTrackingJob(jobId: string) {
    trackedJobsRef.current.delete(jobId);
    forgetOwnedGenerateJob(jobId);
    setInflight((current) => inflightGenerationsReducer(current, { kind: 'remove', jobId }));
  }

  async function showJobResult(jobId: string, fallbackAssetUrl: string): Promise<void> {
    displayedJobRef.current = null;
    const requestId = ++receiptRequestRef.current;
    try {
      let body = receiptCacheRef.current.get(jobId);
      if (!body) {
        const res = await fetch(`${apiUrl}/v1/jobs/${jobId}`, {
          credentials: 'include',
          signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error('receipt_unavailable');
        body = (await res.json()) as {
          resultAssets?: string[];
          modelId?: string;
          model?: ResultModel | null;
          params?: Record<string, unknown>;
          creditsReserved?: number;
        };
        receiptCacheRef.current.set(jobId, body);
      }
      if (requestId === receiptRequestRef.current) {
        const assets = body.resultAssets?.length ? body.resultAssets : [fallbackAssetUrl];
        setSelectedAsset(Math.max(0, assets.indexOf(fallbackAssetUrl)));
        setPhase({
          kind: 'done',
          jobId,
          assets,
          ...(body.modelId ? { modelId: body.modelId } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(body.params ? { params: body.params } : {}),
          ...(typeof body.creditsReserved === 'number'
            ? { creditsReserved: body.creditsReserved }
            : {}),
        });
      }
      return;
    } catch {
      if (requestId === receiptRequestRef.current)
        setPhase({
          kind: 'unavailable',
          message: 'Не удалось загрузить параметры этой генерации. Попробуйте открыть её ещё раз.',
        });
    }
  }

  /** Fetch a tracked job's row and apply it. Driven by the job-event bus
   *  (JobsTray's shared SSE + poll), so a finished job resolves even if THIS
   *  screen's own poll loop was dropped — the resilient path. */
  async function resolveTrackedJob(jobId: string): Promise<void> {
    try {
      const res = await fetch(`${apiUrl}/v1/jobs/${jobId}`, {
        credentials: 'include',
        signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      applyJobResult(jobId, await res.json());
    } catch {
      /* the slow poll loop is still the backstop */
    }
  }

  async function pollJob(
    jobId: string,
    startedAt: number,
    deadlineMs: number,
    fails = 0,
  ): Promise<void> {
    if (unmountedRef.current) return;
    const isDisplayed = () => displayedJobRef.current === jobId;
    const elapsed = Date.now() - startedAt;

    // Overall deadline: a job that never reaches a terminal status (hung
    // provider, dead worker) must not spin the UI forever. The server reaper
    // flips it to failed + refunds the reservation in the background.
    if (elapsed > deadlineMs) {
      // We stop WATCHING here, but the job is NOT cancelled — it keeps rendering
      // on the worker and will land in «Архив» + the tray when done. Don't claim
      // failure or a refund (a job that finishes is charged, not refunded).
      if (isDisplayed())
        setPhase({
          kind: 'failed',
          stillRunning: true,
          message: STILL_RENDERING_MSG,
          jobId,
        });
      stopTrackingJob(jobId); // deadline: this screen stops tracking; the server stays authoritative
      return;
    }

    // Connectivity backstop: a single blip just retries, but losing the API
    // for several polls in a row surfaces a clear error instead of spinning.
    const retry = (nextFails: number) => {
      if (nextFails >= MAX_POLL_FAILS) {
        if (isDisplayed())
          setPhase({
            kind: 'failed',
            message: 'Потеряно соединение с сервером. Проверьте интернет и попробуйте снова.',
            jobId,
          });
        stopTrackingJob(jobId); // retries-exhausted: this screen stops tracking; the server stays authoritative
        return;
      }
      setTimeout(() => void pollJob(jobId, startedAt, deadlineMs, nextFails), 2000);
    };

    try {
      const res = await fetch(`${apiUrl}/v1/jobs/${jobId}`, {
        credentials: 'include',
        signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
      });
      // A vanished job is terminal; any other non-OK (5xx, upstream timeout)
      // is transient and retried within the deadline rather than killed.
      if (res.status === 404) {
        if (isDisplayed())
          setPhase({ kind: 'failed', message: 'Задача не найдена. Попробуй ещё раз.', jobId });
        stopTrackingJob(jobId); // not-found: this screen stops tracking; the server stays authoritative
        return;
      }
      if (!res.ok) {
        retry(fails + 1);
        return;
      }
      const body = await res.json();
      // Terminal (succeeded/failed) → apply assets/error and stop. Same path the
      // job-event bus uses, so behaviour is identical on either channel.
      if (applyJobResult(jobId, body)) return;
      // Queue stall: still queued long after submit → the worker isn't
      // consuming the queue. Surface immediately instead of an endless
      // spinner; nothing was charged for a job that never started running.
      if (body.status === 'queued' && elapsed > QUEUE_STALL_MS) {
        invalidateBalance();
        if (isDisplayed())
          setPhase({
            kind: 'failed',
            message:
              'Сервис генерации сейчас перегружен — задача не начала выполняться. Токены вернутся автоматически, попробуйте чуть позже.',
            jobId,
          });
        stopTrackingJob(jobId); // queue-stall: this screen stops tracking; the server stays authoritative
        return;
      }
      setInflight((current) =>
        inflightGenerationsReducer(current, {
          kind: 'status',
          jobId,
          status: inflightStatus(body.status),
        }),
      );
      if (isDisplayed()) setPhase({ kind: 'polling', jobId, status: body.status });
      setTimeout(() => void pollJob(jobId, startedAt, deadlineMs, 0), 1500);
    } catch {
      // Network blip or poll-fetch timeout — retry within the deadline. The
      // deadline + fail-count guards above guarantee this can't loop forever.
      retry(fails + 1);
    }
  }

  // Reload only jobs this Generate screen persisted at submit time. Account-wide
  // active rows include Boards work and must never take over this stage.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const owned = readOwnedGenerateJobs();
      if (owned.length === 0) return;
      try {
        const ownedIds = new Set(owned.map((job) => job.id));
        const restored = new Set<string>();
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        let pages = 0;
        let pruneUnresolved = false;
        while (ownedIds.size > 0 && !cancelled) {
          if (
            pages >= OWNED_GENERATE_RESTORE_MAX_PAGES ||
            (cursor !== null && seenCursors.has(cursor))
          ) {
            pruneUnresolved = true;
            break;
          }
          if (cursor) seenCursors.add(cursor);
          const query = new URLSearchParams({ limit: '100', status: 'queued,running' });
          if (cursor) query.set('cursor', cursor);
          const res = await fetch(`${apiUrl}/v1/jobs?${query}`, {
            credentials: 'include',
            signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
          });
          if (!res.ok || cancelled) {
            // A 403 here means these tab-local records no longer belong to an
            // accessible Generate session; retaining them would retry forever.
            if (res.status === 403 && !cancelled)
              sessionStorage.removeItem(OWNED_GENERATE_JOBS_KEY);
            return;
          }
          const body = (await res.json()) as {
            rows?: { id: string; status: string; modelId: string; createdAt: string }[];
            nextCursor?: string | null;
          };
          pages += 1;
          const jobs = restoreOwnedInflightJobs(body.rows ?? [], ownedIds);
          for (const job of jobs) {
            restored.add(job.id);
            ownedIds.delete(job.id);
            const jobModel = allModels.find((candidate) => candidate.id === job.modelId);
            const startedAt = Number.isNaN(Date.parse(job.createdAt))
              ? Date.now()
              : Date.parse(job.createdAt);
            const deadlineMs = renderDeadlineMs(
              jobModel?.expectedLatencyMsP50,
              jobModel?.kind === 'video',
            );
            trackedJobsRef.current.add(job.id);
            setInflight((current) =>
              inflightGenerationsReducer(current, {
                kind: 'add',
                generation: {
                  jobId: job.id,
                  modelId: job.modelId,
                  modelLabel: jobModel ? cardName(jobModel) : '',
                  kind: jobModel?.kind === 'video' ? 'video' : 'image',
                  startedAt,
                  etaSec: Math.max(
                    4,
                    Math.round((jobModel?.expectedLatencyMsP50 ?? 10_000) / 1000),
                  ),
                  status: inflightStatus(job.status),
                },
              }),
            );
            void pollJob(job.id, startedAt, deadlineMs);
          }
          cursor = body.nextCursor ?? null;
          if (!cursor) break;
        }
        // Only active jobs are returned above. Once the active listing has been
        // exhausted, any remaining owned id is terminal, deleted, or inaccessible.
        if ((!cursor || pruneUnresolved) && !cancelled) {
          sessionStorage.setItem(
            OWNED_GENERATE_JOBS_KEY,
            JSON.stringify(owned.filter((job) => restored.has(job.id))),
          );
        }
      } catch {
        /* the tray remains the independent visibility path */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  async function submitJob(
    seedOverride?: number,
    recipe?: {
      model: ModelRow;
      prompt: string;
      params: Record<string, unknown>;
      /**
       * Quote binding for «Повторить». The button's promise is "this again, at what
       * it cost", so the bound number is the ORIGINAL job's charge — not the current
       * form's quote, which describes a different configuration entirely. If the
       * catalogue has moved the server refuses and names the new price; the next
       * press binds to that, so the second press is consent to a number the user has
       * now been shown rather than a silent re-price.
       */
      expectedCost?: number | undefined;
      sourceJobId: string;
    },
  ): Promise<void> {
    if (submitGuardRef.current) return;
    const submitModel = recipe?.model ?? model;
    const submitIsVideo = submitModel?.kind === 'video';
    if (!submitModel || !projectContextReady) return;
    // Fail closed on the price, HERE and not at the button. «Создать» is gated on a
    // settled quote (`canSubmit`), but «Вариации», «Повторить» and its fallback all
    // reach this one POST by calling `submitJob` directly, and none of them consulted
    // that gate — so a transport failure or an in-flight re-quote left them clickable
    // and submitting unbound, which charges whatever the catalogue now says. One
    // guard at the only submit site covers every entry point, present and future.
    const boundCost = recipe ? recipe.expectedCost : (quotedCost ?? undefined);
    if (boundCost === undefined) {
      setPhase({
        kind: 'failed',
        message: 'Цена не подтверждена. Дождитесь её и повторите — ничего не списано.',
      });
      return;
    }
    submitGuardRef.current = true;
    setPhase({ kind: 'submitting' });
    const submitted: { jobId: string; status?: string; startedAt: number }[] = [];
    const deadlineMs = renderDeadlineMs(submitModel.expectedLatencyMsP50, submitIsVideo);
    try {
      // Use the applied EN enhancement if available; otherwise fall back to
      // the raw RU textarea value. BytePlus/Seedream prefers English prompts.
      // The selected effect's phrase is folded in here (kept out of the visible
      // prompt) so the textarea stays the user's clean scene description.
      // The user's own subject text (EN enhancement wins when present). When a
      // non-replace preset is applied, its recipe is composited around that
      // subject via the shared merge engine; the video effect phrase folds on
      // the end. composeSubmitPrompt is the ONE place apply/submit agree.
      const userText = (appliedEnhancement ?? prompt).trim();
      const promptToSend =
        recipe?.prompt ??
        composeSubmitPrompt({
          userText,
          preset: appliedPreset,
          slotValues,
          effectPhrase: isVideo ? (selectedEffect?.promptTemplate ?? '') : '',
        });
      const effectiveSeed = seedOverride ?? seedValue;
      const params: Record<string, unknown> = recipe
        ? withLegacyRung(recipe.params, submitModel)
        : isVideo
          ? {
              // «Авто» (-1) is disabled: the API bills duration upfront and
              // rejects duration<=0 (duration_seconds_required), so auto could
              // never succeed. Always send the explicit clamped duration until
              // post-hoc billing for provider-chosen durations exists.
              duration_seconds: clampedDuration,
              resolution: effectiveResolution,
              aspect_ratio: effectiveAspect,
              generate_audio: audioCapable ? genAudio : false,
              ...(watermark ? { watermark: true } : {}),
              ...(returnLastFrame ? { return_last_frame: true } : {}),
            }
          : imageGenerationParams(
              size,
              imageQuality,
              count,
              !recipe && (imageRefCapable || isEditing) ? imageUrls : undefined,
            );
      if (!recipe && effectiveSeed != null) params['seed'] = effectiveSeed;
      // Preset negative prompt — only for image engines that honour it (diffusion
      // models declare `capabilities.negativePrompt`; natural-language t2v ignore
      // it, so we drop it there rather than send a no-op field).
      if (
        !recipe &&
        !isVideo &&
        appliedPreset?.negativePrompt?.trim() &&
        supportsNegativePrompt(submitModel)
      ) {
        params['negative_prompt'] = appliedPreset.negativePrompt.trim();
      }
      // Attach media per the picked card's declared capacity: a frame model gets
      // its keyframes (upgrading t2v → i2v, capped at the slots it declares), a
      // reference model gets typed reference arrays, a t2v-only engine (Sora,
      // Grok: frames:[]) gets none. One helper so the drop zone the user sees
      // and the payload we send can't disagree.
      if (!recipe && isVideo && model) {
        Object.assign(
          params,
          videoMediaParams(model, { images: imageUrls, videos: videoUrls, audios: audioUrls }),
        );
      }
      if (!recipe && webSearch && webSearchCapable) params['webSearch'] = true;
      // Multi-take (video): «Дубли ×N» = N independent jobs with the same
      // prompt/params — the industry-standard fan-out. Image batching stays a
      // single job (server-side n). Each POST gets its own idempotency key.
      const takes = recipe ? 1 : isVideo ? count : 1;
      const jobEtaSec = Math.max(
        4,
        Math.round((submitModel.expectedLatencyMsP50 ?? (submitIsVideo ? 240_000 : 10_000)) / 1000),
      );
      for (let i = 0; i < takes; i++) {
        const res = await fetch(`${apiUrl}/v1/jobs`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            modelId: submitModel.id,
            prompt: promptToSend,
            params,
            idempotencyKey: idemRef.current,
            ...(appliedPresetSlug ? { presetSlug: appliedPresetSlug } : {}),
            // Quote binding: the per-job number this button is showing (or, for a
            // repeat, what the original job cost). The server charges its own resolved
            // price and refuses with 409 `quote_stale` if the two differ, so a
            // catalogue change between quote and press can never be charged silently.
            // Unconditional — the guard above refused to get here without one.
            expectedCost: boundCost,
            ...(workspaceProject ? { projectId: workspaceProject.id } : {}),
            // Dev gateway override; omitted in prod so the server default applies.
            ...(devTools ? { provider: gateway } : {}),
          }),
          // A hung submit must not stick on «Запуск…» forever — bound it.
          signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
        });
        if (res.status === 403) {
          // Pre-paywall anonymous browsing (2026-07-07): the hard wall — an
          // anonymous session reached the actual credit-spending call. Send
          // them to sign up, carrying the in-progress prompt/model/preset back
          // via ?next= so they land on this exact draft once they're real.
          const body = await res.json().catch(() => ({}));
          if (submitted.length === 0 && body?.error === 'signup_required') {
            const qs = new URLSearchParams();
            if (prompt) qs.set('prompt', prompt);
            if (appliedPreset) qs.set('preset', appliedPreset.slug);
            if (model) qs.set('model', model.id);
            if (isVideo && !durationAuto) qs.set('sec', String(clampedDuration));
            if (isVideo && count > 1) qs.set('n', String(count));
            // Keep the public showcase handle through the wall (J-2 follow-up):
            // after sign-up the ?via prefill rebuilds the FULL recipe — including
            // the reference images the prompt/preset pair alone cannot carry.
            if (viaSlug) qs.set('via', viaSlug);
            if (fromJobId) qs.set('from', fromJobId);
            const standaloneNext = qs.size > 0 ? `/generate?${qs}` : '/generate';
            const next = workspaceProject
              ? withProjectContext(standaloneNext, workspaceProject.id)
              : standaloneNext;
            window.location.href = `/login?next=${encodeURIComponent(next)}`;
            return;
          }
          if (submitted.length === 0) {
            setPhase({
              kind: 'failed',
              message:
                body?.error === 'tier_required'
                  ? 'Эта модель недоступна в текущем тарифе.'
                  : 'Нет доступа к этой модели. Выберите доступную модель и повторите.',
            });
            return;
          }
          break;
        }
        if (res.status === 402) {
          // Credits ran out mid-fan-out: the takes that DID start are reserved
          // and keep rendering — only a fully-empty fan-out is an error state.
          if (submitted.length === 0) {
            setPhase({ kind: 'insufficient' });
            return;
          }
          break;
        }
        if (res.status === 400) {
          if (submitted.length === 0) {
            const body = await res.json().catch(() => ({}));
            setPhase({
              kind: 'failed',
              message:
                body?.error === 'model_not_available'
                  ? 'Модель недоступна'
                  : // A price refusal ships its own RU text (pricing-resolver.ts
                    // `priceRefusalMessage`); «Неверные параметры запроса» would
                    // hide a data hole behind a user-error message. origin/main's
                    // resolution_not_available line is kept as the fallback for a
                    // code that carries no message of its own.
                    (typeof body?.message === 'string' && body.message) ||
                    (body?.error === 'resolution_not_available'
                      ? 'Выбранное разрешение недоступно для этой модели. Обновите настройки и повторите.'
                      : 'Неверные параметры запроса'),
            });
            return;
          }
          break;
        }
        if (res.status === 409) {
          // Quote binding (see the API's `quote_stale`): the catalogue moved between
          // the number on this button and the press. Nothing was charged. Pull a fresh
          // quote and make the user press again — re-submitting silently at the new
          // price is exactly what this refusal exists to prevent. The idempotency key
          // is left alone: no job was created under it.
          const quoteBody = await res
            .clone()
            .json()
            .catch(() => null);
          if (quoteBody?.error === 'quote_stale') {
            setQuoteRefresh((n) => n + 1);
            // A repeat has no estimate hook to refresh — its number came from the
            // original job. Remember the price the server just named so the next
            // press binds to THAT, which both terminates (the old charge would be
            // refused forever) and keeps the second press bound rather than blind.
            if (recipe && typeof quoteBody.cost === 'number') {
              repeatQuoteRef.current = { jobId: recipe.sourceJobId, cost: quoteBody.cost };
            }
            if (submitted.length === 0) {
              setPhase({
                kind: 'failed',
                message:
                  typeof quoteBody.message === 'string'
                    ? quoteBody.message
                    : 'Цена изменилась. Проверьте её и нажмите «Создать» ещё раз.',
              });
              return;
            }
            // Mid-fan-out. The takes already accepted are real jobs against reserved
            // credits, so they must keep rendering — but the user asked for N and is
            // getting fewer, and silence about that is the defect, not the dropped
            // takes. Poll what started (it lands in the filmstrip and the tray), then
            // say plainly how many of how many, since `polling` carries no message of
            // its own. Deliberately NOT modelled on the insufficient-balance path
            // below, which is silent for the same reason and is wrong for the same
            // reason; that one is tracked separately.
            for (const job of submitted) void pollJob(job.jobId, job.startedAt, deadlineMs);
            setPhase({
              kind: 'failed',
              message: `Цена изменилась после ${submitted.length} из ${takes}: остальные дубли не запущены. Проверьте новую цену и запустите их снова.`,
            });
            return;
          }
          // The previous request may have committed after its response was
          // lost. If the user changed that request before retrying, the server
          // correctly refuses to replay the old job. Rotate here so the next
          // deliberate submit is a fresh logical generation instead of an
          // unrecoverable loop on the stale key.
          idemRef.current = randomKey();
          if (submitted.length === 0) {
            setPhase({
              kind: 'failed',
              message: 'Запрос изменился после сбоя. Нажмите «Создать» ещё раз.',
            });
            return;
          }
          break;
        }
        if (!res.ok && res.status !== 201 && res.status !== 200) {
          if (submitted.length === 0) {
            // Capacity caps: explicit RU copy instead of the generic HTTP
            // fallback — nothing was charged, the balance is re-checked.
            const capsBody = await res
              .clone()
              .json()
              .catch(() => null);
            if (res.status === 429 && capsBody?.error === 'too_many_active_jobs') {
              invalidateBalance();
              setPhase({
                kind: 'failed',
                message:
                  'Слишком много активных задач. Дождитесь завершения одной и повторите — ничего не списано, баланс уже перепроверен.',
              });
              return;
            }
            if (
              res.status === 503 &&
              (capsBody?.error === 'generation_disabled' ||
                capsBody?.error === 'daily_spend_cap_exceeded')
            ) {
              invalidateBalance();
              setPhase({
                kind: 'failed',
                message:
                  typeof capsBody?.message === 'string' && capsBody.message
                    ? capsBody.message
                    : 'Генерация временно недоступна. Попробуйте позже — ничего не списано, баланс перепроверим автоматически.',
              });
              return;
            }
            setPhase({ kind: 'failed', message: `Ошибка сервера (HTTP ${res.status})` });
            return;
          }
          break;
        }
        const body = await res.json();
        const startedAt = Date.now();
        submitted.push({ jobId: body.jobId, status: body.status, startedAt });
        // A one-shot action consumes only the exact frame it attached. References
        // the user added themselves remain in the draft for the next run.
        if (submitted.length === 1 && oneShotReferenceRef.current) {
          const oneShotId = oneShotReferenceRef.current;
          setReferenceMedia((current) => current.filter((reference) => reference.id !== oneShotId));
          setReturnLastFrame(false);
          setEditOn(false);
          oneShotReferenceRef.current = null;
        }
        rememberOwnedGenerateJob(body.jobId);
        trackedJobsRef.current.add(body.jobId);
        setInflight((current) =>
          inflightGenerationsReducer(current, {
            kind: 'add',
            generation: {
              jobId: body.jobId,
              modelId: submitModel.id,
              modelLabel: cardName(submitModel),
              kind: submitIsVideo ? 'video' : 'image',
              startedAt,
              etaSec: jobEtaSec,
              status: inflightStatus(body.status),
            },
          }),
        );
        // A submit sound means a durable job was actually accepted — never
        // play it for a rejected 400/402 request that did not start rendering.
        if (submitted.length === 1) sound.submit();
        // Ready for the next concurrent submission.
        idemRef.current = randomKey();
        invalidateBalance();
        trackEvent(PlausibleEvent.generateSubmitted);
        window.dispatchEvent(new Event(JOB_SUBMITTED_EVENT));
      }
      const first = submitted[0];
      if (!first) return; // every error path above already set a phase
      // The FIRST take goes on stage; the others poll in parallel and land in
      // the session filmstrip / tray as they finish (applyJobResult only
      // touches `phase` for the displayed job).
      displayedJobRef.current = first.jobId;
      jobStartedRef.current = first.startedAt;
      jobDeadlineRef.current = deadlineMs;
      setElapsedSec(0);
      setPhase({ kind: 'polling', jobId: first.jobId, status: first.status ?? 'queued' });
      for (const j of submitted) {
        void pollJob(j.jobId, j.startedAt, deadlineMs);
      }
    } catch (err) {
      if (submitted.length > 0) {
        for (const job of submitted) void pollJob(job.jobId, job.startedAt, deadlineMs);
      }
      setPhase({ kind: 'failed', message: networkErrorMessage(err) });
    } finally {
      // Also releases after aborts, timeouts, rejected requests, and partial
      // fan-out so a deliberate retry can reuse the still-current key.
      submitGuardRef.current = false;
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submitJob();
  }

  /* ---- Per-result actions (the iteration loop) ---- */

  /** «Вариации» — same prompt/params, new randomness. A fixed seed bumps +1
   * (visibly deterministic); a random seed just re-rolls. */
  function vary() {
    const next = seedValue != null ? seedValue + 1 : null;
    if (next != null) setSeedValue(next);
    void submitJob(next ?? undefined);
  }

  /** «Оживить» — Seedream result becomes the first frame of a Seedance job. */
  function animateImage(url: string) {
    setMode('video');
    setEditOn(false);
    if (frameVideoModel) selectModel(frameVideoModel.id);
    oneShotReferenceRef.current = attachReference('image', url);
  }

  /** «Редактировать» — result becomes the source of an instruction edit. */
  function editImage(url: string) {
    setMode('image');
    if (imageEditModel) selectModel(imageEditModel.id);
    oneShotReferenceRef.current = attachReference('image', url);
    setEditOn(true);
  }

  /** «В референсы» — append to the @-reference pool for the next prompt. */
  function addReference(url: string) {
    setMode('image');
    attachReference('image', url);
  }

  function addVideoReference(url: string) {
    setMode('video');
    if (referenceVideoModel) selectModel(referenceVideoModel.id);
    attachReference('video', url);
  }

  /** «Продолжить» — the returned last frame seeds the next clip (extend). */
  function extendVideo(lastFrameUrl: string) {
    if (frameVideoModel) selectModel(frameVideoModel.id);
    oneShotReferenceRef.current = attachReference('image', lastFrameUrl);
    setReturnLastFrame(true);
  }

  /** The credits a finished job actually reserved, or null if it cannot be read. */
  async function jobCreditsReserved(jobId: string): Promise<number | null> {
    try {
      const res = await fetch(`${apiUrl}/v1/jobs/${jobId}`, {
        credentials: 'include',
        signal: AbortSignal.timeout(REPEAT_REFERENCE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { creditsReserved?: unknown };
      return typeof body.creditsReserved === 'number' && body.creditsReserved > 0
        ? body.creditsReserved
        : null;
    } catch {
      return null;
    }
  }

  /** «Повторить» — run the exact same persisted prompt + settings again. */
  async function repeat() {
    if (repeatValidationRef.current) return;
    if (phase.kind === 'done' && phase.modelId && phase.params) {
      const repeatModel = allModels.find((candidate) => candidate.id === phase.modelId);
      const repeatPrompt = phase.params['prompt'];
      if (repeatModel && typeof repeatPrompt === 'string') {
        if (!canUseModel(repeatModel)) {
          setPhase({ kind: 'failed', message: 'Эта модель недоступна в текущем тарифе.' });
          return;
        }
        repeatValidationRef.current = true;
        setRepeatValidation(true);
        const referenceUrls = ['imageUrls', 'videoUrls', 'audioUrls'].flatMap((key) => {
          const value = phase.params?.[key];
          return Array.isArray(value)
            ? value.filter((url): url is string => typeof url === 'string')
            : [];
        });
        try {
          const statuses = await Promise.all(
            referenceUrls.map(async (url) => {
              try {
                const res = await fetch(assetSrc(url), {
                  method: 'HEAD',
                  credentials: 'include',
                  signal: AbortSignal.timeout(REPEAT_REFERENCE_TIMEOUT_MS),
                });
                return res.status;
              } catch {
                // CORS, auth, or a transient timeout cannot prove an asset is gone.
                return null;
              }
            }),
          );
          if (statuses.some((status) => status === 404 || status === 410)) {
            setPhase({
              kind: 'failed',
              message:
                'Один из референсов больше недоступен. Прикрепите замену в редакторе и создайте генерацию заново.',
            });
            return;
          }
          // What this job actually cost, read from the persisted row rather than
          // from `phase` — the receipt reaches this state by three different routes
          // and only one of them carries a price. A price we cannot read leaves the
          // submit unbound, which is what it was before quote binding existed; it
          // never guesses one from the form.
          // Read the receipt FIRST and let the acknowledgement be the fallback — the same
          // order `repeatCostForJob` uses to paint the button. These two used to be
          // reversed, so once a stale-price 409 had recorded an acknowledgement for this
          // job (a ref that is keyed only by jobId and never cleared), the button kept
          // showing the receipt's reservation while the submit bound the acknowledged
          // number: seen 597, charged 650, with 650 visible only in a since-dismissed
          // toast from an earlier press.
          const acknowledged =
            repeatQuoteRef.current?.jobId === phase.jobId ? repeatQuoteRef.current.cost : null;
          const originalCost = repeatCostForJob(
            phase.jobId,
            await jobCreditsReserved(phase.jobId),
            acknowledged === null ? null : { jobId: phase.jobId, cost: acknowledged },
          );
          await submitJob(undefined, {
            model: repeatModel,
            prompt: repeatPrompt,
            params: { ...phase.params },
            sourceJobId: phase.jobId,
            ...(originalCost === null ? {} : { expectedCost: originalCost }),
          });
        } finally {
          repeatValidationRef.current = false;
          setRepeatValidation(false);
        }
        return;
      }
    }
    void submitJob(seedValue ?? undefined);
  }

  /**
   * «В Studio» — append the result to the Studio timeline and open the editor.
   * Calls the existing Studio project API (same contract as the boards
   * «собрать» flow); it never re-implements editing inside /generate, and it
   * appends rather than clobbering any work already in the timeline.
   */
  async function sendToStudio(url: string) {
    setHandingOff(true);
    try {
      const dur = isVideo ? clampedDuration : 5;
      const clip = {
        uid: `tl-gen-${Date.now()}`,
        url,
        dur,
        inSec: 0,
        outSec: dur,
        speed: 1,
        muted: false,
        volumeDb: 0,
        transition: 'cut',
        transitionSec: 0.5,
        filter: 'none',
      };
      let tl: {
        timeline: unknown[];
        texts: unknown[];
        music: unknown;
        voiceover: unknown;
        formatId: string;
      } = { timeline: [], texts: [], music: null, voiceover: null, formatId: '9:16' };
      try {
        const r = await fetch(`${apiUrl}/v1/studio/project`, { credentials: 'include' });
        if (r.ok) {
          const b = await r.json();
          if (b?.timeline && Array.isArray(b.timeline.timeline)) tl = b.timeline;
        }
      } catch {
        /* no existing project — start a fresh timeline */
      }
      await fetch(`${apiUrl}/v1/studio/project`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeline: { ...tl, timeline: [...tl.timeline, clip] } }),
      }).catch(() => {});
      window.location.href = '/studio';
    } finally {
      setHandingOff(false);
    }
  }

  const loadingStageKey: 'submitting' | 'queued' | 'running' =
    phase.kind === 'submitting'
      ? 'submitting'
      : phase.kind === 'polling' && phase.status === 'queued'
        ? 'queued'
        : 'running';

  // Mobile (single column): the stage sits BELOW the create panel, so a job's
  // progress/result would land off-screen. Bring it into view when generation
  // starts or a result arrives. Desktop (two-zone) needs no scroll.
  useEffect(() => {
    if (typeof window === 'undefined' || window.innerWidth >= 1024) return;
    if (phase.kind === 'submitting' || phase.kind === 'polling' || phase.kind === 'done') {
      canvasRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [phase.kind]);

  // Tick the elapsed counter while a job is on stage — and enforce the deadline
  // here too. The poll loop checks its own deadline, but if that loop AND the
  // event bus were both dropped (flaky tunnel), this independent timer is the
  // last line of defence: the clock can never tick past the deadline without
  // resolving. Try one final fetch (the job has very likely finished), then
  // fall back to the "still rendering in the background" message.
  useEffect(() => {
    if (!isBusy) return;
    const t = setInterval(() => {
      if (!jobStartedRef.current) return;
      const elapsed = Date.now() - jobStartedRef.current;
      setElapsedSec(Math.floor(elapsed / 1000));
      if (jobDeadlineRef.current && elapsed > jobDeadlineRef.current) {
        const jid = displayedJobRef.current;
        if (jid) void resolveTrackedJob(jid);
        setPhase((p) =>
          p.kind === 'submitting' || p.kind === 'polling'
            ? { kind: 'failed', stillRunning: true, message: STILL_RENDERING_MSG }
            : p,
        );
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy]);

  // Resolve jobs from the shared job-event bus (JobsTray owns the single SSE +
  // poll and re-dispatches every event). This is the resilient completion path:
  // even if THIS screen's per-job poll loop is dropped, a terminal event here
  // still lands the result. pollJob stays as the slow fallback.
  useEffect(() => {
    const onBusEvent = (e: Event) => {
      const evt = (e as CustomEvent).detail as JobBusEvent | undefined;
      if (!evt?.jobId) return;
      const action = jobEventAction(evt, {
        tracked: trackedJobsRef.current,
        displayedJobId: displayedJobRef.current,
      });
      if (action.kind === 'resolve') void resolveTrackedJob(evt.jobId);
      else if (evt.source === 'generation' && trackedJobsRef.current.has(evt.jobId))
        setInflight((current) =>
          inflightGenerationsReducer(current, {
            kind: 'status',
            jobId: evt.jobId,
            status: inflightStatus(evt.status),
          }),
        );
      if (action.kind === 'progress' && displayedJobRef.current === evt.jobId)
        setPhase({ kind: 'polling', jobId: evt.jobId, status: action.status });
    };
    window.addEventListener(JOB_EVENT, onBusEvent);
    return () => window.removeEventListener(JOB_EVENT, onBusEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⌘/Ctrl+Enter submits from anywhere on the screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit && !modelLocked) {
        e.preventDefault();
        void submitJob();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSubmit, modelLocked, prompt, imageUrls, videoUrls, audioUrls, seedValue, modelId, mode]);

  // ETA from the model's median latency; the bar approaches but never
  // claims completion (asymptote at 94%) — honest, not theatrical.
  const etaSec = Math.max(
    4,
    Math.round((model?.expectedLatencyMsP50 ?? (isVideo ? 240_000 : 10_000)) / 1000),
  );
  const displayedInflight = inflight.find(
    (generation) => generation.jobId === displayedJobRef.current,
  );
  const stageEtaSec = displayedInflight?.etaSec ?? etaSec;
  const progressPct = inflightProgressPct(elapsedSec, stageEtaSec, loadingStageKey);
  // Aspect-correct placeholder so the result doesn't cause a layout jump.
  const sizePx = sizes.find((s) => s.id === size)?.id ?? size;
  const modelLabel = model ? cardName(model) : '';
  const catalogueResultModel =
    phase.kind === 'done' && phase.modelId
      ? (allModels.find((candidate) => candidate.id === phase.modelId) ?? null)
      : null;
  const resultModel = phase.kind === 'done' ? (catalogueResultModel ?? phase.model ?? null) : null;
  const resultModelLabel =
    phase.kind === 'done' ? receiptModelLabel(phase.modelId, phase.model) : 'Модель недоступна';
  const resultParams = phase.kind === 'done' ? phase.params : undefined;
  const resultResolution =
    typeof resultParams?.resolution === 'string'
      ? resultParams.resolution
      : typeof resultParams?.quality === 'string'
        ? resultParams.quality
        : null;
  const resultDuration =
    typeof resultParams?.duration_seconds === 'number' ? resultParams.duration_seconds : null;
  const resultSize =
    typeof resultParams?.size === 'string'
      ? resultParams.size
      : typeof resultParams?.aspect_ratio === 'string'
        ? resultParams.aspect_ratio
        : null;
  const resultPrompt = typeof resultParams?.prompt === 'string' ? resultParams.prompt : null;
  const resultIsVideo =
    resultModel?.kind === 'video' ||
    (resultModel == null &&
      phase.kind === 'done' &&
      (resultDuration != null || phase.assets.some(isVideoAsset)));
  const resultVideoFormat =
    resultResolution ??
    (typeof resultParams?.aspect_ratio === 'string' ? resultParams.aspect_ratio : null);
  const resultDetails = resultIsVideo
    ? [resultDuration != null ? `${resultDuration}s` : null, resultVideoFormat]
        .filter(Boolean)
        .join(' · ')
    : [resultSize, resultResolution].filter(Boolean).join(' · ');
  const resultAudio =
    typeof resultParams?.generate_audio === 'boolean' ? resultParams.generate_audio : null;
  const repeatCost =
    phase.kind === 'done'
      ? repeatCostForJob(phase.jobId, phase.creditsReserved, repeatQuoteRef.current)
      : null;
  // Mirror into a ref so the bus-driven resolver (captured once) labels session
  // results with the current model rather than a stale one.
  modelLabelRef.current = modelLabel;

  // Current asset on stage: grid view (selectedAsset === null) has no single
  // current asset; single view (or 1-asset result) does.
  const doneAssets = phase.kind === 'done' ? phase.assets : [];
  const inGridView = doneAssets.length > 1 && selectedAsset === null;
  const curAsset = doneAssets.length
    ? doneAssets[Math.min(selectedAsset ?? 0, doneAssets.length - 1)]!
    : null;
  const curIsVideo = curAsset ? isVideoAsset(curAsset) : false;
  // Extend: a video job with return_last_frame produces mp4 + frame image.
  const lastFrameAsset = curIsVideo ? doneAssets.find((a) => !isVideoAsset(a)) : undefined;
  // «Редактировать» needs at least one edit-capable image model in the catalog.
  const editModelAvailable = allModels.some(
    (m) =>
      m.kind !== 'video' && ((m.capabilities ?? {}) as Record<string, unknown>)['edit'] === true,
  );

  // Reference / source inputs. VIDEO shows ONE drop zone bounded by the picked
  // card's declared capacity — keyframe slots on a frames model, image/video/
  // audio references on a reference model, nothing at all on a text-to-video
  // engine. IMAGE shows the edit source (only while editing a result) + web
  // search. Above the prompt in video.
  const videoDropZone = isVideo && videoMedia && videoMedia.role !== 'none';
  const referenceInputs =
    videoDropZone ||
    (editCapable && editOn) ||
    imageRefCapable ||
    (webSearchCapable && !isVideo) ||
    hasUnsupportedReferenceMedia ? (
      <div className="shrink-0 space-y-3 border-t-[1.5px] border-[color:var(--color-line)]/20 pt-3">
        {videoDropZone && model && (
          <ReferenceDropZone
            apiUrl={apiUrl}
            assetSrc={assetSrc}
            images={imageReferences}
            videos={videoReferences}
            audios={audioReferences}
            limits={referenceMediaLimits ?? videoMediaLimits(model)}
            role={videoMedia!.role === 'reference' ? 'reference' : 'frame'}
            onChange={({ images, videos, audios }) => {
              replaceReferenceEntries('image', images);
              replaceReferenceEntries('video', videos);
              replaceReferenceEntries('audio', audios);
            }}
          />
        )}
        {!isVideo && editCapable && editOn ? (
          <MediaPicker
            kind="image"
            label="Исходное изображение"
            max={14}
            value={imageReferences}
            onChange={(images) => replaceReferenceEntries('image', images)}
            apiUrl={apiUrl}
            hint="Изменим его по твоему промпту."
          />
        ) : !isVideo && imageRefCapable ? (
          // Image references — same asset-input UX as video, images only.
          <ReferenceDropZone
            limits={{ image: imageReferenceLimit, video: 0, audio: 0 }}
            role="reference"
            apiUrl={apiUrl}
            assetSrc={assetSrc}
            images={imageReferences}
            videos={[]}
            audios={[]}
            onChange={({ images }) => replaceReferenceEntries('image', images)}
          />
        ) : null}
        {!videoDropZone &&
          !(editCapable && editOn) &&
          !imageRefCapable &&
          hasUnsupportedReferenceMedia && (
            <>
              <ReferenceDropZone
                apiUrl={apiUrl}
                assetSrc={assetSrc}
                images={imageReferences}
                videos={videoReferences}
                audios={audioReferences}
                limits={{ image: 0, video: 0, audio: 0 }}
                role="reference"
                onChange={({ images, videos, audios }) => {
                  replaceReferenceEntries('image', images);
                  replaceReferenceEntries('video', videos);
                  replaceReferenceEntries('audio', audios);
                }}
              />
              <p className="text-[11px] text-[color:var(--color-faint)]">
                Выбранная модель не использует эти референсы. Убери их или выбери модель с
                поддержкой референсов.
              </p>
            </>
          )}
        {webSearchCapable && !isVideo && (
          <button
            type="button"
            onClick={() => setWebSearch((v) => !v)}
            className="press-inset flex w-full items-center justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] px-3.5 py-2.5 text-[13px] transition-colors hover:bg-[color:var(--color-surface)]"
          >
            <span className="text-[color:var(--color-muted-foreground)]">
              Веб-поиск (актуальность)
            </span>
            {/* Nested switch track: quiet hairline, not a bone border — it lives
                inside the already-2.5px dock panel (bible: nested chrome). */}
            <span
              className={
                'flex h-5 w-9 items-center border-[1.5px] border-[color:var(--color-line-soft)] p-0.5 transition-colors ' +
                (webSearch
                  ? 'justify-end bg-[color:var(--color-accent)]'
                  : 'justify-start bg-[color:var(--color-surface2)]')
              }
            >
              <span className="h-3 w-3 bg-[color:var(--color-fg)]" />
            </span>
          </button>
        )}
        {missingMedia && (
          <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
            {isEditing
              ? 'Добавь изображение для правки.'
              : isReferenceMode
                ? referenceRequiredCopy(referenceMediaLimits!)
                : 'Добавь первый кадр.'}
          </p>
        )}
      </div>
    ) : null;

  /* Guided onboarding walkthrough — anchored spotlight tour (OnboardingTour).
     Keep this in the returned tree; a bare JSX expression in the function body
     is evaluated and discarded rather than mounted by React. */
  const onboardingTour = tourActive ? (
    <OnboardingTour
      step={tourStep}
      mobile={isMobileViewport}
      locale={locale}
      onAdvance={advanceTour}
      onDismiss={endTour}
    />
  ) : null;
  return (
    <div className="mx-auto w-full max-w-[1640px] overflow-x-hidden px-4 py-4 sm:px-6 lg:flex lg:h-[calc(100dvh-68px)] lg:flex-col lg:overflow-hidden lg:px-6 lg:py-5">
      {onboardingTour}
      {/* Slim page header — the big "Плиты" carry the weight now, so the title
          steps back; mode lives in the dock. */}
      <div className="mb-4 flex items-center justify-between gap-3 lg:shrink-0">
        <div className="min-w-0">
          <p className="label-eyebrow mb-1.5">Генерация · Vertov</p>
          <h1 className="font-display text-[clamp(22px,3vw,30px)] font-black uppercase leading-none tracking-[-0.01em] text-[color:var(--color-fg)]">
            Создать {isVideo ? 'видео' : 'изображение'}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {/* Dev-only gateway switch — routes jobs to Evolink or AtlasCloud. */}
          {devTools && (
            <div
              className="hidden items-center gap-1 rounded-[var(--radius-md)] p-1 sm:flex glass"
              title="Dev: провайдер генерации"
              data-testid="gateway-switch"
            >
              {(['openrouter', 'atlascloud'] as const).map((g) => {
                const on = gateway === g;
                return (
                  <button
                    key={g}
                    type="button"
                    data-testid={`gateway-${g}`}
                    onClick={() => changeGateway(g)}
                    className={
                      'rounded-[var(--radius-sm)] px-3 py-1.5 font-mono text-[13px] font-bold uppercase tracking-[0.06em] transition-colors duration-200 ' +
                      (on
                        ? 'selected-neutral'
                        : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                    }
                  >
                    {g === 'openrouter' ? 'OpenRouter' : 'AtlasCloud'}
                  </button>
                );
              })}
            </div>
          )}
          <button
            type="button"
            onClick={resetAll}
            title="Сбросить"
            aria-label="Сбросить"
            className="press-inset grid h-11 w-11 place-items-center rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>

      {/* Mobile (< lg) pane switch — «Управление» (dock) ⇄ «Результат». */}
      <div className="mb-4 lg:hidden">
        <div className="flex rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] p-0.5">
          {(
            [
              { id: 'controls', label: 'Управление', icon: <SlidersHorizontal size={15} /> },
              { id: 'preview', label: 'Результат', icon: <Eye size={15} /> },
            ] as const
          ).map((p) => {
            const on = pane === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPane(p.id)}
                className={
                  'press-inset flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-xs)] py-2.5 text-[13px] font-bold uppercase tracking-[0.03em] transition-colors ' +
                  (on
                    ? 'selected-neutral'
                    : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                }
              >
                {p.icon}
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Layout A — dock | preview (two-col ≥ lg, pane-switched < lg) */}
      <div className="grid gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)] lg:gap-8">
        {/* ---------------- Control dock («Метро-док», SPEC 03-06) ---------------- */}
        {/* The dock column: a STANDALONE mode plate at full width ABOVE the dock,
            then the one calm dock panel below it (D16). */}
        <div
          className={
            'min-w-0 flex-col gap-4 lg:flex lg:min-h-0 ' + (pane === 'controls' ? 'flex' : 'hidden')
          }
        >
          {/* Mode plate — standalone, above the dock; two fused cells, active = periwinkle */}
          <div className="flex shrink-0 overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)]">
            {(['image', 'video'] as const).map((m, i) => {
              const on = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  data-testid={`mode-${m}`}
                  aria-pressed={on}
                  onClick={() => setMode(m)}
                  className={
                    'press-inset flex flex-1 items-center justify-center gap-2 py-3 text-[13px] font-bold uppercase tracking-[0.04em] transition-colors ' +
                    (i === 1 ? 'border-l-[2.5px] border-[color:var(--color-line)] ' : '') +
                    (on
                      ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                      : 'bg-[color:var(--color-surface2)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                  }
                >
                  <PixelGlyph name={m === 'image' ? 'image' : 'video'} size={15} />
                  {m === 'image' ? 'Изображение' : 'Видео'}
                </button>
              );
            })}
          </div>
          <form
            onSubmit={onSubmit}
            className="flex min-w-0 flex-1 flex-col gap-4 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-4 shadow-[6px_6px_0_0_var(--color-shadow)] max-sm:pb-40 lg:min-h-0 lg:overflow-hidden"
          >
            {/* Controls — compact so the whole dock fits one screen (no scroll).
              The prompt well (flex-1) absorbs all remaining slack. */}
            <div className="seed-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto lg:pr-1">
              {/* Two CO-EQUAL selector cards — Модель + Эффект (Higgsfield: the
                effect is a first-class, visually promoted product, not a
                chip). Tapping either opens its full grid in the preview
                panel; both are the same size. */}
              {/* МОДЕЛЬ / ЭФФЕКТ — engraved full-width rows (Метро-док): no own frame,
                printed on the dock surface, a chevron opens the full grid. */}
              <div className="flex shrink-0 flex-col gap-2">
                <select
                  data-testid="model-select"
                  value={modelId}
                  onChange={(e) => selectModel(e.target.value)}
                  className="sr-only"
                  aria-label="Модель"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {cardName(m)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="model-trigger"
                  data-tour-target="model"
                  aria-haspopup="menu"
                  aria-expanded={pickerOpen && pickerView === 'model'}
                  onClick={() => {
                    setPickerView('model');
                    setPickerOpen(true);
                    setPane('preview');
                  }}
                  className={
                    'press-inset flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-3 py-2.5 text-left transition-colors ' +
                    (pickerOpen && pickerView === 'model'
                      ? 'bg-[rgba(var(--accent-rgb),0.12)]'
                      : 'bg-[color:var(--color-surface2)] hover:bg-[color:var(--color-surface)]')
                  }
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-faint)]">
                      Модель
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold text-[color:var(--color-fg)]">
                        {currentCard?.name ?? (isVideo ? 'Видео-модель' : '—')}
                      </span>
                      {sidebarModelSigns.map((s) => (
                        <span
                          key={s}
                          className={
                            'shrink-0 rounded-[var(--radius-xs)] border-[1.5px] px-1.5 py-0.5 font-mono text-[7.5px] font-bold uppercase ' +
                            (s === 'AUDIO'
                              ? 'border-[color:var(--color-accent2)] text-[color:var(--color-accent2)]'
                              : s === 'REF'
                                ? 'border-[color:var(--color-accent)] text-[color:var(--color-accent)]'
                                : 'border-[color:var(--color-line)]/40 text-[color:var(--color-muted-foreground)]')
                          }
                        >
                          {s}
                        </span>
                      ))}
                    </span>
                  </span>
                  <PixelGlyph
                    name="catalog"
                    size={13}
                    className="shrink-0 text-[color:var(--color-faint)]"
                  />
                </button>

                {/* Effect row — only video has a motion/camera/effect catalog. */}
                {isVideo && (
                  <button
                    type="button"
                    data-testid="effect-trigger"
                    aria-haspopup="menu"
                    aria-expanded={pickerOpen && pickerView === 'effect'}
                    onClick={() => {
                      setPickerView('effect');
                      setPickerOpen(true);
                      setPane('preview');
                    }}
                    className={
                      'press-inset flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-3 py-2.5 text-left transition-colors ' +
                      (pickerOpen && pickerView === 'effect'
                        ? 'bg-[rgba(var(--accent-rgb),0.12)]'
                        : 'bg-[color:var(--color-surface2)] hover:bg-[color:var(--color-surface)]')
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-xs)] bg-[color:var(--color-surface)] text-[color:var(--color-faint)]"
                        style={
                          selectedEffect
                            ? { background: cardVisual(selectedEffect.slug).background }
                            : undefined
                        }
                      >
                        {selectedEffect ? (
                          selectedEffect.samplePreviewUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={assetSrc(selectedEffect.samplePreviewUrl)}
                              alt=""
                              className="h-full w-full object-cover"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                          )
                        ) : (
                          <PixelGlyph name="effect" size={13} />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-faint)]">
                          Эффект
                        </span>
                        <span className="truncate text-[13px] font-semibold text-[color:var(--color-fg)]">
                          {selectedEffect?.title ?? 'Без эффекта'}
                        </span>
                      </span>
                    </span>
                    <PixelGlyph
                      name="catalog"
                      size={13}
                      className="shrink-0 text-[color:var(--color-faint)]"
                    />
                  </button>
                )}
              </div>

              {/* Video: references / source frames sit ABOVE the prompt — set the
                shot first, then describe the motion (owner). */}
              {isVideo && referenceInputs}

              {/* Prompt — the hero input; flex-1 + fill mode so it absorbs ALL the
                dock's slack and the column always fits one screen (no scroll). No
                eyebrow: the placeholder already says what to do. */}
              <div
                data-testid="prompt-block"
                data-tour-target="prompt"
                className="flex min-h-0 flex-1 flex-col"
              >
                <div className="flex min-h-0 flex-1 flex-col rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)]">
                  <PromptEditor
                    value={prompt}
                    onChange={(t) => {
                      setPrompt(t);
                      setAppliedEnhancement(null);
                      setPresetApplied(false);
                      if (!appliedPreset) {
                        setAppliedPresetSlug(null);
                        presetAppliedRef.current = false;
                      }
                    }}
                    images={imageUrls}
                    videos={videoUrls}
                    audios={audioUrls}
                    placeholder={
                      isVideo
                        ? 'Опиши сцену: объект, движение камеры, действие…'
                        : 'Опиши, что нарисовать…'
                    }
                    fill
                  />
                  <div className="flex items-center justify-between gap-2 border-t-[1.5px] border-[color:var(--color-line)]/20 px-3 py-1.5">
                    {/* status / hint share the slot — saves a row vs. an eyebrow */}
                    <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-[color:var(--color-faint)]">
                      {appliedPreset ? (
                        <span
                          data-testid="applied-preset-chip"
                          className="flex min-w-0 items-center gap-1"
                        >
                          <span className="truncate text-[color:var(--color-positive)]">
                            {presetKindLabel(appliedPreset.category)}: {appliedPreset.title}
                          </span>
                          <button
                            type="button"
                            aria-label="Убрать пресет"
                            onClick={clearAppliedPreset}
                            className="press-inset shrink-0 text-[color:var(--color-faint)] transition-colors hover:text-[color:var(--color-fg)]"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ) : presetApplied ? (
                        <span className="text-[color:var(--color-positive)]">сцена применена</span>
                      ) : (
                        <>
                          <kbd className="rounded-[var(--radius-xs)] border-[1.5px] border-[color:var(--color-line)]/40 px-1 font-mono">
                            @
                          </kbd>
                          референс
                        </>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2.5">
                      {prompt.length > 0 && (
                        <button
                          type="button"
                          data-testid="prompt-clear"
                          aria-label="Очистить промпт"
                          onClick={() => {
                            setPrompt('');
                            setAppliedEnhancement(null);
                            setPresetApplied(false);
                            if (!appliedPreset) {
                              setAppliedPresetSlug(null);
                              presetAppliedRef.current = false;
                            }
                          }}
                          className="press-inset inline-flex items-center gap-1 text-[11px] text-[color:var(--color-faint)] transition-colors hover:text-[color:var(--color-fg)]"
                        >
                          <X size={12} /> очистить
                        </button>
                      )}
                      <span className="tnum text-[11px] text-[color:var(--color-faint)]">
                        {prompt.length} / 8000
                      </span>
                    </span>
                  </div>
                </div>
              </div>

              {/* Slot apply-sheet — multi-slot slots-mode presets expose their
                {key} fills here. Single-slot presets need none: the textarea
                drops straight into that slot (mergePresetPrompt convenience). */}
              {appliedPreset &&
                (appliedPreset.mergeMode ?? 'replace') === 'slots' &&
                (appliedPreset.slots?.length ?? 0) > 1 && (
                  <div
                    data-testid="preset-slot-sheet"
                    className="flex shrink-0 flex-col gap-2 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-3"
                  >
                    {(appliedPreset.slots ?? []).map((s) => (
                      <label key={s.key} className="flex flex-col gap-1">
                        <span className="text-[11px] text-[color:var(--color-faint)]">
                          {s.label}
                          {s.required ? ' *' : ''}
                        </span>
                        <input
                          type="text"
                          data-testid={`preset-slot-${s.key}`}
                          value={slotValues[s.key] ?? ''}
                          placeholder={s.placeholder ?? ''}
                          onChange={(e) =>
                            setSlotValues((prev) => ({ ...prev, [s.key]: e.target.value }))
                          }
                          className="w-full rounded-[var(--radius-xs)] border-[1.5px] border-[color:var(--color-line)]/30 bg-[color:var(--color-surface)] px-2 py-1.5 text-[13px] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
                        />
                      </label>
                    ))}
                  </div>
                )}

              {/* Settings — icon+value wells, no name labels (owner). Tidy grid so
                they fill the dock width with even spacing. */}
              {isVideo ? (
                <div className="grid shrink-0 grid-cols-3 gap-2">
                  {/* Duration */}
                  <PillControl
                    icon={<Clock size={15} />}
                    label="Длина"
                    value={durationAuto ? 'авто' : `${clampedDuration}с`}
                    width="w-[18rem]"
                  >
                    {() => (
                      <div>
                        <div className="mb-2.5 flex items-center justify-between">
                          <span className="font-mono text-[13px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-muted-foreground)]">
                            Длительность
                          </span>
                          {/* «Авто» toggle removed: the API rejects duration -1
                            (billing needs an explicit duration upfront), so the
                            toggle could never succeed. Restore when post-hoc
                            billing for provider-chosen durations is built. */}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="tnum w-8 text-center text-[13px] font-semibold text-[color:var(--color-fg)]">
                            {durationAuto ? '—' : `${clampedDuration}с`}
                          </span>
                          <input
                            data-testid="duration-range"
                            type="range"
                            min={minDur}
                            max={Math.max(minDur, maxDur)}
                            step={1}
                            value={clampedDuration}
                            disabled={durationAuto}
                            onChange={(e) => setDuration(Number(e.target.value))}
                            style={
                              {
                                ['--pct']: `${(Math.max(minDur, maxDur) > minDur ? ((clampedDuration - minDur) / (Math.max(minDur, maxDur) - minDur)) * 100 : 0).toFixed(1)}%`,
                              } as React.CSSProperties
                            }
                            className={'seed-range flex-1 ' + (durationAuto ? 'opacity-40' : '')}
                          />
                        </div>
                        <div className="mt-1 flex justify-between px-9 text-[11px] text-[color:var(--color-faint)]">
                          <span className="tnum">{minDur}с</span>
                          <span className="tnum">{Math.max(minDur, maxDur)}с</span>
                        </div>
                      </div>
                    )}
                  </PillControl>

                  {/* Aspect ratio */}
                  <PillControl
                    icon={<RectangleHorizontal size={15} />}
                    label="Формат"
                    value={effectiveAspect === 'adaptive' ? 'авто' : effectiveAspect}
                    width="w-[16rem]"
                  >
                    {(close) => (
                      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                        {aspectOptions.map((a) => {
                          const selected = effectiveAspect === a;
                          const ic = VASPECT_ICON[a];
                          return (
                            <button
                              key={a}
                              type="button"
                              onClick={() => {
                                setVAspect(a);
                                close();
                              }}
                              data-selected={selected}
                              aria-pressed={selected}
                              className={
                                'opt flex flex-col items-center gap-1.5 py-2.5 text-[13px] font-semibold ' +
                                (selected
                                  ? ''
                                  : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                              }
                            >
                              <span
                                className={
                                  'block rounded-[var(--radius-xs)] border-2 ' +
                                  (selected
                                    ? 'border-[color:var(--color-primary-foreground)]'
                                    : 'border-[color:var(--color-line)]')
                                }
                                style={{ width: ic.w, height: ic.h }}
                              />
                              {a === 'adaptive' ? 'авто' : a}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </PillControl>

                  {/* Quality */}
                  <PillControl
                    icon={<MonitorPlay size={15} />}
                    label="Качество"
                    value={effectiveResolution}
                    width="w-[15rem]"
                  >
                    {(close) => (
                      <div className="space-y-0.5">
                        <div className="mb-1 px-1">
                          <span className="font-mono text-[13px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-muted-foreground)]">
                            Разрешение
                          </span>
                        </div>
                        {resolutionOptions.map((r) => {
                          const selected = effectiveResolution === r;
                          return (
                            <button
                              key={r}
                              type="button"
                              data-testid={`res-${r}`}
                              aria-pressed={selected}
                              onClick={() => {
                                setResolution({ modelId, resolution: r });
                                close();
                              }}
                              className={
                                'press-inset flex w-full items-center justify-between rounded-[var(--radius-sm)] border-2 px-2.5 py-2 text-[13px] transition-colors ' +
                                (selected
                                  ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                                  : 'border-transparent text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]')
                              }
                            >
                              <span className="font-medium">{r}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </PillControl>

                  {/* Takes — N параллельных дублей одного промпта (multi-take):
                    each is an independent job; cost shown is per-take × N. */}
                  <div
                    title="Дубли"
                    className="flex h-9 items-center justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] px-1"
                  >
                    <button
                      type="button"
                      aria-label="Меньше дублей"
                      data-testid="takes-dec"
                      onClick={() => setCount((c) => Math.max(1, c - 1))}
                      disabled={count <= 1}
                      className="press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)] disabled:opacity-30"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="tnum text-[13px] font-semibold text-[color:var(--color-fg)]">
                      ×{count}
                    </span>
                    <button
                      type="button"
                      aria-label="Больше дублей"
                      data-testid="takes-inc"
                      onClick={() => setCount((c) => Math.min(4, c + 1))}
                      disabled={count >= 4}
                      className="press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)] disabled:opacity-30"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid shrink-0 grid-cols-3 gap-2">
                  {/* Size */}
                  <PillControl
                    icon={<Crop size={15} />}
                    label="Размер"
                    value={sizePx}
                    width="w-[16rem]"
                  >
                    {(close) => (
                      <div
                        data-testid="size-select"
                        className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
                      >
                        {sizes.map((s) => {
                          const selected = s.id === size;
                          return (
                            <button
                              key={s.id}
                              type="button"
                              title={s.label}
                              onClick={() => {
                                setSize(s.id);
                                close();
                              }}
                              data-selected={selected}
                              aria-pressed={selected}
                              className="opt flex flex-col items-center gap-1 py-2.5"
                            >
                              <span
                                className={
                                  'tnum text-[13px] font-semibold ' +
                                  (selected
                                    ? 'text-[color:var(--color-primary-foreground)]'
                                    : 'text-[color:var(--color-muted-foreground)]')
                                }
                              >
                                {s.id}
                              </span>
                              <span
                                className={
                                  'text-[11px] ' +
                                  (selected
                                    ? 'text-[color:var(--color-primary-foreground)]'
                                    : 'text-[color:var(--color-faint)]')
                                }
                              >
                                {s.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </PillControl>

                  {imageQualityOptions.length > 0 && (
                    <PillControl
                      icon={<MonitorPlay size={15} />}
                      label="Качество"
                      value={boardImageQualityLabel(imageQuality ?? imageQualityOptions[0] ?? '')}
                      width="w-[15rem]"
                    >
                      {(close) => (
                        <div className="space-y-0.5" data-testid="image-quality-select">
                          <div className="mb-1 px-1 font-mono text-[13px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-muted-foreground)]">
                            Качество
                          </div>
                          {imageQualityOptions.map((quality) => {
                            const selected = imageQuality === quality;
                            return (
                              <button
                                key={quality}
                                type="button"
                                data-testid={`image-quality-${quality}`}
                                aria-pressed={selected}
                                onClick={() => {
                                  setSelectedImageQuality({ modelId, quality });
                                  close();
                                }}
                                className={
                                  'press-inset flex w-full items-center justify-between rounded-[var(--radius-sm)] border-2 px-2.5 py-2 text-[13px] font-medium transition-colors ' +
                                  (selected
                                    ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                                    : 'border-transparent text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]')
                                }
                              >
                                {boardImageQualityLabel(quality)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </PillControl>
                  )}

                  {/* Count — inline −/+ stepper (owner: «realised inside the box»). */}
                  <div
                    title="Количество"
                    className="flex h-9 items-center justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] px-1"
                  >
                    <button
                      type="button"
                      aria-label="Меньше"
                      data-testid="count-dec"
                      onClick={() => setCount((c) => Math.max(1, c - 1))}
                      disabled={count <= 1}
                      className="press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)] disabled:opacity-30"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="tnum text-[13px] font-semibold text-[color:var(--color-fg)]">
                      ×{count}
                    </span>
                    <button
                      type="button"
                      aria-label="Больше"
                      data-testid="count-inc"
                      onClick={() => setCount((c) => Math.min(4, c + 1))}
                      disabled={count >= 4}
                      className="press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)] disabled:opacity-30"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  {/* Seed is API-only now — removed from the UI (Метро-док, D16). */}
                </div>
              )}

              {/* Reference inputs — image mode shows them here, BELOW the prompt
                (video renders them above, before the prompt). */}
              {!isVideo && referenceInputs}
            </div>
            {/* Action dock — pinned at the bottom of the calm dock panel, split
              from the controls by a dim hairline; «Создать» is the one CTA.
              Fixed-float only on phones (above the tab bar); on sm+ it stays
              in normal flow directly under the controls so a short dock leaves
              no dead gap before the CTA (M2). */}
            <div
              data-testid="action-dock"
              className="shrink-0 space-y-2.5 border-t-[1.5px] border-[color:var(--color-line)]/20 pt-3.5 max-sm:fixed max-sm:inset-x-4 max-sm:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] max-sm:z-20 max-sm:rounded-[var(--radius-md)] max-sm:border-[2.5px] max-sm:border-[color:var(--color-line)] max-sm:bg-[color:var(--color-surface)] max-sm:p-3 max-sm:shadow-[4px_4px_0_0_var(--color-shadow)]"
            >
              {/* Draft + Audio toggles (video) — neutral chips in one row. Audio is
                per-model: interactive on audio-capable models (Seedance 2.0 + its
                reference variant), shown disabled+off for models without audio
                (the fast draft variants) so the state is always visible. */}
              {isVideo && (
                <div className="flex flex-wrap items-center gap-2">
                  {draftVideoModel && (
                    <button
                      type="button"
                      onClick={toggleDraft}
                      aria-pressed={draft}
                      data-testid="draft-toggle"
                      title="Черновик — дешёвый быстрый просмотр (быстрая модель, 480p)"
                      className={
                        'press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] px-3.5 text-[13px] font-medium transition-colors ' +
                        (draft
                          ? 'selected-neutral'
                          : 'bg-[color:var(--color-surface2)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]')
                      }
                    >
                      <Zap size={14} />
                      Черновик
                      {draft && (
                        <span className="tnum text-[11px] text-[color:var(--color-bg)] opacity-70">
                          480p · быстро
                        </span>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setGenAudio((v) => !v)}
                    disabled={!audioCapable}
                    aria-pressed={audioCapable && genAudio}
                    data-testid="audio-toggle"
                    title={
                      audioCapable
                        ? 'Звук — генерировать аудиодорожку (вкл/выкл)'
                        : 'Выбранная модель не поддерживает звук'
                    }
                    className={
                      'press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] px-3.5 text-[13px] font-medium transition-colors ' +
                      (!audioCapable
                        ? 'cursor-not-allowed bg-[color:var(--color-surface2)] text-[color:var(--color-faint)] opacity-60'
                        : genAudio
                          ? 'selected-neutral'
                          : 'bg-[color:var(--color-surface2)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]')
                    }
                  >
                    {audioCapable && genAudio ? (
                      <SpeakerHigh size={14} />
                    ) : (
                      <SpeakerSlash size={14} />
                    )}
                    Звук
                  </button>
                </div>
              )}
              {!projectContextReady && (
                <p
                  className="font-mono text-[11px] text-[color:var(--color-danger)]"
                  role="alert"
                  data-testid="project-context-submit-blocked"
                >
                  {projectContext.mode === 'loading'
                    ? 'Проверяем проект перед запуском…'
                    : 'Генерация остановлена: контекст проекта недоступен.'}
                </p>
              )}
              {priceRefusal && (
                // The server declined to quote this configuration. Say so plainly
                // instead of rendering the optimistic flat placeholder on a button
                // that would 400 — a wrong price is worse than no price.
                <p
                  className="font-mono text-[11px] text-[color:var(--color-danger)]"
                  role="alert"
                  data-testid="price-refused"
                  data-error-code={priceRefusal.code}
                >
                  {priceRefusal.message ?? 'Не удалось посчитать стоимость этой конфигурации.'}
                </p>
              )}
              {modelLocked ? (
                // P-B2: selected model is above the plan — route to upgrade.
                <Button
                  asChild
                  size="lg"
                  className="group h-12 w-full rounded-[var(--radius-md)] px-7 text-[15px]"
                >
                  <a href={lockedCtaHref} data-testid="upsell-cta">
                    <Lock size={16} />
                    <span>{lockedModelCtaLabel(model?.tierMin)}</span>
                    <ArrowRight
                      size={17}
                      className="transition-transform duration-150 group-hover:translate-x-0.5"
                    />
                  </a>
                </Button>
              ) : (
                <>
                  {/* Zero-balance nudge: the live balance already in state can't
                      cover this exact quote — say so next to the submit with a
                      refill path, instead of letting the press fail server-side.
                      No new endpoints: `balance` is the existing widget-synced
                      value, `cost` the settled quote for this configuration. */}
                  {!isAnonymous && cost !== null && balance < cost && (
                    <p
                      className="font-mono text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]"
                      data-testid="low-balance-hint"
                    >
                      Баланса не хватит ({balance} из {cost}) —{' '}
                      <a
                        href="/pricing"
                        className="text-[color:var(--color-accent)] underline decoration-2 underline-offset-2"
                      >
                        пополнить
                      </a>
                    </p>
                  )}
                  <Button
                    type="submit"
                    data-testid="submit"
                    data-tour-target="submit"
                    disabled={!canSubmit}
                    size="lg"
                    className="group h-12 w-full rounded-[var(--radius-md)] px-7 text-[15px]"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 size={18} className="seed-spin" /> Отправляем…
                      </>
                    ) : (
                      <>
                        <span>Создать{isVideo ? ' видео' : count > 1 ? ` (${count})` : ''}</span>
                        {/* cost chip — lime spark, matching step-03 */}
                        {/* While a fresh quote is in flight the outgoing number stays
                        put, greyed — blanking it on every parameter click reads as a
                        broken price. The button is disabled throughout (`canSubmit`
                        needs a settled quote), so the greyed figure can never be
                        acted on, and it is never treated as the current price. */}
                        <span
                          className="tnum inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-2 py-0.5 text-[11px] font-bold transition-opacity duration-150"
                          style={{
                            background: 'var(--color-accent2)',
                            color: 'var(--color-accent2-foreground)',
                            opacity: cost === null && recalculatingCost !== null ? 0.45 : 1,
                          }}
                        >
                          <TokenStar size={11} />
                          {cost ?? recalculatingCost ?? '—'}
                        </span>
                        <ArrowRight
                          size={17}
                          className="transition-transform duration-150 group-hover:translate-x-0.5"
                        />
                      </>
                    )}
                  </Button>
                </>
              )}
            </div>
          </form>
        </div>

        {/* ---------------- Preview (one panel) ---------------- */}
        <div
          className={
            'min-w-0 flex-col overflow-hidden rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] shadow-[6px_6px_0_0_var(--color-shadow)] lg:flex lg:min-h-0 ' +
            (pane === 'preview' ? 'flex' : 'hidden')
          }
          data-testid="result-area"
        >
          {pickerOpen ? (
            <ModelEffectPicker
              cards={isVideo ? videoCards : imageCards}
              currentModelId={modelId}
              canUseModel={canUseModel}
              onSelect={(m) => {
                selectModel(m.id);
              }}
              effects={isVideo ? motionPresets : []}
              selectedSlug={isVideo ? (selectedEffect?.slug ?? null) : null}
              onToggleEffect={toggleMotion}
              assetSrc={assetSrc}
              view={pickerView}
              onClose={() => setPickerOpen(false)}
            />
          ) : (
            <>
              <div className="flex shrink-0 items-center justify-between gap-3 border-b-[2.5px] border-[color:var(--color-line)] px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="label-eyebrow">Результат</span>
                  <StatusBadge kind={phase.kind} />
                </div>
                {/* The row is per-phase, NOT per-history: gating it on loaded
                    history would strip download/share/fullscreen from a first
                    result while the gallery fetch is still in flight. */}
                {phase.kind !== 'idle' && (
                  <div className="flex items-center gap-1">
                    {/* Way out of a single result → back to the inline «Твои
                        генерации» grid (phase=idle), the same view shown before
                        a tile was opened. NOT a navigation to /gallery («Архив»)
                        — staying in-place keeps the dock/state. mr-1 sets it
                        slightly apart from the per-asset actions. */}
                    <button
                      type="button"
                      data-testid="to-catalogue"
                      onClick={() => {
                        displayedJobRef.current = null;
                        setSelectedAsset(0);
                        setPhase({ kind: 'idle' });
                      }}
                      title="Твои генерации"
                      aria-label="Твои генерации"
                      className="press-inset mr-1 grid h-11 w-11 place-items-center rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
                    >
                      <SquaresFour size={15} weight="bold" />
                    </button>
                    {phase.kind === 'done' && doneAssets.length > 1 && !inGridView && (
                      <button
                        type="button"
                        data-testid="back-to-grid"
                        onClick={() => setSelectedAsset(null)}
                        className="press-inset mr-1 inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-3 text-[13px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]"
                      >
                        <Layers size={13} /> Все ({doneAssets.length})
                      </button>
                    )}
                    {phase.kind === 'done' && curAsset && !inGridView && (
                      <>
                        <button
                          type="button"
                          onClick={enterFullscreen}
                          title="На весь экран"
                          aria-label="На весь экран"
                          className="press-inset grid h-11 w-11 place-items-center rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
                        >
                          <Maximize2 size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void shareAsset(curAsset)}
                          title="Поделиться"
                          aria-label="Поделиться"
                          className="press-inset grid h-11 w-11 place-items-center rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
                        >
                          <Share2 size={15} />
                        </button>
                        <a
                          href={assetSrc(curAsset)}
                          download
                          title="Скачать"
                          aria-label="Скачать"
                          className="press-inset grid h-11 w-11 place-items-center rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
                        >
                          <Download size={15} />
                        </a>
                      </>
                    )}
                  </div>
                )}
              </div>
              {/* Fixed stage — never resizes; the frame letterboxes inside it */}
              <div
                ref={canvasRef}
                onDragOver={(e) => {
                  if (!isVideo) return;
                  e.preventDefault();
                  setStageDrag(true);
                }}
                onDragLeave={() => setStageDrag(false)}
                onDrop={(e) => void onStageDrop(e)}
                className={
                  'stage-grain relative flex min-h-[300px] flex-1 items-center justify-center overflow-hidden transition-colors [&>*:not(.stage-aurora)]:relative [&>*:not(.stage-aurora)]:z-10 ' +
                  (stageDrag
                    ? 'border-[color:var(--color-accent)]'
                    : 'border-[color:var(--color-line)]')
                }
              >
                <div className="stage-aurora" aria-hidden />
                {stageDrag && (
                  <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-[rgba(var(--accent-rgb),0.12)]">
                    <span className="rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[5px_5px_0_0_var(--color-shadow)]">
                      Отпусти — оживим этот кадр
                    </span>
                  </div>
                )}
                {/* Idle preview — the user's OWN past generations («Твои генерации»),
                or the 01·02·03 steps when there's no history yet. (The inserted
                reference is shown in the dock, not duplicated on the stage.) */}
                {phase.kind === 'idle' &&
                  (history.length > 0 || inflight.length > 0 ? (
                    <GenerationsGrid
                      items={
                        historyFilter === 'all'
                          ? history
                          : history.filter((h) => h.kind === historyFilter)
                      }
                      total={history.length}
                      inflight={inflight}
                      filter={historyFilter}
                      onFilterChange={setHistoryFilter}
                      onSelectInflight={(generation) => {
                        displayedJobRef.current = generation.jobId;
                        jobStartedRef.current = generation.startedAt;
                        jobDeadlineRef.current = renderDeadlineMs(
                          generation.etaSec * 1000,
                          generation.kind === 'video',
                        );
                        setElapsedSec(
                          Math.max(0, Math.floor((Date.now() - generation.startedAt) / 1000)),
                        );
                        setPhase({
                          kind: 'polling',
                          jobId: generation.jobId,
                          status: generation.status,
                        });
                      }}
                      onSelect={(it) => {
                        if (!it.assetUrl) return;
                        if (it.jobId) void showJobResult(it.jobId, it.assetUrl);
                        else {
                          displayedJobRef.current = null;
                          setPhase({
                            kind: 'unavailable',
                            message:
                              'У этого файла нет исходной генерации, поэтому его модель, промпт и параметры неизвестны.',
                          });
                        }
                      }}
                    />
                  ) : (
                    <GenerateSteps kind={mode} />
                  ))}

                {/* Generating — full-bleed recessed «screen» covering the whole body
                (only the panel header stays); scanline + stepped progress scale up. */}
                {isBusy && (
                  <div
                    data-testid="progress-placeholder"
                    role="status"
                    aria-live="polite"
                    className="brutal-scan absolute inset-0 z-10 flex flex-col items-center justify-center gap-8 overflow-hidden p-10 text-center"
                  >
                    <div className="flex items-center gap-3">
                      <span className="seed-pulse-dot h-4 w-4 rounded-full bg-[color:var(--color-accent)]" />
                      <span className="font-display text-[clamp(28px,5vw,48px)] font-black uppercase leading-none tracking-[-0.01em] text-[color:var(--color-fg)]">
                        {inflightStageLabel(
                          loadingStageKey,
                          displayedInflight?.kind ?? (isVideo ? 'video' : 'image'),
                        )}
                      </span>
                    </div>
                    {/* Full-width progress — transparent track (the preview area is the
                    only background; no card), accent blocks fill to --pct. */}
                    <div
                      className="seed-step-bar h-6 w-full max-w-[820px] border-[2.5px] border-[color:var(--color-line)]"
                      style={
                        {
                          ['--pct']: `${progressPct > 0 ? Math.max(6, progressPct) : 0}%`,
                        } as React.CSSProperties
                      }
                    />
                    <span className="tnum font-mono text-[16px] text-[color:var(--color-faint)]">
                      {fmtClock(elapsedSec)}
                      {elapsedSec < stageEtaSec
                        ? ` · обычно ${fmtEtaHint(stageEtaSec)}`
                        : ' · почти готово'}
                    </span>
                    {/* Cancel = stop watching and return to editing; the job keeps
                    running and lands in the tray/filmstrip when it finishes. */}
                    <button
                      type="button"
                      data-testid="cancel-generation"
                      onClick={reset}
                      title="Вернуться к редактированию — ролик до-генерируется в фоне"
                      className="press-inset inline-flex h-11 items-center gap-2 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-5 text-[13px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]"
                    >
                      <X size={16} /> Отменить
                    </button>
                  </div>
                )}

                {phase.kind === 'done' && inGridView && (
                  // Batch grid — every result visible at once; click to inspect.
                  <div
                    data-testid="result-grid"
                    className="seed-develop seed-scroll grid h-full w-full grid-cols-2 content-center gap-2.5 self-stretch overflow-y-auto p-3"
                  >
                    {doneAssets.map((url, i) => (
                      <button
                        key={url}
                        type="button"
                        data-testid="result-tile"
                        onClick={() => setSelectedAsset(i)}
                        title={`Результат ${i + 1}`}
                        className="press-inset group relative overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-black/30"
                      >
                        {isVideoAsset(url) ? (
                          <video
                            src={assetSrc(url)}
                            muted
                            playsInline
                            preload="metadata"
                            className="aspect-square h-full w-full object-cover"
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={assetSrc(url)}
                            alt={`Результат ${i + 1}`}
                            className="aspect-square h-full w-full object-cover"
                          />
                        )}
                        <span className="absolute left-2 top-2 rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)]">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {phase.kind === 'done' && !inGridView && curAsset && (
                  <div className="seed-develop flex h-full w-full items-center justify-center p-2.5">
                    {curIsVideo ? (
                      <video
                        src={assetSrc(curAsset)}
                        data-testid="result-video"
                        className="h-full w-full object-contain"
                        controls
                        autoPlay
                        loop
                        muted
                        playsInline
                        preload="metadata"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={assetSrc(curAsset)}
                        alt="Результат"
                        data-testid="result-image"
                        className="h-full w-full object-contain"
                      />
                    )}
                  </div>
                )}

                {phase.kind === 'failed' && (
                  <div className="w-full max-w-md p-4">
                    <FailedState
                      message={phase.message}
                      stillRunning={phase.stillRunning ?? false}
                      onRetry={reset}
                    />
                  </div>
                )}
                {phase.kind === 'unavailable' && (
                  <div className="w-full max-w-md p-4" data-testid="result-unavailable">
                    <UnavailableState message={phase.message} onReset={reset} />
                  </div>
                )}
                {phase.kind === 'insufficient' && (
                  <div className="w-full max-w-md p-4">
                    <InsufficientState balance={balance} cost={cost ?? 0} />
                  </div>
                )}
              </div>

              {/* Footer — shown post-render only (actions · metering · session ·
              models); hidden while idle so the steps / generations grid stay
              clean, matching the approved Layout A. */}
              {phase.kind === 'done' && (
                <div className="shrink-0 space-y-2.5 border-t-[1.5px] border-[color:var(--color-line)]/20 px-4 py-3">
                  {workspaceProject && (
                    <p
                      className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[color:var(--color-positive)]"
                      data-testid="generate-project-receipt"
                    >
                      <span>Сохранено в проект «{workspaceProject.title}»</span>
                      <a
                        href={`/gallery?projectId=${encodeURIComponent(workspaceProject.id)}`}
                        className="underline decoration-2 underline-offset-2"
                      >
                        ПОКАЗАТЬ В ПРОЕКТЕ
                      </a>
                    </p>
                  )}
                  {!paidMediaStorage && phase.assets[0] && (
                    <p
                      className="flex flex-wrap items-center gap-1 font-mono text-[11px] text-[color:var(--color-accent)]"
                      data-testid="retention-reminder"
                    >
                      <span>{FREE_MEDIA_RETENTION_COPY.split(' · ')[0]} · </span>
                      <a
                        href={assetSrc(phase.assets[0])}
                        download
                        className="underline decoration-2 underline-offset-2"
                      >
                        {FREE_MEDIA_RETENTION_COPY.split(' · ')[1]}
                      </a>
                      <span> · </span>
                      <a href="/pricing" className="underline decoration-2 underline-offset-2">
                        {FREE_MEDIA_RETENTION_COPY.split(' · ')[2]}
                      </a>
                    </p>
                  )}
                  {/* Per-result actions — the iteration loop. Visible in single view. */}
                  {phase.kind === 'done' && curAsset && !inGridView && (
                    <div className="flex flex-wrap items-center gap-2" data-testid="result-actions">
                      {!curIsVideo && (
                        <button
                          type="button"
                          data-testid="action-animate"
                          onClick={() => animateImage(curAsset)}
                          className="press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3.5 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors"
                        >
                          <Clapperboard size={14} /> Оживить
                        </button>
                      )}
                      {curIsVideo && lastFrameAsset && (
                        <button
                          type="button"
                          data-testid="action-extend"
                          onClick={() => extendVideo(lastFrameAsset)}
                          className="press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3.5 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors"
                        >
                          <Clapperboard size={14} /> Продолжить видео
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid="action-vary"
                        onClick={vary}
                        // «Вариации» submits the CURRENT form with a new seed, so it
                        // needs the same settled quote «Создать» does — otherwise it
                        // is the one result action that can ask for a generation whose
                        // price is not on screen. The submit refuses either way; this
                        // keeps the button from promising something it cannot do.
                        disabled={
                          isSubmitting || !projectContextReady || !hasKnownJobEstimate(estimate)
                        }
                        className="press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-3.5 text-[13px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)] disabled:opacity-50"
                      >
                        <RefreshCw size={14} /> Вариации
                      </button>
                      <button
                        type="button"
                        data-testid="action-repeat"
                        onClick={repeat}
                        disabled={isSubmitting || repeatValidation || !projectContextReady}
                        className="press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-3.5 text-[13px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)] disabled:opacity-50"
                      >
                        <Repeat size={14} /> Повторить
                        <span
                          className="tnum inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-2 py-0.5 text-[11px] font-bold"
                          style={{
                            background: 'var(--color-accent2)',
                            color: 'var(--color-accent2-foreground)',
                          }}
                        >
                          <TokenStar size={11} />
                          {repeatCost ?? '—'}
                        </span>
                      </button>
                      {curIsVideo && (
                        <button
                          type="button"
                          data-testid="action-studio"
                          onClick={() => void sendToStudio(curAsset)}
                          disabled={handingOff}
                          className="press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-3.5 text-[13px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)] disabled:opacity-50"
                        >
                          {handingOff ? (
                            <Loader2 size={14} className="seed-spin" />
                          ) : (
                            <Scissors size={14} />
                          )}{' '}
                          В Studio
                        </button>
                      )}
                      {curIsVideo && referenceVideoModel && (
                        <button
                          type="button"
                          data-testid="action-video-reference"
                          onClick={() => addVideoReference(curAsset)}
                          className="press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-3.5 text-[13px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]"
                        >
                          <AtSign size={14} /> В референсы
                        </button>
                      )}
                      {!curIsVideo && editModelAvailable && (
                        <button
                          type="button"
                          data-testid="action-edit"
                          onClick={() => editImage(curAsset)}
                          className="press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-3.5 text-[13px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]"
                        >
                          <Pencil size={14} /> Редактировать
                        </button>
                      )}
                      {!curIsVideo && (
                        <button
                          type="button"
                          data-testid="action-reference"
                          onClick={() => addReference(curAsset)}
                          className="press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-3.5 text-[13px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]"
                        >
                          <AtSign size={14} /> В референсы
                        </button>
                      )}
                    </div>
                  )}
                  {phase.kind === 'done' && phase.assets[0] && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[color:var(--color-faint)]">
                      <span className="font-medium text-[color:var(--color-muted-foreground)]">
                        {resultModelLabel}
                      </span>
                      <span>·</span>
                      <span className="tnum">{resultDetails || 'Параметры не сохранены'}</span>
                      <button
                        type="button"
                        onClick={reset}
                        className="ml-auto inline-flex items-center gap-1.5 font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-fg)]"
                      >
                        <Plus size={14} /> Создать ещё
                      </button>
                      <Link
                        href="/studio"
                        className="ml-2 inline-flex items-center gap-1.5 font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-accent)]"
                      >
                        <Scissors size={14} /> В студию
                      </Link>
                    </div>
                  )}
                  {resultPrompt && (
                    <p
                      data-testid="result-prompt"
                      className="break-words text-[13px] leading-relaxed text-[color:var(--color-faint)]"
                    >
                      {resultPrompt}
                    </p>
                  )}
                  <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-[color:var(--color-faint)]">
                    <Info size={13} className="mt-0.5 shrink-0" />
                    <span>
                      Стоимость подтверждается перед запуском
                      {resultAudio !== null
                        ? ` · звук ${resultAudio ? 'включён' : 'выключен'}`
                        : ''}
                      .
                    </span>
                  </p>
                  {/* F-m8: session filmstrip — past outputs stay one tap away. */}
                  {sessionResults.length > 1 && (
                    <div className="seed-scroll flex items-center gap-2 overflow-x-auto pb-1">
                      <span className="label-eyebrow shrink-0">Сессия</span>
                      {sessionResults.map((r, i) => {
                        const active = phase.kind === 'done' && phase.assets[0] === r.url;
                        return (
                          <button
                            key={`${r.url}-${i}`}
                            type="button"
                            data-testid="session-thumb"
                            onClick={() => {
                              displayedJobRef.current = null;
                              setSelectedAsset(0);
                              setPhase({
                                kind: 'done',
                                jobId: r.jobId,
                                assets: [r.url],
                                ...(r.modelId ? { modelId: r.modelId } : {}),
                                ...(r.model ? { model: r.model } : {}),
                                ...(r.params ? { params: r.params } : {}),
                                ...(typeof r.creditsReserved === 'number'
                                  ? { creditsReserved: r.creditsReserved }
                                  : {}),
                              });
                            }}
                            title={r.label}
                            className={
                              'relative h-12 w-12 shrink-0 overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] transition-colors ' +
                              (active
                                ? 'border-[color:var(--color-accent)] shadow-[3px_3px_0_0_var(--color-shadow)]'
                                : 'border-[color:var(--color-line)]')
                            }
                          >
                            {r.isVideo ? (
                              <video
                                src={assetSrc(r.url)}
                                muted
                                playsInline
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={assetSrc(r.url)}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {models.length > 1 && (
                    <div className="seed-scroll flex items-center gap-2 overflow-x-auto pb-1">
                      <span className="label-eyebrow shrink-0">Ещё</span>
                      {models
                        // P-B2: don't offer one-tap switches to out-of-plan models.
                        .filter((m) => m.id !== modelId && canUseModel(m))
                        .slice(0, 6)
                        .map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => selectModel(m.id)}
                            className="press-inset shrink-0 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-3 py-1.5 text-[13px] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]"
                          >
                            {cardName(m)}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
