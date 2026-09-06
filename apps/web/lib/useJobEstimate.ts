// Server-side price quote for the Generate/Boards UI. `POST /v1/jobs/estimate`
// runs the exact same resolver `POST /v1/jobs` charges with, so the returned
// cost equals the cost a submit will reserve for an identical request — the
// displayed price can no longer diverge from the reserved charge once
// parametric price points activate.
import { useEffect, useRef, useState } from 'react';

const ESTIMATE_DEBOUNCE_MS = 300;
const ESTIMATE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Stand-in prompt for callers that quote before the user has written anything.
 * The price never depends on prompt text, but `generationJobRequestSchema` wants a
 * non-empty string, so a single space is the smallest thing that satisfies it.
 */
export const QUOTE_PLACEHOLDER_PROMPT = ' ';

export interface UseJobEstimateInput {
  apiUrl: string;
  modelId: string | undefined;
  prompt: string;
  params: Record<string, unknown>;
  source: 'generate' | 'boards';
  /** Skip the request entirely (e.g. inputs still incomplete). */
  enabled: boolean;
  /**
   * Whether a non-blank prompt is required before quoting. Generate keeps the
   * default typing debounce; Boards can quote complete settings before text is
   * entered because prompt text does not affect the price.
   */
  requiresPrompt?: boolean;
  /**
   * Bump to force a re-quote with unchanged inputs. The one caller is a submit
   * refused with `quote_stale`: the catalogue moved under a quote whose inputs
   * did not, so nothing in the dependency list changes and the surface would
   * otherwise re-submit the same stale number forever.
   */
  refreshToken?: number;
  /**
   * References that do not exist yet but will by submit time — a Board shot fed by
   * an upstream that has not rendered. Its URL is unknowable now; its COUNT is not,
   * and the count is what a reference-band price depends on. Without it a Run All
   * quotes one reference short and the bound submit is refused `quote_stale`, with
   * a retry that re-takes the same pre-run snapshot and is refused again.
   */
  pendingReferenceCount?: number;
}

/**
 * A price the server explicitly REFUSED to quote (HTTP 400 with a stable code) —
 * as opposed to a transport failure. The distinction matters: a network blip may
 * be papered over with the local flat estimate, but a refusal must NOT be, or the
 * button shows a confident number for a request that cannot be charged at all
 * (the client-side twin of the silent flat charge this release removes).
 */
export interface JobEstimateRefusal {
  /** Stable machine code: `price_unavailable`, `config_not_available`, … */
  code: string;
  /** Server-supplied RU text; null when the server sent only a code. */
  message: string | null;
}

export interface JobEstimateResult {
  cost: number | null;
  units: number | null;
  loading: boolean;
  /** Transport/unknown failure — the local placeholder price is still fair. */
  error: boolean;
  /** Explicit server refusal — show this, never a locally-computed price. */
  refusal: JobEstimateRefusal | null;
  /**
   * The last settled quote, carried ONLY while a fresh one is in flight. It is
   * deliberately not `cost`: it is not the price of the current configuration and
   * nothing may be charged or enabled on it. Surfaces render it greyed as "this is
   * being recounted", which beats blanking the number on every parameter click —
   * that blink reads as a broken price. Null once the new quote settles.
   */
  previousCost: number | null;
}

/**
 * Read a non-OK `/v1/jobs/estimate` response into a refusal, or `null` when it is
 * a transport/server failure the local placeholder price may still cover.
 *
 * The distinction is the whole point: a 4xx carrying a stable `error` code is the
 * server saying it will not quote this configuration (`price_unavailable`,
 * `config_not_available`, `model_not_available`), and the submit that follows
 * would fail the same way. A 5xx or an unparseable body says nothing about the
 * price. Collapsing both to `error: true` — which is what this hook used to do —
 * is what let the button keep showing a confident locally-computed number for a
 * request the server had just declined.
 */
export function estimateRefusalFrom(status: number, body: unknown): JobEstimateRefusal | null {
  if (status < 400 || status >= 500) return null;
  const record = (body ?? {}) as Record<string, unknown>;
  const code = record['error'];
  if (typeof code !== 'string' || code.length === 0) return null;
  const message = record['message'];
  return { code, message: typeof message === 'string' && message ? message : null };
}

/**
 * The price to render: only the server's quote. An absent, loading, failed, or
 * refused quote is always `null` (show «—», not a number). One rule, shared by
 * /generate and /boards so the two cannot drift.
 */
export function estimatePriceToShow(estimate: Pick<JobEstimateResult, 'cost'>): number | null {
  return estimate.cost;
}

/** A generation action may proceed only on an authoritative, settled quote. */
export function hasKnownJobEstimate(estimate: JobEstimateResult): boolean {
  return (
    estimate.cost !== null && !estimate.loading && !estimate.error && estimate.refusal === null
  );
}

/**
 * Clear every price-bearing field before a distinct quote is requested, keeping
 * the outgoing number only as `previousCost` so the surface can grey it out
 * instead of blanking. `cost` is null, so no display or submit rule sees a price.
 */
export function pendingJobEstimate(previousCost: number | null = null): JobEstimateResult {
  return { cost: null, units: null, loading: true, error: false, refusal: null, previousCost };
}

