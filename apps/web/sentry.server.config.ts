/**
 * Sentry server-side (Node) configuration for Next.js (W4.Fri).
 *
 * Stub mode when SENTRY_DSN is empty.
 * Sample at 10% in non-dev; 100% if SENTRY_DEBUG=1.
 *
 * beforeSend scrubs PII per 152-ФЗ (see lib/sentry-scrub.ts).
 */
import * as Sentry from '@sentry/nextjs';
import { sentryBeforeSend } from './lib/sentry-scrub';

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  const isDebug = process.env.SENTRY_DEBUG === '1';
  const isDev = process.env.NODE_ENV === 'development';

  Sentry.init({
    dsn,
    tracesSampleRate: isDebug || isDev ? 1.0 : 0.1,
    debug: isDebug,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeSend: sentryBeforeSend as any,
  });
}
