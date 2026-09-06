import { EvolinkClient } from './evolink-client';
import {
  ProviderError,
  workflowFrameImages,
  workflowImageControls,
  type GenerationAsset,
  type GenerationHandle,
  type GenerationResult,
  type ProviderAdapter,
  type WorkflowSpec,
} from './types';
import { extensionFromContentType, urlArr } from './adapter-helpers';

const POLL_CEILING_MS = 300_000; // videos can run a few minutes
const POLL_BACKOFF_MS = [2_000, 3_000, 5_000, 8_000, 12_000] as const;

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Submit path is derived from the model kind — Evolink ignores the per-model
 * provider endpoint suffix and routes purely by /images vs /videos. */
function submitPath(kind: string): string {
  if (kind === 'video') return '/videos/generations';
  return '/images/generations';
}

const SEEDREAM_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Normalise an image size to Evolink's ratio+quality form. Pixel sizes have a
 * narrow valid band ([2560x1440 .. 3072x3072]) that differs per Seedream
 * version, so we always emit ratio+quality, which every version accepts. */
function imageSizeToRatio(size: string): string {
  if (SEEDREAM_RATIOS.includes(size)) return size;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return '1:1';
  const w = Number(m[1]);
  const h = Number(m[2]);
  const g = gcd(w, h) || 1;
  const ratio = `${w / g}:${h / g}`;
  return SEEDREAM_RATIOS.includes(ratio) ? ratio : '1:1';
}

const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];

/** Read a string[] from params (or fall back to spec.referenceAssets). */
/** Build the Evolink request body for the model kind + mode. The mode is
 * inferred from the provider model id (…-text-to-video / -image-to-video /
 * -reference-to-video). Reference media travels in params: imageUrls,
 * videoUrls, audioUrls (string[]); webSearch (boolean) toggles the tool. */
// Exported for unit testing the wire-body shape (esp. optional passthrough keys).
export function buildBody(spec: WorkflowSpec): Record<string, unknown> {
  const p = spec.params;
  const id = spec.providerModelId;
  const webSearch = p['webSearch'] === true;
  // Reference media: prefer typed params arrays, fall back to referenceAssets.
  const imageUrls = urlArr(p, 'imageUrls').length
    ? urlArr(p, 'imageUrls')
    : spec.referenceAssets.filter((u) => !/\.(mp4|mov|webm)(\?|$)/i.test(u));
  const videoUrls = urlArr(p, 'videoUrls');
  const audioUrls = urlArr(p, 'audioUrls');
  const frameImages = workflowFrameImages(spec);

  if (spec.kind === 'video') {
    const maxDur = spec.maxDurationSeconds ?? 10;
    // duration_seconds === -1 → let the model pick (Seedance "auto"). Otherwise clamp 4..15.
    const rawDur = asNum(p['duration_seconds'], 5);
    const duration = rawDur === -1 ? -1 : Math.max(4, Math.min(Math.round(rawDur), maxDur, 15));
    // Keep parsing legacy provider values, but SR is not an offered capability;
    // a backend-supported product belongs to QE-1. Plain 1080p is unavailable on fast models.
    let quality = asStr(p['resolution'], '720p');
    const isFast = /fast/i.test(id);
    if (isFast && quality === '1080p') quality = '720p';
    let aspect = asStr(p['aspect_ratio'], '16:9');
    if (!VIDEO_RATIOS.includes(aspect)) aspect = '16:9';
    // Mode follows the INPUT, not just the catalog row: attaching frames to a
    // text-to-video model upgrades it to its image-to-video sibling (the
    // «Оживить» flow — same model family, frame attached → i2v).
    const isReference = /reference-to-video/i.test(id);
    const wantsI2v = !isReference && (frameImages.length > 0 || imageUrls.length > 0);
    let videoModelId = id;
    if (wantsI2v && /text-to-video/i.test(id)) {
      videoModelId = id.replace(/text-to-video/i, 'image-to-video');
    }
    const body: Record<string, unknown> = {
      model: videoModelId,
      prompt: spec.prompt,
      duration,
      quality,
      aspect_ratio: aspect,
      generate_audio: p['generate_audio'] !== false,
    };
    // Optional Seedance flags — forwarded only when set. If the gateway rejects
    // an unknown key it does so pre-charge (free); the consolidated probe confirms.
    if (p['watermark'] === true) body['watermark'] = true;
    if (p['return_last_frame'] === true) body['return_last_frame'] = true;
    if (typeof p['seed'] === 'number') body['seed'] = p['seed'];
    if (isReference) {
      if (imageUrls.length) body['image_urls'] = imageUrls.slice(0, 9);
      if (videoUrls.length) body['video_urls'] = videoUrls.slice(0, 3);
      if (audioUrls.length) body['audio_urls'] = audioUrls.slice(0, 3);
    } else if (wantsI2v || /image-to-video/i.test(videoModelId)) {
      body['image_urls'] =
        frameImages.length > 0
          ? frameImages
              .toSorted((left, right) =>
                left.role === 'first' ? -1 : right.role === 'first' ? 1 : 0,
              )
              .map((frame) => frame.url)
          : imageUrls.slice(0, 2); // legacy first/last order
    } else if (webSearch) {
      // text-to-video supports web_search via model_params
      body['model_params'] = { tools: [{ type: 'web_search' }] };
    }
    return body;
  }

  // image / image-edit — always ratio + quality (robust across Seedream versions).
  const imageControls = workflowImageControls(spec);
  const body: Record<string, unknown> = {
    model: id,
    prompt: spec.prompt,
    size: imageSizeToRatio(imageControls.aspectRatio ?? asStr(p['size'], '1:1')),
    quality: imageControls.resolution ?? '2K',
    n: Math.max(1, Math.min(imageControls.count, 15)),
  };
  if (typeof p['seed'] === 'number') body['seed'] = p['seed'];
  // Forwarded only when set (Seedream diffusion honours it; unknown keys are
  // rejected pre-charge on engines that don't). Cinema/style presets supply it.
  if (typeof p['negative_prompt'] === 'string' && p['negative_prompt'].trim()) {
    body['negative_prompt'] = p['negative_prompt'].trim();
  }
  if (imageUrls.length) body['image_urls'] = imageUrls.slice(0, 14);
  if (webSearch) body['model_params'] = { tools: [{ type: 'web_search' }] };
  return body;
}

