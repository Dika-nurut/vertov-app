import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env') });

// Better Auth 1.6 still references the browser-global `crypto` in one utility
// path. Node 22 exposes the same WebCrypto API via globalThis.crypto; alias it
// before any auth route runs so magic-link token generation cannot 500.
if (typeof (globalThis as { crypto?: unknown }).crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: (await import('node:crypto')).webcrypto,
    configurable: true,
  });
}

// Sentry error monitoring — stub mode when SENTRY_DSN is empty.
// Must be initialised before Fastify creates the first logger.
// beforeSend scrubs PII per 152-ФЗ (see apps/web/lib/sentry-scrub.ts for the
// shared scrubber; we inline it here to avoid a cross-workspace import).
import * as Sentry from '@sentry/node';

type _SentryEvent = {
  request?: { cookies?: unknown; headers?: Record<string, unknown>; data?: unknown };
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | null | undefined>;
};

const PII_KEY_RE = /prompt|email|phone|name|address/i;
function _scrubObj(obj: Record<string, unknown> | null | undefined): void {
  if (!obj) return;
  for (const key of Object.keys(obj)) {
    if (PII_KEY_RE.test(key)) delete obj[key];
  }
}
function _sentryBeforeSend(event: _SentryEvent): _SentryEvent | null {
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      delete (event.request.headers as Record<string, unknown>)['cookie'];
      delete (event.request.headers as Record<string, unknown>)['authorization'];
    }
    delete event.request.data;
  }
  if (event.extra) _scrubObj(event.extra as Record<string, unknown>);
  if (event.contexts) {
    for (const ctx of Object.values(event.contexts)) {
      if (ctx && typeof ctx === 'object') _scrubObj(ctx as Record<string, unknown>);
    }
  }
  return event;
}

const _sentryDsn = process.env.SENTRY_DSN;
if (_sentryDsn) {
  const _isDebug = process.env.SENTRY_DEBUG === '1';
  const _isDev = process.env.NODE_ENV === 'development';
  Sentry.init({
    dsn: _sentryDsn,
    tracesSampleRate: _isDebug || _isDev ? 1.0 : 0.1,
    debug: _isDebug,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeSend: _sentryBeforeSend as any,
  });
}

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

// #8 audit: augment FastifyRequest so the preParsing hook can attach raw
// bytes and verifyWebhook can consume them instead of re-serialising the
// already-parsed body (which loses exact byte order and whitespace).
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  auth,
  getDevLastEmailOtp,
  getDevLastMagicLink,
  getDevLastPhoneOtp,
  PHONE_TEMP_EMAIL_DOMAIN,
} from '@seed/auth';
import { db, jobs, models, nid, pool, usersApp, usersPii, workflows } from '@seed/db';
import {
  AUTH_EMAIL_QUEUE,
  CREDIT_COMMIT_QUEUE,
  CREDIT_REFUND_QUEUE,
  CreditService,
  InsufficientCreditsError,
  JOB_RUN_QUEUE,
  PHONE_BINDING_ENABLED,
  WelcomeGrantService,
  type WelcomeGrantResult,
  clusterKeyFor,
  enqueueViaOutbox,
  phoneHashFor,
  readBoolFlag,
  redisTlsOptions,
  shouldAttemptWelcomeEnrollment,
} from '@seed/credits';
import {
  countActiveJobsForUser,
  getJobForUser,
  isJobStatus,
  listJobsForUser,
  type JobStatus,
} from './jobs-list';
import { setupJobEventsRoute } from './job-events';
import { setupBillingRoutes } from './billing';
import { startTochkaRefundReconciliation } from './tochka-refund-reconciliation';
import { setupSubscriptionRoutes } from './subscriptions';
import { setupGalleryRoutes } from './gallery';
import { setupPublicGalleryRoutes } from './public-gallery';
import { setupBillingHistoryRoutes } from './billing-history';
import { setupSupportRoutes } from './support';
import { setupMeProfileRoutes } from './me-profile';
import { resolveDeviceId } from './device-cluster';
import { setupMeAccountRoutes } from './me-account';
import { setupMeEmailRoutes } from './me-email';
import { setupMeAttributionRoutes } from './me-attribution';
import { setupConsentRoutes } from './consent';
import { setupAdminRoutes, setupReportRoutes } from './admin';
import { setupAdminPanelRoutes } from './admin-panel';
import { setupPresetPacksRoutes } from './preset-packs';
import { setupPromptEnhancerRoutes, checkPerUserRateLimit } from './prompt-enhancer';
import { setupPromptStudioRoutes } from './prompt-studio';
import { setupBetaRoutes } from './beta';
import { setupStudioRoutes } from './studio';
import { setupSoundsRoutes } from './sounds';
import { boundedReadinessProbe } from './readiness';
import { setupCharacterRoutes } from './characters';
import { setupBoardRoutes } from './boards';
import { setupScriptRoutes } from './scripts';
import { setupScriptAssistRoutes, makeMaterialCompactor } from './script-assist';
import { setupScriptStructurizeRoutes } from './script-structurize';
import { setupShotPlanRoutes } from './shot-plan';
import { setupScriptShotPlanRoutes } from './script-shot-plan';
import { setupSceneObjectsRoutes } from './scene-objects';
import { egressFetch } from './egress-fetch';
import { setupStoryboardRoutes } from './storyboard';
import { enforceAccountSessionGate } from './session-gate';
import { resolveTrustProxy } from './trust-proxy';
import { setupAuthFrontDoorRoutes } from './auth-throttle';
import { releaseCommit } from './release-identity';
import { setupJobsRoutes } from './jobs-routes';
import { modelExposureBlockReason } from './model-exposure';
import { loadActivePricePointsByModel } from './pricing-resolver';
import { minUnitCredits } from '@seed/credits';
import { setupProjectRoutes } from './projects';
import { setupFolderRoutes } from './folders';
import { setupDeskRoutes } from './desk';
import { setupSearchRoutes } from './search';
import { welcomeMetricLevel } from './welcome-metrics';
import { runWelcomeProgression } from './welcome-progression';
import { assetProxyRateLimit, publicFeedRateLimit } from './public-rate-limits';
import { isRateLimitExempt } from './rate-limit';
import { OCTET_STREAM_PARSER_OPTIONS } from './upload-limits';
import { unitsForModel } from './units';
import { resolveDevHelpersEnabled } from './dev-helpers-config';
import { setGalleryItemFeatured } from './gallery-feature';
import {
  creditsGrantTotal,
  freeGrantsIssuedTotal,
  freeGrantsRefusedTotal,
  httpRequestDuration,
  httpRequestsTotal,
  startMetricsServer,
} from './metrics';

