/**
 * Sentry PII scrubber — shared across all four Sentry inits.
 *
 * 152-ФЗ compliance: Russian Federal Law on Personal Data prohibits
 * transmitting personal data (имя, email, телефон, адрес) to external
 * processors without explicit consent. This beforeSend hook strips all
 * known PII vectors from Sentry events before they leave the process.
 *
 * Applied to:
 *   - sentry.client.config.ts  (Next.js browser)
 *   - sentry.server.config.ts  (Next.js Node server)
 *   - sentry.edge.config.ts    (Next.js edge runtime)
 *   - apps/api/src/server.ts   (Fastify API)
 *   - apps/worker/src/index.ts (BullMQ worker)
 */

// Minimal local interface matching the Sentry Event shape that we actually
// touch. Avoids importing @sentry/types (not a direct dep) while still giving
// TypeScript-safe access to the fields we scrub.
interface SentryEvent {
  request?: {
    cookies?: unknown;
    headers?: Record<string, unknown>;
    data?: unknown;
  };
  breadcrumbs?: { values?: BreadcrumbItem[] } | BreadcrumbItem[];
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | null | undefined>;
}
interface BreadcrumbItem {
  data?: Record<string, unknown>;
}

const PII_KEY_RE = /prompt|email|phone|name|address/i;

function stripPiiFromObject(obj: Record<string, unknown> | null | undefined): void {
  if (!obj) return;
  for (const key of Object.keys(obj)) {
    if (PII_KEY_RE.test(key)) {
      delete obj[key];
    }
  }
}

function scrubBreadcrumb(crumb: BreadcrumbItem): BreadcrumbItem {
  if (crumb.data) {
    // Remove query strings from URLs recorded in breadcrumbs.
    if (typeof crumb.data['url'] === 'string') {
      crumb.data['url'] = crumb.data['url'].split('?')[0];
    }
    // Drop any body payload embedded in breadcrumb data.
    delete crumb.data['body'];
    delete crumb.data['requestBody'];
  }
  return crumb;
}

export function sentryBeforeSend(event: SentryEvent): SentryEvent | null {
  // Strip cookies and auth headers from the captured request.
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      delete event.request.headers['cookie'];
      delete event.request.headers['authorization'];
    }
    // Drop the entire request body — could contain prompt or PII.
    delete event.request.data;
  }

  // Scrub breadcrumbs.
  if (event.breadcrumbs) {
    const crumbs = Array.isArray(event.breadcrumbs)
      ? event.breadcrumbs
      : (event.breadcrumbs.values ?? []);
    for (let i = 0; i < crumbs.length; i++) {
      if (crumbs[i]) crumbs[i] = scrubBreadcrumb(crumbs[i]!);
    }
  }

  // Scrub extra and contexts for PII keys.
  if (event.extra) stripPiiFromObject(event.extra);
  if (event.contexts) {
    for (const ctx of Object.values(event.contexts)) {
      if (ctx && typeof ctx === 'object') {
        stripPiiFromObject(ctx);
      }
    }
  }

  return event;
}
