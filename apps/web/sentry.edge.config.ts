/**
 * Sentry edge-runtime configuration for Next.js (W4 audit #14).
 *
 * Next.js middleware runs in the edge runtime. Without this file, Sentry
 * would silently not capture errors from middleware or edge API routes.
 *
 * Stub mode when SENTRY_DSN is empty — same pattern as client/server configs.
 * beforeSend uses the same PII scrubber as the other configs.
 *
 * Note: the edge runtime does not support all Node.js APIs — in particular
 * `jsdom` (used by isomorphic-dompurify) is not available here, so we inline
 * a minimal scrubber rather than importing from lib/sentry-scrub.ts.
 */
import * as Sentry from '@sentry/nextjs';

const PII_KEY_RE = /prompt|email|phone|name|address/i;

type EdgeEvent = {
  request?: { cookies?: unknown; headers?: Record<string, unknown>; data?: unknown };
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | null | undefined>;
};

function scrubObj(obj: Record<string, unknown> | null | undefined): void {
  if (!obj) return;
  for (const key of Object.keys(obj)) {
    if (PII_KEY_RE.test(key)) delete obj[key];
  }
}

function sentryBeforeSendEdge(event: EdgeEvent): EdgeEvent | null {
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      delete event.request.headers['cookie'];
      delete event.request.headers['authorization'];
    }
    delete event.request.data;
  }
  if (event.extra) scrubObj(event.extra);
  if (event.contexts) {
    for (const ctx of Object.values(event.contexts)) {
      if (ctx && typeof ctx === 'object') scrubObj(ctx);
    }
  }
  return event;
}

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  const isDebug = process.env.SENTRY_DEBUG === '1';
  const isDev = process.env.NODE_ENV === 'development';

  Sentry.init({
    dsn,
    tracesSampleRate: isDebug || isDev ? 1.0 : 0.1,
    debug: isDebug,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeSend: sentryBeforeSendEdge as any,
  });
}