const PORT = Number(process.env.API_PORT ?? 4000);
const METRICS_PORT = Number(process.env.API_METRICS_PORT ?? 4001);
// Bind to all interfaces when running in a container (Prometheus scrapes from outside);
// loopback-only for local dev (the safe default).
const METRICS_HOST = process.env.API_METRICS_HOST ?? '127.0.0.1';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// LOW (audit): CORS sends credentials, so a localhost default in production is a
// misconfiguration that would let a local attacker page ride the user's cookies.
// Fail closed at boot — force CORS_ORIGIN to the real web origin(s) in prod.
if (process.env.NODE_ENV === 'production' && CORS_ORIGINS.some((o) => o.includes('localhost'))) {
  throw new Error(
    'CORS_ORIGIN must be the real web origin(s) in production (refusing localhost default)',
  );
}
const VERSION = '0.1.0';
const RELEASE_COMMIT = releaseCommit();

// Instrumented CreditService: every successful grant bumps the
// `seed_credits_grant_total{account}` counter so `/metrics` shows the
// inflow rate without us hand-rolling a tracking table. The base
// service does the actual ledger write; we just wrap it.
class InstrumentedCreditService extends CreditService {
  override async grant(input: Parameters<CreditService['grant']>[0]) {
    const row = await super.grant(input);
    creditsGrantTotal.labels(input.account).inc(input.amount);
    return row;
  }
}
const credits = new InstrumentedCreditService();
// Welcome-program grant engine (free-token Phase 1). Shares the instrumented
// credit service so welcome grants also bump seed_credits_grant_total{account}.
const welcome = new WelcomeGrantService({ credits });

// Fold a welcome-grant outcome into the Phase-1 telemetry counters. 'already_granted'
// is neither an issue nor a refusal — it's the idempotent no-op steady state.
function recordWelcome(result: WelcomeGrantResult): void {
  const metricLevel = welcomeMetricLevel(result.level);
  if (result.granted) {
    freeGrantsIssuedTotal.labels(metricLevel).inc();
  } else if (result.reason && result.reason !== 'already_granted') {
    freeGrantsRefusedTotal.labels(metricLevel, result.reason).inc();
  }
}

// --- Redis for rate-limiting + metrics queues ---
// Declared up here (before any route) so the /v1/jobs handler and the
// per-user rate-limited routes can all share one connection; it's reused
// for the BullMQ queue views on the metrics server below.
const metricsRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  ...redisTlsOptions(REDIS_URL),
});

// pino-pretty only when NODE_ENV === 'development'. Anything else
// (production, staging, undefined-via-CI) lands as newline-delimited
// JSON ready for any aggregator (Loki, CloudWatch, Vector).
const isDev = process.env.NODE_ENV === 'development';
const app = Fastify({
  // BL-7: derive the client IP from the trusted proxy hop so every per-IP
  // rate limit keys on the real caller (not the local Caddy) and can't be
  // spoofed via X-Forwarded-For from an untrusted connection. Defaults to
  // trusting loopback only; override with TRUST_PROXY (see trust-proxy.ts).
  trustProxy: resolveTrustProxy(),
  // We mint x-request-id ourselves to keep the same id observable in
  // worker logs (see onRequest hook below). Fastify's default uses an
  // in-memory counter, which doesn't survive a restart.
  genReqId: (req) => {
    const inbound = req.headers['x-request-id'];
    if (typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128) {
      // Strip everything outside [A-Za-z0-9._-]. Inbound newlines or
      // control chars would otherwise smuggle into pino's reqId
      // field and response header.
      const sanitized = inbound.replace(/[^A-Za-z0-9._-]/g, '');
      if (sanitized.length > 0) return sanitized;
    }
    return randomUUID();
  },
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  },
});