/**
 * Evolink.ai adapter. Both image and video are async: submit returns a task id,
 * then we poll /tasks/{id} until terminal. No inline image result — the worker
 * always calls awaitResult().
 */
export class EvolinkAdapter implements ProviderAdapter {
  constructor(private readonly client: EvolinkClient) {}

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind === 'voice') throw new Error(`unsupported kind: ${spec.kind}`);
    const task = await this.client.submit(submitPath(spec.kind), buildBody(spec));
    if (!task.id) {
      throw new ProviderError({
        code: 'NO_TASK_ID',
        status: 200,
        retryable: true,
        message: `submit returned no task id (status=${task.status})`,
      });
    }
    return { providerJobId: task.id, gateway: 'evolink' };
  }

  async awaitResult(handle: GenerationHandle, _spec: WorkflowSpec): Promise<GenerationResult> {
    const started = Date.now();
    let attempt = 0;
    // Video tasks poll for minutes; Evolink's /tasks endpoint occasionally
    // stalls past our per-request timeout. A single transient poll error must
    // NOT fail the whole job — tolerate a run of consecutive errors and keep
    // polling until the ceiling. Only a real `failed` status or the ceiling
    // ends the job.
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 6;
    while (Date.now() - started < POLL_CEILING_MS) {
      const wait = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)]!;
      await new Promise((r) => setTimeout(r, wait));
      attempt += 1;

      let task: Awaited<ReturnType<typeof this.client.getTask>>;
      try {
        task = await this.client.getTask(handle.providerJobId);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new ProviderError({
            code: 'POLL_UNREACHABLE',
            status: 503,
            retryable: true,
            message: `task ${handle.providerJobId}: ${consecutiveErrors} consecutive poll errors; last: ${(err as Error).message}`,
          });
        }
        continue; // transient — keep polling
      }

      if (task.status === 'completed') {
        const urls = (task.result_data?.map((d) => d.url) ?? task.results ?? []).filter(
          (u): u is string => typeof u === 'string' && u.length > 0,
        );
        if (urls.length === 0) {
          throw new ProviderError({
            code: 'NO_ASSET',
            status: 200,
            retryable: false,
            message: 'task completed with no result url',
          });
        }
        const assets = await Promise.all(
          urls.map(async (url): Promise<GenerationAsset> => {
            const fetched = await this.client.fetchAsset(url);
            return {
              bytes: fetched.bytes,
              contentType: fetched.contentType,
              extension: extensionFromContentType(fetched.contentType),
            };
          }),
        );
        return { assets };
      }

      if (task.status === 'failed') {
        const msg =
          typeof task.error === 'string'
            ? task.error
            : (task.error?.message ?? 'task failed without message');
        const code =
          typeof task.error === 'object' && task.error?.code ? task.error.code : 'PROVIDER_FAILED';
        throw new ProviderError({ code, status: 200, retryable: false, message: msg });
      }
      // pending | processing → keep polling
    }
    throw new ProviderError({
      code: 'TIMEOUT',
      status: 408,
      retryable: false,
      message: `task ${handle.providerJobId} did not finish within ${POLL_CEILING_MS}ms`,
    });
  }
}
