/**
 * Sentry browser-side configuration. `instrumentation-client.ts` is the
 * supported Next 15 entrypoint and works for both webpack and Turbopack.
 */
import * as Sentry from '@sentry/nextjs';
import { sentryBeforeSend } from './lib/sentry-scrub';

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  const isDebug = process.env.NEXT_PUBLIC_SENTRY_DEBUG === '1';
  const isDev = process.env.NODE_ENV === 'development';

  Sentry.init({
    dsn,
    tracesSampleRate: isDebug || isDev ? 1.0 : 0.1,
    debug: isDebug,
    replaysOnErrorSampleRate: 0,
    replaysSessionSampleRate: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeSend: sentryBeforeSend as any,
  });
}