/**
 * The number to render greyed while a fresh quote is in flight, or null when
 * there is nothing to carry over (first quote, or the last attempt failed).
 */
export function recalculatingPriceToShow(
  estimate: Pick<JobEstimateResult, 'cost' | 'previousCost'>,
): number | null {
  return estimate.cost === null ? estimate.previousCost : null;
}

/** Whether the inputs are complete enough to ask the authoritative quote API. */
export function canRequestJobEstimate({
  enabled,
  modelId,
  prompt,
  requiresPrompt = true,
}: Pick<UseJobEstimateInput, 'enabled' | 'modelId' | 'prompt' | 'requiresPrompt'>): boolean {
  return enabled && Boolean(modelId) && (!requiresPrompt || Boolean(prompt.trim()));
}

/** Debounced, race-safe quote from `/v1/jobs/estimate`. */
export function useJobEstimate({
  apiUrl,
  modelId,
  prompt,
  params,
  source,
  enabled,
  requiresPrompt = true,
  refreshToken = 0,
  pendingReferenceCount = 0,
}: UseJobEstimateInput): JobEstimateResult {
  const [result, setResult] = useState<JobEstimateResult>({
    cost: null,
    units: null,
    loading: false,
    error: false,
    refusal: null,
    previousCost: null,
  });
  // Bumped on every scheduled request; a response is applied only if it's
  // still the latest one in flight, so a stale slow response can never
  // clobber a fresher quote.
  const requestIdRef = useRef(0);
  // The identity the stored result belongs to. Comparing it during render makes
  // a prop change unknown immediately; waiting for useEffect would leave one
  // rendered frame where the old quote could still be visible/clickable.
  const resultRequestKeyRef = useRef<string | null>(null);
  const paramsKey = JSON.stringify(params);
  const canRequest = canRequestJobEstimate({ enabled, modelId, prompt, requiresPrompt });
  const requestKey = canRequest
    ? JSON.stringify({
        apiUrl,
        modelId,
        prompt,
        params,
        source,
        requiresPrompt,
        refreshToken,
        pendingReferenceCount,
      })
    : null;

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!canRequest) {
      resultRequestKeyRef.current = null;
      setResult({
        cost: null,
        units: null,
        loading: false,
        error: false,
        refusal: null,
        previousCost: null,
      });
      return;
    }
    resultRequestKeyRef.current = requestKey;
    // A changed quote identity makes every previous number stale. Clear it before
    // the debounce begins so no surface can render or submit on the old quote —
    // it survives only as `previousCost`, which cannot be charged or acted on.
    // `prev.previousCost` is the fallback so a burst of clicks still has something
    // to grey out instead of falling back to a dash mid-burst.
    setResult((prev) => pendingJobEstimate(prev.cost ?? prev.previousCost));
    const timer = setTimeout(() => {
      fetch(`${apiUrl}/v1/jobs/estimate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          modelId,
          prompt,
          params,
          source,
          ...(pendingReferenceCount > 0 ? { pendingReferenceCount } : {}),
        }),
        signal: AbortSignal.timeout(ESTIMATE_FETCH_TIMEOUT_MS),
      })
        .then(async (res) => {
          if (requestIdRef.current !== requestId) return;
          if (!res.ok) {
            // Keep the server's own code + message instead of collapsing every
            // non-OK response to a bare boolean: a 400 with `price_unavailable`
            // is a deliberate refusal to quote and the UI must say so, while a
            // 5xx/parse failure stays a soft error the placeholder can cover.
            const body = await res.json().catch(() => null);
            if (requestIdRef.current !== requestId) return;
            setResult({
              cost: null,
              units: null,
              loading: false,
              error: true,
              refusal: estimateRefusalFrom(res.status, body),
              // A settled failure drops the carry-over: a refusal must never leave
              // a stale number greyed on screen as if it were still being counted.
              previousCost: null,
            });
            return;
          }
          const body = await res.json();
          if (requestIdRef.current !== requestId) return;
          setResult({
            cost: body.cost,
            units: body.units,
            loading: false,
            error: false,
            refusal: null,
            previousCost: null,
          });
        })
        .catch(() => {
          if (requestIdRef.current !== requestId) return;
          setResult({
            cost: null,
            units: null,
            loading: false,
            error: true,
            refusal: null,
            previousCost: null,
          });
        });
    }, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    apiUrl,
    modelId,
    prompt,
    paramsKey,
    source,
    enabled,
    requiresPrompt,
    canRequest,
    refreshToken,
  ]);

  // Return an unknown value during the render in which request inputs changed,
  // before the effect above has had a chance to replace state. This closes the
  // stale-price frame between changing quality/duration/refs/count and re-quote.
  if (requestKey === null) {
    return {
      cost: null,
      units: null,
      loading: false,
      error: false,
      refusal: null,
      previousCost: null,
    };
  }
  // Carry the outgoing number here too, or the frame between the input change and
  // the effect would flash a dash before the greyed figure appears.
  return resultRequestKeyRef.current === requestKey
    ? result
    : pendingJobEstimate(result.cost ?? result.previousCost);
}