// #8 audit: Sentry Fastify error handler — wires Sentry to catch any
// unhandled errors thrown inside Fastify route handlers and report them
// with request context. No-op when SENTRY_DSN is absent (stub mode).
if (_sentryDsn) {
  Sentry.setupFastifyErrorHandler(app);
}

// Echo the request id back to clients so they can paste it into a
// support ticket and we can grep the same string out of api + worker
// logs (see outbox payload `_reqId` propagation below).
app.addHook('onRequest', async (req, reply) => {
  reply.header('x-request-id', req.id);
});

// #8 audit: capture raw body bytes before Fastify's JSON parser runs.
// verifyWebhook needs the exact original bytes to validate a future
// HMAC signature — re-serialising the parsed object would lose whitespace
// and key ordering, breaking the signature check.
// The preParsing hook receives the raw Node IncomingMessage stream; we
// collect chunks and attach them to req.rawBody for downstream use.
app.addHook('preParsing', async (req, _reply, payload) => {
  const chunks: Buffer[] = [];
  const readable = payload as NodeJS.ReadableStream;
  for await (const chunk of readable) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      // Uint8Array or similar typed array
      chunks.push(Buffer.from(chunk as ArrayBufferLike));
    }
  }
  req.rawBody = Buffer.concat(chunks);
  // Return a new readable that re-emits the same bytes so Fastify's
  // built-in JSON parser can still parse the body.
  const { Readable } = await import('node:stream');
  const replay = Readable.from([req.rawBody]);
  return replay as unknown as typeof payload;
});

// HTTP metrics: count + duration histogram, labelled by route TEMPLATE
// (not the raw URL) so we don't blow up the cardinality with one
// timeseries per jobId.
app.addHook('onResponse', async (req, reply) => {
  const route = req.routeOptions?.url ?? req.url.split('?')[0] ?? 'unknown';
  const status = String(reply.statusCode);
  const labels = { method: req.method, route, status };
  httpRequestsTotal.labels(labels).inc();
  // Fastify exposes elapsed time in ms via reply.elapsedTime since v5.
  httpRequestDuration.labels(labels).observe(reply.elapsedTime / 1000);
});

await app.register(helmet, { crossOriginResourcePolicy: { policy: 'cross-origin' } });
await app.register(cors, { origin: CORS_ORIGINS, credentials: true });

// Binary upload parser (studio audio lines + project assets). Fastify applies
// this parser ceiling before route-level bodyLimit, so it must be at least the
// largest binary route contract; individual routes may remain stricter.
app.addContentTypeParser(
  'application/octet-stream',
  OCTET_STREAM_PARSER_OPTIONS,
  (_req, body, done) => done(null, body),
);
await app.register(rateLimit, {
  // In dev/e2e every request (browser + the web server's own SSR fetches +
  // Playwright API calls) arrives from ONE ip — 100/min trips constantly and
  // surfaces as random spec failures. Production keeps the tight cap.
  max: process.env.NODE_ENV === 'production' ? 100 : 2000,
  timeWindow: '1 minute',
  // Never rate-limit the ops liveness/readiness probes (INF-16/17/18): a load
  // balancer or uptime monitor polls these continuously and a 429 would read as
  // "service down" and stall health-gated rollout. /metrics lives on a separate
  // 127.0.0.1 listener so it's already out of the public limiter's path.
  allowList: (req) => isRateLimitExempt(req.url),
  // We override per-route on the auth handler below.
});

