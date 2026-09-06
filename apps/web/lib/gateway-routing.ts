/**
 * Per-shot gateway selection for the previz reference path (previz S1).
 *
 * OpenRouter (the PRIMARY gateway) serializes reference-to-video with IMAGE
 * references only — its wire body has no field for video or audio refs, so
 * they would silently vanish. AtlasCloud is the only gateway whose
 * reference-to-video accepts reference_videos/reference_audios. Any shot
 * carrying a video or audio reference must therefore send `provider:'atlascloud'`
 * on POST /v1/jobs. Returning undefined leaves routing to the model's own pins.
 */

/** Wire caps of the seedance reference-to-video body (both gateways ≤9
 * stills; AtlasCloud ≤3 videos / ≤3 audios). */
export const REFERENCE_CAPS = { images: 9, videos: 3, audios: 3 } as const;

export interface ShotRefs {
  videoUrls?: string[] | undefined;
  audioUrls?: string[] | undefined;
}

function hasUrl(arr: string[] | undefined): boolean {
  return Array.isArray(arr) && arr.some((u) => typeof u === 'string' && u.length > 0);
}

/** 'atlascloud' when the shot carries motion/audio refs, else undefined
 * (= let the server route by the model's pinned primary/fallback). */
export function providerForShot(refs: ShotRefs): 'atlascloud' | undefined {
  return hasUrl(refs.videoUrls) || hasUrl(refs.audioUrls) ? 'atlascloud' : undefined;
}

/**
 * Operator gateway policy (temp dev widget on the board):
 * - `auto`   — video/audio ref → AtlasCloud (only gateway that carries it),
 *              everything else → OpenRouter (cheapest). The default.
 * - `openrouter` — force every shot to OpenRouter (cheapest; video refs are
 *              DROPPED — its body has no field for them).
 * - `atlascloud` — force every shot to AtlasCloud.
 */
export type GatewayPolicy = 'auto' | 'openrouter' | 'atlascloud';
export const GATEWAY_POLICIES: GatewayPolicy[] = ['auto', 'openrouter', 'atlascloud'];

/** Resolve the explicit `provider` to send on POST /v1/jobs for a shot under
 * a policy. Always explicit (the widget is authoritative), never undefined. */
export function resolveProvider(
  policy: GatewayPolicy,
  refs: ShotRefs,
): 'openrouter' | 'atlascloud' {
  if (policy === 'atlascloud') return 'atlascloud';
  if (policy === 'openrouter') return 'openrouter';
  // auto: motion/audio refs need AtlasCloud; otherwise the cheap primary.
  return hasUrl(refs.videoUrls) || hasUrl(refs.audioUrls) ? 'atlascloud' : 'openrouter';
}

/** True when the policy would send a shot WITH video/audio refs to OpenRouter,
 * silently dropping those refs (force-OpenRouter only — `auto` never does). */
export function willDropVideoRefs(policy: GatewayPolicy, refs: ShotRefs): boolean {
  return policy === 'openrouter' && (hasUrl(refs.videoUrls) || hasUrl(refs.audioUrls));
}

/** Catalog ids like `seedance-2-0-reference-to-video` mark the cast-lock
 * mode — both adapters key their wire format off this. */
export function isReferenceModel(modelId: string | undefined): boolean {
  return /reference/i.test(modelId ?? '');
}
