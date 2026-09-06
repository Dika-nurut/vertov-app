/**
 * Sync OpenRouter's video + image capability catalog into candidate `models`
 * rows (S3 of research/archive/openrouter-model-expansion-2026-06-30.md).
 *
 * Reads the LIVE catalog — `GET /api/v1/videos/models` + `/api/v1/images/models`
 * — which is FREE metadata (no generation, zero provider spend). For each model
 * it emits a candidate row with the machine-readable option space already
 * filled in (kind / maxDurationSeconds / maxResolution / capabilities), leaving
 * the OPERATOR decisions blank: `tierMin` and `isActive`. The operator pastes
 * the rows they want into `seed/models.ts`, adds margin-safe workbook price
 * rows to `seed/price-points.ts` (the printed `priceUsdPerUnit` is the input
 * to the margin guardrail test), and flips `isActive` when ready.
 *
 * This is the "read every model's API docs" step done ONCE, automatically, from
 * the source of truth — not hand-transcribed.
 *
 * Usage (from repo root):
 *   OPENROUTER_API_KEY=sk-or-... pnpm --filter @seed/db exec \
 *     tsx scripts/sync-openrouter-models.ts [slug-substring ...]
 *
 * With no args it prints every catalog model; pass one or more substrings to
 * filter (e.g. `veo sora kling wan flux gemini` for the first batch).
 *
 * Uses the global `fetch` (Node ≥18) — no extra dependency.
 */
const BASE = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error('sync-openrouter-models: OPENROUTER_API_KEY is required');
  process.exit(1);
}
const filters = process.argv.slice(2).map((s) => s.toLowerCase());

interface OrVideoModel {
  id?: string;
  slug?: string;
  supported_durations?: number[];
  supported_resolutions?: string[];
  supported_aspect_ratios?: string[];
  supported_sizes?: string[];
  /** Live shape: ["first_frame","last_frame"] (or [] / ["first_frame"]). */
  supported_frame_images?: string[] | boolean;
  generate_audio?: boolean;
  allowed_passthrough_parameters?: string[];
  /** Live shape: object of { sku_name: priceString }, price per unit (sec). */
  pricing_skus?: Record<string, string | number> | { price?: number | string }[];
}
interface OrImageModel {
  id?: string;
  slug?: string;
  /** Live shape: object of { paramName: { type, ... } } (e.g. input_references
   *  → { type:'range', min, max }). */
  supported_parameters?: Record<string, { type?: string; max?: number }>;
  architecture?: { input_modalities?: string[] };
}

async function getModels<T>(path: string): Promise<T[]> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${KEY}`, accept: 'application/json', 'x-title': 'Seed' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { data?: T[] } | T[];
  return Array.isArray(json) ? json : (json.data ?? []);
}

/** A model row id from a slug: 'google/veo-3.1-fast' → 'veo-3-1-fast'. */
function rowId(slug: string): string {
  return slug
    .split('/')
    .pop()!
    .replace(/[.\s]/g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase();
}

function maxRes(resolutions: string[] | undefined, sizes: string[] | undefined): string | null {
  const tiers = (resolutions ?? []).filter(Boolean);
  if (tiers.length) {
    const rank = (r: string) => Number(r.replace(/[^\d]/g, '')) || (/4k/i.test(r) ? 2160 : 0);
    return [...tiers].sort((a, b) => rank(b) - rank(a))[0]!;
  }
  const sz = (sizes ?? []).filter(Boolean);
  if (sz.length) {
    const area = (s: string) => {
      const m = /(\d+)\D+(\d+)/.exec(s);
      return m ? Number(m[1]) * Number(m[2]) : 0;
    };
    return [...sz].sort((a, b) => area(b) - area(a))[0]!;
  }
  return null;
}

/** Worst-case USD/unit from the pricing SKUs (max numeric price). Handles both
 *  the live object shape ({ sku: priceString }) and a hypothetical array. */
function worstUsdPerUnit(skus: OrVideoModel['pricing_skus']): number | null {
  const raw = Array.isArray(skus) ? skus.map((s) => s.price) : Object.values(skus ?? {});
  const prices = raw.map((p) => Number(p)).filter((n) => Number.isFinite(n) && n > 0);
  return prices.length ? Math.max(...prices) : null;
}

/** Map supported_frame_images → our ['first','last'] anchor slots. */
function frameSlots(sf: OrVideoModel['supported_frame_images']): string[] {
  if (Array.isArray(sf)) {
    const out: string[] = [];
    if (sf.some((f) => /first/i.test(f))) out.push('first');
    if (sf.some((f) => /last/i.test(f))) out.push('last');
    return out;
  }
  return sf ? ['first', 'last'] : [];
}

function matches(slug: string): boolean {
  return filters.length === 0 || filters.some((f) => slug.toLowerCase().includes(f));
}

const [videos, images] = await Promise.all([
  getModels<OrVideoModel>('/videos/models'),
  getModels<OrImageModel>('/images/models'),
]);

const candidates: Record<string, unknown>[] = [];

for (const m of videos) {
  const slug = m.slug ?? m.id;
  if (!slug || !matches(slug)) continue;
  const durations = (m.supported_durations ?? []).filter((d) => Number.isFinite(d));
  candidates.push({
    id: rowId(slug),
    provider: 'byteplus', // gateway is forced to openrouter for slug ids
    family: slug.split('/')[0],
    variant: slug.split('/').pop(),
    kind: 'video',
    isActive: false, // OPERATOR: flip when reviewed
    tierMin: 'creator', // OPERATOR: set
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: durations.length ? Math.max(...durations) : null,
    maxResolution: maxRes(m.supported_resolutions, m.supported_sizes),
    providerModelId: slug,
    providerEndpoint: '/videos',
    capabilities: {
      audio: m.generate_audio === true,
      reference: false,
      frames: frameSlots(m.supported_frame_images),
      durations,
      resolutions: m.supported_resolutions ?? [],
      aspect_ratios: m.supported_aspect_ratios ?? [],
      passthrough: m.allowed_passthrough_parameters ?? [],
      priceUsdPerUnit: worstUsdPerUnit(m.pricing_skus),
    },
  });
}

for (const m of images) {
  const slug = m.slug ?? m.id;
  if (!slug || !matches(slug)) continue;
  const params = m.supported_parameters ?? {};
  const paramNames = Object.keys(params);
  const maxRefs = params['input_references']?.max ?? 0;
  const takesRefs = maxRefs > 0 || (m.architecture?.input_modalities ?? []).includes('image');
  candidates.push({
    id: rowId(slug),
    provider: 'byteplus',
    family: slug.split('/')[0],
    variant: slug.split('/').pop(),
    kind: 'image',
    isActive: false,
    tierMin: 'start',
    unitKind: 'image',
    expectedLatencyMsP50: 5000,
    expectedLatencyMsP95: 12000,
    maxResolution: null, // OPERATOR: set from the model's size docs
    providerModelId: slug,
    providerEndpoint: '/images',
    capabilities: {
      reference: takesRefs,
      multi_image: maxRefs > 1,
      edit: takesRefs,
      maxRefs,
      passthrough: paramNames,
      priceUsdPerUnit: null, // OPERATOR: set (per-image / per-MP — varies by model)
    },
  });
}

console.error(
  `sync-openrouter-models: ${videos.length} video + ${images.length} image models; ` +
    `${candidates.length} candidate row(s) after filter [${filters.join(', ') || 'none'}]`,
);
console.log(JSON.stringify(candidates, null, 2));