// --- Better Auth handler bridge ---
async function toFetchRequest(req: FastifyRequest): Promise<Request> {
  const protocol = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = req.headers.host ?? `127.0.0.1:${PORT}`;
  const url = `${protocol}://${host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(','));
    else if (typeof v === 'string') headers.set(k, v);
  }
  const init: RequestInit = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method)) {
    const contentType = (headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('application/json')) {
      init.body = JSON.stringify(req.body ?? {});
    } else if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
      init.body = req.body as BodyInit;
    } else if (req.body != null) {
      // Fall back to JSON for object bodies without a declared content-type.
      init.body = JSON.stringify(req.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
  }
  return new Request(url, init);
}

async function sendFetchResponse(res: Response, reply: FastifyReply) {
  reply.status(res.status);
  res.headers.forEach((value, key) => {
    reply.header(key, value);
  });
  const text = await res.text();
  reply.send(text);
}

// Shared Better-Auth forward: translate the Fastify request to a fetch Request,
// run the auth handler, and pipe the response back.
const authForward = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const fetchReq = await toFetchRequest(req);
  const fetchRes = await auth.handler(fetchReq);
  await sendFetchResponse(fetchRes, reply);
};

// BL-6 (magic-link per-email) + BL-3 (anonymous-signup per-IP) abuse throttles.
// These specific routes take precedence over the `/api/auth/*` wildcard below.
setupAuthFrontDoorRoutes(app, { redis: metricsRedis, forward: authForward });

app.all('/api/auth/*', async (req, reply) => {
  await authForward(req, reply);
});

// --- Public routes ---
app.get('/health', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    app.log.error({ err }, 'health: db check failed');
    return reply.status(503).send({ ok: false, error: 'db-unreachable' });
  }
  return {
    ok: true,
    version: VERSION,
    commit: RELEASE_COMMIT,
    ts: new Date().toISOString(),
  };
});

// INF-17 readiness: distinct from /health (DB liveness), /ready also requires
// Redis (rate-limit + queue views). Health-gated rollout (INF-16) routes traffic
// to a new instance only once this is 200, so it returns per-dependency detail.
app.get('/ready', async (_req, reply) => {
  const checks: Record<string, boolean> = {};
  [checks.db, checks.redis] = await Promise.all([
    boundedReadinessProbe(() => pool.query('SELECT 1')),
    boundedReadinessProbe(() => metricsRedis.ping()),
  ]);
  if (!checks.db) app.log.error('ready: db check failed or timed out');
  if (!checks.redis) app.log.error('ready: redis check failed or timed out');
  const ok = checks.db && checks.redis;
  return reply
    .status(ok ? 200 : 503)
    .send({ ok, checks, version: VERSION, commit: RELEASE_COMMIT });
});

// --- Public asset proxy ---------------------------------------------------
// MinIO is bound to 127.0.0.1 only, so the raw object URLs it would hand out
// (http://127.0.0.1:9000/...) are unreachable from a user's browser. We stream
// generated images/videos back through the API origin (which IS public). The
// bucket is anonymously readable, so we proxy without credentials. Range is
// passed through verbatim — videos need 206/partial for scrubbing, and the
// upcoming editor depends on byte-range reads.
const MINIO_INTERNAL = (process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000').replace(/\/$/, '');
const ASSET_BUCKET = process.env.MINIO_BUCKET ?? 'seed-assets';
// Buckets the public proxy is allowed to expose: generated assets + the
// curated preset-preview media. Everything else in MinIO stays internal.
const PROXY_BUCKETS = [ASSET_BUCKET, 'seed-preset-previews'];
for (const bucket of PROXY_BUCKETS) {
  app.get<{ Params: { '*': string } }>(
    `/${bucket}/*`,
    // BL-9: own generous per-IP bucket so a media-heavy page load doesn't
    // exhaust the global 100/min budget shared with the rest of the API.
    { config: assetProxyRateLimit() },
    async (req, reply) => {
      const key = req.params['*'];
      if (!key || key.includes('..')) return reply.status(400).send({ error: 'bad_key' });
      const upstream = `${MINIO_INTERNAL}/${bucket}/${key}`;
      const range = req.headers['range'];
      const res = await fetch(upstream, {
        headers: typeof range === 'string' ? { range } : {},
      });
      if (res.status >= 400 || !res.body) {
        return reply.status(res.status === 404 ? 404 : 502).send({ error: 'asset_unavailable' });
      }
      reply.status(res.status); // 200 or 206
      for (const h of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
      ]) {
        const v = res.headers.get(h);
        if (v) reply.header(h, v);
      }
      reply.header('cache-control', 'public, max-age=86400, immutable');
      reply.header('accept-ranges', 'bytes');
      return reply.send(
        Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
      );
    },
  );
}

app.get('/v1/models', { config: publicFeedRateLimit() }, async () => {
  const rows = await db
    .select({
      id: models.id,
      family: models.family,
      variant: models.variant,
      displayName: models.displayName,
      kind: models.kind,
      unitKind: models.unitKind,
      maxResolution: models.maxResolution,
      maxDurationSeconds: models.maxDurationSeconds,
      capabilities: models.capabilities,
      providerModelId: models.providerModelId,
      providerEndpoint: models.providerEndpoint,
      // Median provider latency — drives the client-side progress ETA.
      expectedLatencyMsP50: models.expectedLatencyMsP50,
      // P-B2/DEC-3: minimum plan tier required for this model. The UI gates the
      // dropdown against the user's active plan using the shared seven-tier order.
      tierMin: models.tierMin,
    })
    .from(models)
    .where(eq(models.isActive, true))
    .orderBy(models.kind, models.id);
  // Use the same derived active set as estimate/submit. In particular, an
  // expired finance obligation is excluded here without mutating its DB row;
  // a model with other valid rows stays visible, while a model whose only
  // active rows are expired is hidden rather than exposing a route that will
  // necessarily refuse every price.
  const activePointsByModel = await loadActivePricePointsByModel(
    rows.map((row) => row.id),
    db,
  );
  const pricedModelIds = new Set(activePointsByModel.keys());

  // `is_active` is an operator/catalogue flag, not sufficient public proof. Do not
  // expose a model the job route will necessarily reject because its route,
  // capability bag, or workbook-derived cost is absent. Exact selector coverage is
  // still checked by estimate/submit and may return a deliberate config refusal.
  // `minUnitCredits` is projected from the same active workbook rows — the
  // cheapest per-unit rate across them, for client-side cheapest-first ordering
  // (pickers, defaults, the «Черновик» chip). Unpriced models are filtered out
  // above, so the rate is never null here.
  return rows
    .filter((row) => modelExposureBlockReason(row, pricedModelIds.has(row.id)) === null)
    .map(({ providerModelId: _providerModelId, providerEndpoint: _providerEndpoint, ...row }) => ({
      ...row,
      minUnitCredits: minUnitCredits(activePointsByModel.get(row.id) ?? []),
    }));
});

// --- Authenticated routes ---
// /v1/me used to upsert users_app + users_pii on every call, turning a
// read endpoint into a double-table mutating GET. Now it's a pure SELECT
// — the upsert moves into the first-call fast-path below, gated on the
// row actually being missing. After signup the rows exist forever, so
// subsequent /v1/me calls are zero-write.
class AccountDeletedError extends Error {}

// A phone-first signup carries a per-phone sentinel email (no real inbox) — it
// must never be stored or returned as a real contact address.
const stripSentinelEmail = (email: string | null): string | null =>
  email && email.endsWith(`@${PHONE_TEMP_EMAIL_DOMAIN}`) ? null : email;

/**
 * Lazily create users_app + users_pii on first authenticated call. Returns
 * `true` when it created the rows (a brand-new account this call), `false` when
 * they already existed. The welcome-program L0 grant is NOT written here — it is
 * applied in /v1/me via the welcome engine (with anti-farm cluster attribution),
 * so every registration path enrolls through one place.
 */
async function ensureUserRows(
  userId: string,
  email: string | null,
  displayName: string | null,
  emailVerified: boolean,
  phone: string | null,
  phoneVerified: boolean,
  isAnonymous: boolean,
): Promise<boolean> {
  const existing = await db
    .select({ id: usersApp.id, status: usersApp.status })
    .from(usersApp)
    .where(eq(usersApp.id, userId))
    .limit(1);
  // A deleted users_app row + a still-valid Better Auth session must
  // not be re-hydrated as if nothing happened: users_pii was hard
  // deleted for 152-ФЗ, so recreating an active state here would
  // either leak the old email back into the response (via the
  // session.user fallback) or leave the user logged into a hollow
  // record. Force them through support instead.
  if (existing[0]?.status === 'deleted') {
    throw new AccountDeletedError();
  }
  if (existing.length > 0) {
    // Better Auth owns the OTP verification state; mirror a newly bound,
    // verified number into the RU-PII record on the first /v1/me after binding.
    // This keeps billing/admin consumers of users_pii in sync with the session.
    if (phone && phoneVerified) {
      await db
        .update(usersPii)
        .set({ phone, phoneVerifiedAt: new Date() })
        .where(eq(usersPii.id, userId));
    }
    return false;
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(usersApp)
      .values({ id: userId, displayName, locale: 'ru' })
      .onConflictDoNothing({ target: usersApp.id });
    // Anonymous sessions carry the anonymous() plugin's placeholder address
    // (temp@<random>.com — a per-session-random domain, so it can't be
    // pattern-matched the way the phone sentinel is). It isn't a real
    // contact, so don't let it flow into users_pii as if it were one; we
    // KNOW it's fake here via isAnonymous directly.
    const realEmail = isAnonymous ? null : stripSentinelEmail(email);
    await tx
      .insert(usersPii)
      .values({
        id: userId,
        email: realEmail,
        emailVerifiedAt: realEmail && emailVerified ? new Date() : null,
        phone,
        phoneVerifiedAt: phone && phoneVerified ? new Date() : null,
      })
      .onConflictDoNothing({ target: usersPii.id });
  });
  return true;
}

