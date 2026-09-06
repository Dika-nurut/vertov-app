/**
 * Board quote plumbing, in three parts:
 *
 * 1. `wiredVideoRefUrls` — the price-relevant slice of a shot's wired
 *    references, derived SYNCHRONOUSLY from the graph.
 * 2. `boardQuoteKey` — the price-relevant identity of a compiled request. The
 *    ONE definition both quote writers and the submitting runner derive from.
 * 3. `createBoardQuoteRegistry` — keyed quotes, so `expectedCost` can only ever
 *    be bound to a number that describes the request actually being submitted.
 *
 * Why this exists: the generate node quotes `POST /v1/jobs/estimate` from its
 * own settings, while `GraphBoard.runNode` compiles the request it actually
 * submits from those settings PLUS the references `resolveRefs` pulled off the
 * upstream nodes. `videoUrls` PRESENCE is a price selector — the API's
 * `priceSelectorFromParams` turns it into `videoInput`, and only price points
 * with the matching flag are eligible — so a shot with a wired motion
 * reference was quoted at one price and charged at another. Binding the submit
 * to the badge (`expectedCost`) turns that silent divergence into a 409, so
 * the badge has to learn the same signal first.
 *
 * This mirrors `resolveRefs`'s video branch. The one thing it cannot read off
 * the graph is an upstream shot's RESULT before that shot has run — so it
 * predicts the contribution instead: a video shot outputs a clip, and
 * `resolveRefs` classifies every upstream result the same way whether it was
 * already `done`, came from the Run All output map, or was produced by an
 * inline run. That uniformity is load-bearing and is asserted there; without it
 * the same graph would wire a generated clip as a motion ref or as a still
 * depending only on whether a completion patch had landed yet, and no
 * synchronous mirror could match a coin flip.
 */
import { imageHandleIndex, referenceImageHandleIndex } from './ref-ports';
import { assembleShotRefs, type CastLike, type RefSource } from './cast';
import type { BoardCompiledFrameImage } from '@seed/shared/board-contract';

export interface BoardQuoteNodeLike {
  id: string;
  type?: string | null | undefined;
  data: Record<string, unknown>;
}

