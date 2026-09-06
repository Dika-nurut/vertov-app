/**
 * Next.js instrumentation hook — loads Sentry on the server side (W4.Fri).
 * This file is the official Next.js way to run code before the app starts.
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // Only init Sentry on the server (Node runtime). The browser bundle
  // is handled by sentry.client.config.ts which @sentry/nextjs auto-loads.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
}

// Next 15 nested React Server Component errors bypass the ordinary error
// boundary path. Forward them through the SDK's request hook so production
// failures seen during Scenario navigation are not invisible.
export const onRequestError = Sentry.captureRequestError;
import * as Sentry from '@sentry/nextjs';