app.get('/v1/me', async (req, reply) => {
  const fetchReq = await toFetchRequest(req);
  const session = await auth.api.getSession({ headers: fetchReq.headers });
  if (!session) return reply.status(401).send({ error: 'unauthenticated' });

  const userId = session.user.id;
  // phoneNumber/phoneNumberVerified come from the phoneNumber() plugin; the
  // plugin is conditionally mounted, so read them defensively off the session.
  const phoneUser = session.user as {
    phoneNumber?: string | null;
    phoneNumberVerified?: boolean | null;
  };
  const isAnonymous = Boolean((session.user as { isAnonymous?: boolean | null }).isAnonymous);
  const phoneVerified = Boolean(phoneUser.phoneNumberVerified);
  try {
    await ensureUserRows(
      userId,
      session.user.email ?? null,
      session.user.name ?? null,
      Boolean(session.user.emailVerified),
      phoneUser.phoneNumber ?? null,
      phoneVerified,
      isAnonymous,
    );
  } catch (err) {
    if (err instanceof AccountDeletedError) {
      return reply.status(401).send({ error: 'account_deleted' });
    }
    throw err;
  }

  const phoneBindingEnabled = await readBoolFlag(PHONE_BINDING_ENABLED, false);

  // Welcome-program progression (free-token Phase 1). Anonymous sessions are
  // hard-walled out (unlimited-signup farm vector). Failures here must NEVER
  // break /v1/me — the account stays fully functional if a grant hiccups.
  if (shouldAttemptWelcomeEnrollment(isAnonymous)) {
    try {
      const deviceId = resolveDeviceId(req, reply);
      const clusterKey = clusterKeyFor(deviceId, req.ip);
      // This must remain explicit: the L0 velocity bucket is keyed by the
      // trusted proxy-resolved client IP, never by an omitted/internal socket IP.
      const sourceIp = req.ip;
      const captchaHeader = req.headers['x-smartcaptcha-token'];
      const captchaToken = typeof captchaHeader === 'string' ? captchaHeader : undefined;
      // L0 is attempted on every authenticated /v1/me. This is required for
      // anonymous→real conversion, whose claim hook pre-creates users_app and
      // therefore makes ensureUserRows return created=false. Ledger/event
      // idempotency keeps retries harmless.
      // Read the binding flag before invoking grantL2; the service repeats the
      // check for direct callers, so a disabled flag cannot be bypassed.
      const phoneNumber = phoneUser.phoneNumber;
      await runWelcomeProgression({
        welcome,
        userId,
        clusterKey,
        sourceIp,
        email: session.user.email ?? null,
        captchaToken,
        phoneHash:
          phoneBindingEnabled && phoneVerified && phoneNumber ? phoneHashFor(phoneNumber) : null,
        record: recordWelcome,
        onError: (level, err) =>
          req.log.error({ err, userId, level }, 'welcome: grant failed (non-fatal)'),
      });
    } catch (err) {
      req.log.error({ err, userId }, 'welcome: progression failed (non-fatal)');
    }
  }

  return {
    user: {
      id: userId,
      // NOT null for anon — several other pages (settings/gallery/pricing/…)
      // pass this straight into AppShell's required `email: string` prop and
      // would crash on null. The anon() plugin's placeholder address is a non-
      // PII sentinel anyway; callers that care use `isAnonymous` instead (see
      // generate/boards/scenario/studio's "Гость" substitution).
      email: stripSentinelEmail(session.user.email ?? null),
      name: session.user.name ?? null,
      phone: phoneUser.phoneNumber ?? null,
      phoneVerified,
      isAnonymous,
    },
    session: { expiresAt: session.session.expiresAt },
    // Feature flags the web app reads (e.g. /settings gates the phone-binding
    // block on this). Defaults false — SMSC operators are unpaid, so the flow
    // ships dark.
    flags: { phoneBindingEnabled },
  };
});