export interface BoardQuoteEdgeLike {
  source: string;
  target: string;
  targetHandle?: string | null | undefined;
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

export interface BoardShotResult {
  url: string;
  /** The producing shot's recorded `resultKind`, when it is known. */
  resultKind?: unknown;
}

/**
 * Does a shot's output ride as a MOTION reference? The single classifier for
 * every route a produced result can arrive by — already `done`, held in the Run
 * All output map, or just returned by an inline run — and for this module's own
 * prediction. They must agree exactly: a result classified one way when the
 * quote was taken and the other way at submit flips `videoInput`, and the
 * charge then cannot be bound to the price the customer saw.
 *
 * `resultKind` leads because it is what the producing job actually recorded;
 * the URL suffix is the fallback for a result that carries no kind. Trusting
 * the suffix alone is not equivalent — a video served from a URL with no
 * recognised extension (a signed or query-only asset URL) reads as an image.
 */
export function isVideoShotResult(result: BoardShotResult): boolean {
  return result.resultKind === 'video' || isVideoUrl(result.url);
}

const usableUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export interface WiredVideoRefInput {
  nodeId: string;
  nodes: readonly BoardQuoteNodeLike[];
  edges: readonly BoardQuoteEdgeLike[];
  /** `model.videoReferenceMax` — a model that takes no motion refs never gets one. */
  videoReferenceMax: number;
  /**
   * Gallery-identified media resolve through the asset lifecycle. `resolveRefs`
   * skips a media node whose asset is not available yet, so an unresolved id
   * must return undefined here and be skipped too.
   */
  resolveAssetUrl?: ((assetId: string) => string | undefined) | undefined;
}

/**
 * The motion references a run of `nodeId` would compile right now, in the same
 * order, de-duplicated and capped exactly like `assembleShotRefs` does.
 */
export function wiredVideoRefUrls(input: WiredVideoRefInput): string[] {
  if (!(input.videoReferenceMax > 0)) return [];
  const incoming = input.edges
    .filter(
      (edge) =>
        edge.target === input.nodeId &&
        (imageHandleIndex(edge.targetHandle) !== null ||
          referenceImageHandleIndex(edge.targetHandle) !== null),
    )
    .sort(
      (left, right) =>
        (referenceImageHandleIndex(left.targetHandle) ?? imageHandleIndex(left.targetHandle)!) -
        (referenceImageHandleIndex(right.targetHandle) ?? imageHandleIndex(right.targetHandle)!),
    );
  // Every generate node re-derives this on each React Flow store tick, so an
  // unwired shot must not pay for an index over the whole board.
  if (incoming.length === 0) return [];

  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const videos: string[] = [];
  for (const edge of incoming) {
    const source = nodesById.get(edge.source);
    if (!source) continue;
    if (source.type === 'media') {
      const assetId = source.data['assetId'];
      const url = usableUrl(assetId)
        ? (input.resolveAssetUrl?.(assetId) ?? '')
        : source.data['url'];
      if (!usableUrl(url)) continue;
      if (source.data['mediaKind'] === 'video') videos.push(url);
    } else if (source.type === 'cast') {
      // A Локация's ambience clip rides as a motion ref; its stills do not.
      const videoUrl = source.data['videoUrl'];
      if (usableUrl(videoUrl)) videos.push(videoUrl);
    } else if (source.type === 'generate') {
      const resultUrl = source.data['resultUrl'];
      if (source.data['status'] === 'done' && usableUrl(resultUrl)) {
        if (isVideoShotResult({ url: resultUrl, resultKind: source.data['resultKind'] })) {
          videos.push(resultUrl);
        }
      } else if (source.data['mode'] === 'video') {
        // NOT finished yet. The runner will wait for it (or run it) and then
        // wire its OUTPUT — and a video shot outputs a clip, which rides as a
        // motion ref. Quoting it as "no video" was wrong: an upstream that is
        // merely RUNNING when we quote is routinely `done` by the time
        // `resolveRefs` walks it, which flipped the child's videoInput and
        // unbound every such submit.
        //
        // The URL is unknowable here and irrelevant — only PRESENCE is priced —
        // so a stable per-node sentinel stands in for the slot. It reaches
        // `/v1/jobs/estimate` (which reads presence only) and never a submit,
        // whose params always come from the real compiled request.
        videos.push(`pending://${source.id}`);
      }
    }
  }
  return [...new Set(videos)].slice(0, input.videoReferenceMax);
}

export interface WiredImageRefInput {
  nodeId: string;
  nodes: readonly BoardQuoteNodeLike[];
  edges: readonly BoardQuoteEdgeLike[];
  imageInput: {
    role: 'none' | 'frame' | 'reference';
    max: number;
    frameRoles: readonly ('first' | 'last')[];
  };
  imageReferenceMax: number;
  resolveAssetUrl?: ((assetId: string) => string | undefined) | undefined;
}

export interface WiredImageRefs {
  imageUrls: string[];
  frameImages: BoardCompiledFrameImage[];
  /** Upstream stills not rendered yet: no URL to send, but they WILL be sent. */
  pendingReferenceCount: number;
  /**
   * The same thing for a FRAME slot, counted apart from references.
   *
   * It has to be apart, because the two are different fields in the compiled
   * request: a pending still wired into a frame slot becomes `frameImages` at
   * submit, not `imageUrls`. Counting it as a pending reference made the quote key
   * say «one reference, no frame» while the submit said «no reference, one frame»,
   * and Run All refused its own quote as unconfirmed — on exactly the flow the
   * pending count was added to rescue.
   */
  pendingFrameCount: number;
}

/**
 * The still/frame references a run of `nodeId` would compile right now. This
 * is the synchronous quote-side mirror of GraphBoard's `resolveRefs` image
 * branch: typed frame slots stay in `frameImages`, while ordinary references
 * go through the same cast ordering, de-duplication and cap as the runner.
 */
export function wiredImageRefs(input: WiredImageRefInput): WiredImageRefs {
  const empty = {
    imageUrls: [],
    frameImages: [],
    pendingReferenceCount: 0,
    pendingFrameCount: 0,
  } satisfies WiredImageRefs;
  if (input.imageInput.role === 'none') return empty;

  const incoming = input.edges
    .filter(
      (edge) =>
        edge.target === input.nodeId &&
        (imageHandleIndex(edge.targetHandle) !== null ||
          referenceImageHandleIndex(edge.targetHandle) !== null),
    )
    .sort(
      (left, right) =>
        (referenceImageHandleIndex(left.targetHandle) ?? imageHandleIndex(left.targetHandle)!) -
        (referenceImageHandleIndex(right.targetHandle) ?? imageHandleIndex(right.targetHandle)!),
    );
  if (incoming.length === 0) return empty;

  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const sources: RefSource[] = [];
  const frameImages: BoardCompiledFrameImage[] = [];
  // References are counted as DISTINCT SOURCES, not as edges: the same unfinished
  // node wired into two reference slots resolves to one URL, and `assembleShotRefs`
  // de-duplicates it — so counting edges would quote two references for a submit that
  // carries one, which on a banded model is two prices as well as two keys.
  //
  // Frames are counted per SLOT, because that is what the compiled request does: one
  // still wired to both `first` and `last` becomes two `frameImages` entries with the
  // same URL and different roles, and nothing de-duplicates them.
  const pendingSources = new Set<string>();
  let pendingFrames = 0;
  for (const edge of incoming) {
    const source = nodesById.get(edge.source);
    if (!source) continue;
    const slot = imageHandleIndex(edge.targetHandle);
    const isReferenceChannel = referenceImageHandleIndex(edge.targetHandle) !== null;
    const frameRole =
      !isReferenceChannel && input.imageInput.role === 'frame' && slot !== null
        ? input.imageInput.frameRoles[slot]
        : undefined;
    const addImage = (url: string) => {
      if (frameRole) frameImages.push({ role: frameRole, url });
      else sources.push({ kind: 'image', url });
    };
    const addResult = (url: string) => {
      if (!isVideoShotResult({ url, resultKind: source.data['resultKind'] })) addImage(url);
    };

    if (source.type === 'media') {
      const assetId = source.data['assetId'];
      const url = usableUrl(assetId)
        ? (input.resolveAssetUrl?.(assetId) ?? '')
        : source.data['url'];
      if (usableUrl(url) && source.data['mediaKind'] !== 'video') addImage(url);
    } else if (source.type === 'cast') {
      sources.push({ kind: 'cast', cast: source.data as unknown as CastLike });
    } else if (source.type === 'generate') {
      const resultUrl = source.data['resultUrl'];
      if (source.data['status'] === 'done' && usableUrl(resultUrl)) {
        addResult(resultUrl);
      } else if (source.data['mode'] === 'image') {
        // An upstream still that has not rendered yet. It contributes no URL —
        // this function's contract is «the payload the submit will carry», and a
        // placeholder for a result that does not exist would be a reference we
        // quote and never send, the same divergence pointing the other way.
        //
        // It does contribute to the COUNT. In a Run All, B is quoted before A
        // renders, so without this B is quoted one reference short and the bound
        // submit is refused `quote_stale` — with a retry that re-takes the same
        // pre-run snapshot and is refused again. The count is the honest half of
        // what we know, and it is the half a reference-band price depends on.
        if (frameRole) pendingFrames += 1;
        else pendingSources.add(source.id);
      }
    }
  }

  const refs = assembleShotRefs(sources, {
    images: input.imageReferenceMax > 0 ? input.imageReferenceMax : input.imageInput.max,
    videos: 0,
  });
  return {
    imageUrls: refs.imageUrls,
    frameImages,
    pendingReferenceCount: pendingSources.size,
    pendingFrameCount: pendingFrames,
  };
}

/** First non-empty string among `keys` — the server's own `firstString`. */
function firstString(params: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Canonical numeric field, coerced the way the server coerces it (`Number(...)`). */
function numericField(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '';
}

export interface BoardQuoteKeyInput {
  modelId: string;
  mode: 'video' | 'image';
  /** A COMPILED request's params — never raw node settings. */
  params: Record<string, unknown>;
  /**
   * Upstream stills not rendered yet. The badge counts them because the submit
   * will carry them; the runner passes nothing because by then they are real
   * URLs in `params`. Both therefore produce the SAME total, which is the only
   * reason the count can live in this key at all.
   */
  pendingReferenceCount?: number | undefined;
  /**
   * Pending stills bound for a FRAME slot. Separate from the reference count for
   * the same reason the wiring keeps them apart: they land in a different field of
   * the compiled request, so folding them together makes the key move when the
   * upstream renders — which is a quote that refuses its own submit.
   */
  pendingFrameCount?: number | undefined;
}

/**
 * The price-relevant identity of a compiled request: two requests share a key
 * exactly when the server would resolve them to the same price.
 *
 * This is the single definition both quote writers and the submitting runner
 * derive from, so a stored number can never be attached to a request it does
 * not describe. The dimensions mirror `apps/api/src/pricing-resolver.ts`:
 *
 * - `resolution` — the price-point selector. Video reads only `resolution`;
 *   image also accepts the legacy `quality` alias, in that order, because a
 *   video `quality` must never alias a resolution (a crafted `{quality:'480p'}`
 *   would underbill a 720p render).
 * - `videoUrls` PRESENCE — `priceSelectorFromParams` turns it into `videoInput`
 *   and only points carrying the matching flag are eligible.
 * - `generate_audio` — the server treats an explicit `false` as the quiet
 *   configuration and every other value (including an omitted field) as the
 *   adapter's audible default. Kling has both active states at different
 *   rates, so the key must preserve that distinction. The normalization here
 *   intentionally mirrors `priceSelectorFromParams`; models with one fixed
 *   audio state may produce extra quote misses, but can never reuse the wrong
 *   money binding.
 * - `duration_seconds` / `n` — the billed units (`unitsForModel`).
 * - `aspect_ratio` — NOT a price selector, and not in the brief's list, but the
 *   contract billing path (`billableVideoUnitsForModel` → `normalizeVideoParams`)
 *   rejects an unaccepted aspect, which turns a resolvable price into a refusal.
 *   Included because it can change the ANSWER, and it costs nothing: both sides
 *   derive it from the same settings, so it can never force a false mismatch.
 *
 * - reference COUNT and frame PRESENCE — added when finance began pricing them
 *   (rev. 10: a 2–8-reference Flux job and an image-to-video shot are their own
 *   configurations). The count, not the URLs: the runner compiles resolved refs
 *   while the badge has an unrendered upstream it can only count, and keying on
 *   URLs would make those two permanently fail to match. Frames are counted
 *   separately from references because finance does not count a frame as a
 *   reference — it selects the mode instead.
 *
 * Prompt, provider and idempotency key are absent on purpose: they change no
 * price.
 *
 * `modelId` leads: everything the server derives from the model row — declared
 * resolutions, the duration floor/ceiling, the price ladder itself — is a
 * function of it. When the CATALOGUE moves under an unchanged key the price
 * changes without the key changing; that is precisely the case 409
 * `quote_stale` exists for, and the server is the arbiter.
 */
export function boardQuoteKey(input: BoardQuoteKeyInput): string {
  const params = input.params;
  const resolution =
    input.mode === 'video'
      ? firstString(params, ['resolution'])
      : firstString(params, ['resolution', 'quality']);
  // `priceSelectorFromParams` defaults every non-false value to audio=true.
  // Keep the same canonical value in the client-side quote identity. The
  // image sentinel keeps tuple positions stable without making image params
  // accidentally price-sensitive to a video-only field.
  const generateAudio = input.mode === 'video' ? params['generate_audio'] !== false : null;
  const videoUrls = params['videoUrls'];
  const imageUrls = params['imageUrls'];
  const frameImages = params['frameImages'];
  // Counted per CHANNEL, and each count spans the pending→rendered transition: a
  // still wired to a frame slot is one frame before it renders and one frame after,
  // never a reference in between.
  const referenceCount =
    (Array.isArray(imageUrls) ? imageUrls.length : 0) + (input.pendingReferenceCount ?? 0);
  const frameCount =
    (Array.isArray(frameImages) ? frameImages.length : 0) + (input.pendingFrameCount ?? 0);
  // JSON, not a delimiter-joined string. This key is a safety boundary: two
  // different requests that serialize alike would let one request's price be
  // bound to the other. Model ids and capability values are database data and
  // the request schema permits arbitrary param strings, so a `|`-joined key
  // collides on values that merely CONTAIN the delimiter — `resolution` of
  // "x|ar=y" reads identically to an `aspect_ratio` of "y|ar=z". JSON escapes
  // the quotes and fixes each field to its position, so no value can forge
  // another field's boundary.
  return JSON.stringify([
    input.modelId,
    input.mode,
    resolution,
    generateAudio,
    firstString(params, ['aspect_ratio']),
    numericField(params['duration_seconds']),
    numericField(params['n']),
    Array.isArray(videoUrls) && videoUrls.length > 0,
    referenceCount,
    frameCount,
  ]);
}

/**
 * The price each shot was last quoted at, keyed by the request that quote was
 * FOR, so the runner can bind `expectedCost` to a number that provably
 * describes the request it is about to submit.
 *
 * OWNERSHIP: entries are keyed facts, not owned slots. Any quote source may
 * overwrite a node's entry — the node badge and the «Снять всё» sheet both
 * write here — and NOTHING deletes. That is deliberate, and it is what makes
 * the two writers safe together:
 *
 * - An unmounting node must not erase the sheet's entry. React Flow renders
 *   only visible nodes, and overview mode renders none at all, so a cleanup
 *   that deleted would silently unbind the exact plan a user just approved a
 *   total for.
 * - Deletion is not needed for correctness. A read is answered only on an
 *   exact key match, so a stale entry is either the price of this very request
 *   or invisible. The old "publish null to erase" rule existed because a bare
 *   number could not tell those apart; the key can.
 *
 * A read that does not match returns null and the caller submits UNBOUND —
 * today's behaviour, never a wrong number and never a client-side refusal.
 *
 * GROWTH is bounded by node ids, not by quotes: a node holds ONE slot no matter
 * how many times it is re-quoted, and the map dies with the board. A deleted
 * node leaves its slot behind, which is why this is bounded by ids ever created
 * rather than ids currently on the canvas — a few dozen bytes that a
 * collision-free key makes harmless, and reclaiming them would mean deleting on
 * unmount, which is exactly what would re-open the Run All hole.
 */
export interface BoardQuoteRegistry {
  /** Record what `key` was quoted at. A non-finite cost is ignored. */
  publish(nodeId: string, key: string, cost: number): void;
  /** The cost quoted for exactly this key, or null. */
  read(nodeId: string, key: string): number | null;
}

export function createBoardQuoteRegistry(): BoardQuoteRegistry {
  const quotes = new Map<string, { key: string; cost: number }>();
  return {
    publish(nodeId, key, cost) {
      if (!Number.isFinite(cost)) return;
      quotes.set(nodeId, { key, cost });
    },
    read(nodeId, key) {
      const entry = quotes.get(nodeId);
      return entry && entry.key === key ? entry.cost : null;
    },
  };
}
