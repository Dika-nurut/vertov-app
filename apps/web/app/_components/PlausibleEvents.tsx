'use client';

// Convenience event names used across the funnel:
export const PlausibleEvent = {
  signupCompleted: 'signup_completed',
  signupStarted: 'signup_started',
  generateSubmitted: 'generate_submitted',
  generateSucceeded: 'generate_succeeded',
  generateFailed: 'generate_failed',
  galleryPublish: 'gallery_publish',
  checkoutStarted: 'checkout_started',
  checkoutCompleted: 'checkout_completed',
  checkoutFailed: 'checkout_failed',
  checkoutRefunded: 'checkout_refunded',
  supportContact: 'support_contact',
  landingCta: 'landing_cta',
  vitrinaShelf: 'vitrina_shelf',
  boardRunStarted: 'board_run_started',
  studioExportStarted: 'studio_export_started',
  studioExportSucceeded: 'studio_export_succeeded',
  scenarioStartOpened: 'scenario_start_opened',
  scenarioIntentSubmitted: 'scenario_intent_submitted',
  scenarioStructurizeCompleted: 'scenario_structurize_completed',
  scenarioStructurizeFailed: 'scenario_structurize_failed',
  scenarioAssistRequested: 'scenario_assist_requested',
  scenarioAssistCompleted: 'scenario_assist_completed',
  scenarioAssistFailed: 'scenario_assist_failed',
  scenarioProposalApplied: 'scenario_proposal_applied',
  scenarioExported: 'scenario_exported',
  presetApplied: 'preset_applied',
  shareOpened: 'share_opened',
  onboardingStepCompleted: 'onboarding_step_completed',
} as const;

export type PlausibleEventName = (typeof PlausibleEvent)[keyof typeof PlausibleEvent];
export type PlausiblePropValue = string | number | boolean;
export type VitrinaShelfPayload = { shelf: string };
export type SignupMethod = 'yandex' | 'vk' | 'email' | 'phone';

/**
 * Keep analytics payloads useful for aggregate decisions and safe to send to a
 * third-party collector. Callers should pass enums/buckets only — never prompts,
 * IDs, email addresses, filenames, payment details, or raw provider errors.
 */
export function trackEvent(
  name: PlausibleEventName,
  props?: Record<string, PlausiblePropValue>,
): void {
  if (typeof window === 'undefined') return;
  const p = (
    window as unknown as {
      plausible?: (n: string, o?: { props?: Record<string, unknown> }) => void;
    }
  ).plausible;
  if (typeof p === 'function') {
    p(name, props ? { props } : undefined);
  }
}

export function trackSignupStarted(method: SignupMethod): void {
  trackEvent(PlausibleEvent.signupStarted, { method });
}

/** Checkout analytics must not reveal an exact token package size. */
export type CreditBucket = 'S' | 'M' | 'L';

export function creditBucket(credits: number): CreditBucket {
  if (!Number.isFinite(credits) || credits <= 500) return 'S';
  if (credits <= 5_000) return 'M';
  return 'L';
}

/** Stable aggregate classes for failures; raw backend error codes stay private. */
export type AnalyticsErrorBucket =
  | 'validation'
  | 'auth'
  | 'rate_limited'
  | 'network'
  | 'unavailable'
  | 'unknown';

export function analyticsErrorBucket(error: unknown): AnalyticsErrorBucket {
  const value = typeof error === 'string' ? error.toLowerCase() : '';
  if (/invalid|unusable|validation|empty|format/.test(value)) return 'validation';
  if (/auth|unauthori[sz]ed|forbidden|signup_required/.test(value)) return 'auth';
  if (/rate|limit|too_many|thrott/.test(value)) return 'rate_limited';
  if (/network|timeout|abort|fetch/.test(value)) return 'network';
  if (/unavailable|disabled|provider|upstream|5\d\d|failed/.test(value)) return 'unavailable';
  return 'unknown';
}

/** Bucket a count so event properties do not become a disguised payload channel. */
export function countBucket(count: number): '0' | '1-3' | '4-8' | '9+' {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count <= 3) return '1-3';
  if (count <= 8) return '4-8';
  return '9+';
}

// Attribution: first-touch UTM capture. Persists to localStorage on first visit
// (survives the OAuth roundtrip where URL params don't), then POSTs once to
// /v1/me/attribution after signup. First-touch wins; 30-day expiry.
const ATTRIBUTION_KEY = 'vertov_attribution';
const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AttributionPayload {
  utmSource?: string | undefined;
  utmMedium?: string | undefined;
  utmCampaign?: string | undefined;
  referrer?: string | undefined;
  landingPath?: string | undefined;
}

export function readStoredAttribution(): AttributionPayload | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ATTRIBUTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number } & AttributionPayload;
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > ATTRIBUTION_TTL_MS) {
      window.localStorage.removeItem(ATTRIBUTION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Call once from the root layout on mount. Stores first-touch only. */
export function captureAttribution(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const source = url.searchParams.get('utm_source');
  const medium = url.searchParams.get('utm_medium');
  const campaign = url.searchParams.get('utm_campaign');
  const referrer = document.referrer || undefined;
  // No UTM and no external referrer → nothing worth storing.
  if (!source && !referrer) return;
  if (readStoredAttribution()) return; // first-touch wins
  const payload: AttributionPayload & { at: number } = {
    utmSource: source ?? undefined,
    utmMedium: medium ?? undefined,
    utmCampaign: campaign ?? undefined,
    referrer,
    landingPath: window.location.pathname,
    at: Date.now(),
  };
  try {
    window.localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(payload));
  } catch {
    // storage full or blocked — analytics is best-effort
  }
}

/** POST stored attribution once after first authed load. Idempotent server-side. */
export async function sendAttribution(apiUrl: string): Promise<void> {
  const payload = readStoredAttribution();
  if (!payload) return;
  try {
    // The anonymous browsing flow has a real Better Auth session cookie, but
    // that identity is temporary and is filtered out of the business funnel.
    // Do not attach first-touch data to it: keep the payload until the user
    // completes a real signup and the claim can be attributed to that account.
    const meResponse = await fetch(apiUrl + '/v1/me', { credentials: 'include' });
    if (!meResponse.ok) return;
    const me = (await meResponse.json().catch(() => null)) as {
      user?: { isAnonymous?: boolean | null };
    } | null;
    if (!me?.user || me.user.isAnonymous) return;

    const response = await fetch(apiUrl + '/v1/me/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include',
    });
    if (!response.ok) return;
    // Clear after successful send so we don't re-POST on every page.
    window.localStorage.removeItem(ATTRIBUTION_KEY);
  } catch {
    // network error → keep in storage, retry next authed load
  }
}