app.post('/v1/auth/logout', async (req, reply) => {
  const fetchReq = await toFetchRequest(req);
  const fetchRes = await auth.handler(
    new Request(fetchReq.url.replace('/v1/auth/logout', '/api/auth/sign-out'), {
      method: 'POST',
      headers: fetchReq.headers,
    }),
  );
  await sendFetchResponse(fetchRes, reply);
});

// --- Credits (auth-gated) ---
async function requireSession(req: FastifyRequest, reply: FastifyReply) {
  const fetchReq = await toFetchRequest(req);
  const session = await auth.api.getSession({ headers: fetchReq.headers });
  if (!session) {
    reply.status(401).send({ error: 'unauthenticated' });
    return null;
  }
  // Defence-in-depth: deleted and banned accounts must not see any auth-gated
  // route, even when Better Auth still returns a stale session cookie.
  if (!(await enforceAccountSessionGate(session.user.id, reply))) return null;
  return session;
}

app.get('/v1/credits/balance', async (req, reply) => {
  const session = await requireSession(req, reply);
  if (!session) return;
  const balance = await credits.balanceFor(session.user.id);
  return balance;
});

app.get<{ Querystring: { limit?: string; cursor?: string } }>(
  '/v1/credits/transactions',
  async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const limitRaw = req.query.limit;
    const cursor = req.query.cursor;
    const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw) || 50)) : 50;
    const opts: { limit: number; cursor?: string } = { limit };
    if (cursor) opts.cursor = cursor;
    const page = await credits.transactionsFor(session.user.id, opts);
    return page;
  },
);

// --- Jobs (auth-gated) — POST reserve + GET list/detail ---
setupJobsRoutes(app, requireSession, { redis: metricsRedis, credits });

// --- Billing routes (ЮKassa) ---
setupBillingRoutes(app, requireSession);
const tochkaRefundReconciliation =
  process.env.NODE_ENV === 'production' &&
  (process.env.BILLING_PROVIDER ?? 'yookassa').toLowerCase() === 'tochka'
    ? startTochkaRefundReconciliation({ log: app.log, redis: metricsRedis })
    : null;
setupSubscriptionRoutes(app, requireSession);
setupGalleryRoutes(app, requireSession);
setupProjectRoutes(app, requireSession);
setupFolderRoutes(app, requireSession);
setupDeskRoutes(app, requireSession);
setupSearchRoutes(app, requireSession);
setupPublicGalleryRoutes(app, requireSession);
setupBillingHistoryRoutes(app, requireSession);
setupSupportRoutes(app);
setupMeProfileRoutes(app, requireSession, credits);
setupMeAccountRoutes(app, requireSession);
setupMeEmailRoutes(app, requireSession);
setupMeAttributionRoutes(app, requireSession);
setupConsentRoutes(app, requireSession);
setupAdminRoutes(app, requireSession);
setupAdminPanelRoutes(app, requireSession);
setupReportRoutes(app);
setupPresetPacksRoutes(app);
setupPromptEnhancerRoutes(app, requireSession, metricsRedis, { db });
setupPromptStudioRoutes(app, requireSession, metricsRedis);
setupBetaRoutes(app, requireSession, { redis: metricsRedis });
setupStudioRoutes(app, requireSession, { redis: metricsRedis });
setupSoundsRoutes(app, requireSession, { redis: metricsRedis });
setupCharacterRoutes(app, requireSession);
setupBoardRoutes(app, requireSession, { redis: metricsRedis });
setupSceneObjectsRoutes(app, requireSession, { spend: { redis: metricsRedis } });
// Material compaction is background AI work and must use the same egress-aware
// path as interactive Scenario assist; raw fetch fails from the production VM.
setupScriptRoutes(app, requireSession, { compactor: makeMaterialCompactor(egressFetch) });
setupScriptAssistRoutes(app, requireSession, { spend: { redis: metricsRedis } });
setupScriptStructurizeRoutes(app, requireSession, { spend: { redis: metricsRedis } });
setupShotPlanRoutes(app, requireSession, { spend: { redis: metricsRedis } });
setupScriptShotPlanRoutes(app, requireSession, { spend: { redis: metricsRedis } });
setupStoryboardRoutes(app, requireSession, { redis: metricsRedis });
const jobEvents = setupJobEventsRoute(app, requireSession, REDIS_URL);

// --- Test helpers for Playwright. In dev they're always on. In production
// they are off by default and require BOTH an explicit temporary
// `ALLOW_PROD_DEV_HELPERS=1` opt-in and DEV_ACCESS_SECRET. Every `/v1/dev/*`
// request must still carry a matching `x-dev-access` header — otherwise it 404s
// (hides existence). This keeps a long-lived secret from silently exposing
// magic-link capture, god-mode, or credit mutation routes after an audit. ---
const DEV_ACCESS_SECRET = process.env.DEV_ACCESS_SECRET;
const devHelpersEnabled = resolveDevHelpersEnabled({
  nodeEnv: process.env.NODE_ENV,
  devAccessSecret: DEV_ACCESS_SECRET,
  allowProdDevHelpers: process.env.ALLOW_PROD_DEV_HELPERS,
});
if (devHelpersEnabled) {
  if (process.env.NODE_ENV === 'production') {
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/v1/dev/')) return;
      const provided = req.headers['x-dev-access'];
      if (typeof provided !== 'string' || !DEV_ACCESS_SECRET || provided !== DEV_ACCESS_SECRET) {
        return reply.status(404).send({ error: 'not_found' });
      }
    });
  }
  // Optional ?email= returns that email's link (per-worker isolation so
  // parallel Playwright workers don't race on a single last-link slot).
  app.get<{ Querystring: { email?: string } }>(
    '/v1/dev/last-magic-link',
    async (req) => getDevLastMagicLink(req.query.email) ?? { url: null },
  );

  // Phone OTP capture (mirror of last-magic-link) so e2e can read the code.
  app.get<{ Querystring: { phone?: string } }>(
    '/v1/dev/last-phone-otp',
    async (req) => getDevLastPhoneOtp(req.query.phone) ?? { code: null },
  );

  // Email OTP capture (mirror of last-magic-link) so e2e can read the code.
  app.get<{ Querystring: { email?: string } }>(
    '/v1/dev/last-email-otp',
    async (req) => getDevLastEmailOtp(req.query.email) ?? { code: null },
  );

  // Reset a beta invite code to unused (for e2e test isolation).
  app.post<{ Body: { code?: string } }>('/v1/dev/reset-beta-invite', async (req, reply) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    if (!code) return reply.status(400).send({ error: 'code_required' });
    await pool.query(
      `UPDATE beta_invites SET used_at = NULL, used_by_user_id = NULL WHERE code = $1`,
      [code],
    );
    return { ok: true, code };
  });

  app.post<{ Body: { amount?: number } }>('/v1/dev/grant-credits', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const amount = Math.floor(Number(req.body?.amount ?? 0));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) {
      return reply.status(400).send({ error: 'invalid_amount' });
    }
    const idempotencyKey = `dev:grant:${session.user.id}:${nid()}`;
    await credits.grant({
      userId: session.user.id,
      amount,
      reason: 'dev.grant',
      account: 'pack_grant',
      origin: 'bonus',
      expiresAt: null,
      idempotencyKey,
    });
    const balance = await credits.balanceFor(session.user.id);
    return { granted: amount, balance };
  });

  // God mode (dev-only): top up a fat balance + skip onboarding in one call.
  // Called by the /login "god mode" button → /dev/enter interstitial so a tester
  // lands in /generate fully provisioned without the email round-trip.
  app.post('/v1/dev/godmode', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    await credits.grant({
      userId: session.user.id,
      amount: 100_000,
      reason: 'dev.godmode',
      account: 'pack_grant',
      origin: 'bonus',
      expiresAt: null,
      idempotencyKey: `dev:godmode:${session.user.id}:${nid()}`,
    });
    await pool.query(
      `UPDATE users_app
         SET onboarded_at = COALESCE(onboarded_at, now()),
             onboarding_answers = COALESCE(onboarding_answers, '{"godmode":true}'::jsonb),
             tier = 'max'
       WHERE id = $1`,
      [session.user.id],
    );
    // Unlock every tier-gated model (incl. video) by giving the dev account an
    // active top-tier subscription — the UI reads tier from /v1/billing/subscription
    // (not users_app.tier), so god-mode must seed a real sub. Idempotent: only
    // inserts when no active/trialing/past_due subscription already exists.
    await pool.query(
      `INSERT INTO subscriptions
         (id, user_id, tier, status, current_period_start, current_period_end,
          cancel_at_period_end, cycle_number, price_rub, credits_per_cycle, created_at)
       SELECT $1, $2, 'max', 'active', now(), now() + interval '30 days',
              false, 1, 0, 100000, now()
       WHERE NOT EXISTS (
         SELECT 1 FROM subscriptions
          WHERE user_id = $2 AND status IN ('active', 'trialing', 'past_due')
       )`,
      [nid(), session.user.id],
    );
    const balance = await credits.balanceFor(session.user.id);
    return { ok: true, balance };
  });

  // Mark/unmark a published item as featured on /showcase. Curation is a
  // human action; until an admin UI exists it happens via this dev endpoint
  // (or SQL in prod). Only the item's owner can feature it in dev.
  app.post<{ Body: { itemId?: string; featured?: boolean } }>(
    '/v1/dev/feature-item',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : '';
      if (!itemId) return reply.status(400).send({ error: 'item_id_required' });
      const featured = req.body?.featured !== false;
      const updated = await setGalleryItemFeatured(db, {
        itemId,
        userId: session.user.id,
        featured,
      });
      if (!updated) return reply.status(404).send({ error: 'not_found_or_private' });
      return { ok: true, featured };
    },
  );

  // Drain all available credits — lets e2e exercise the insufficient-credits
  // path now that new users start with a bonus balance.
  // Activate/deactivate catalog models by id (e2e: exercise the OpenRouter
  // multi-engine catalog, which ships isActive:false pending owner review).
  app.post<{ Body: { ids?: string[]; active?: boolean } }>(
    '/v1/dev/activate-models',
    async (req, reply) => {
      const ids = Array.isArray(req.body?.ids)
        ? req.body!.ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : [];
      if (!ids.length) return reply.status(400).send({ error: 'ids_required' });
      const active = req.body?.active !== false;
      const res = await pool.query(`UPDATE models SET is_active = $1 WHERE id = ANY($2::text[])`, [
        active,
        ids,
      ]);
      return { ok: true, updated: res.rowCount ?? 0, active };
    },
  );

  app.post('/v1/dev/burn-credits', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const bal = await credits.balanceFor(session.user.id);
    if (bal.available > 0) {
      const jobId = nid();
      await credits.reserve({
        userId: session.user.id,
        jobId,
        amount: bal.available,
        reason: 'dev.burn',
        idempotencyKey: `dev:burn:${jobId}`,
      });
      await credits.commit({
        userId: session.user.id,
        jobId,
        amount: bal.available,
        idempotencyKey: `dev:burn:${jobId}`,
      });
    }
    return { balance: await credits.balanceFor(session.user.id) };
  });
}

// --- Metrics server (127.0.0.1 only) ---
// metricsRedis is declared above (before route setup) and reused here for
// the BullMQ queue views — no second connection needed.
const metricsQueues = {
  [JOB_RUN_QUEUE]: new Queue(JOB_RUN_QUEUE, { connection: metricsRedis }),
  [CREDIT_COMMIT_QUEUE]: new Queue(CREDIT_COMMIT_QUEUE, { connection: metricsRedis }),
  [CREDIT_REFUND_QUEUE]: new Queue(CREDIT_REFUND_QUEUE, { connection: metricsRedis }),
  [AUTH_EMAIL_QUEUE]: new Queue(AUTH_EMAIL_QUEUE, { connection: metricsRedis }),
};
const metricsServer = startMetricsServer({
  port: METRICS_PORT,
  host: METRICS_HOST,
  log: app.log,
  queues: metricsQueues,
  spend: { redis: metricsRedis },
});

try {
  await app.listen({ host: process.env.API_HOST ?? '127.0.0.1', port: PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (sig: string): Promise<void> => {
  app.log.info({ sig }, 'shutting down');
  try {
    tochkaRefundReconciliation?.stop();
    await jobEvents.close();
    await metricsServer.close();
    await Promise.allSettled(Object.values(metricsQueues).map((q) => q.close()));
    await metricsRedis.quit();
    await app.close();
    // Release the PG pool last — app.close() has drained in-flight handlers,
    // so no query is mid-flight. Leaving it open leaks up to PG_POOL_MAX
    // connections for the idle-timeout window on every restart.
    await pool.end();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
