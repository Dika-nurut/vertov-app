import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../schema/index';
import { resolvePgSsl } from './ssl';

// Load .env from the repo root regardless of cwd.
const here = fileURLToPath(new URL('.', import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env') });

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const POOL_MAX = Number(process.env.PG_POOL_MAX ?? 20);
const IDLE_MS = Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000);
const CONN_MS = Number(process.env.PG_CONN_TIMEOUT_MS ?? 10_000);
const SSL = resolvePgSsl(process.env);

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: POOL_MAX,
  idleTimeoutMillis: IDLE_MS,
  connectionTimeoutMillis: CONN_MS,
  ssl: SSL,
});

// node-postgres emits background/idle connection failures on the Pool itself.
// Without a listener, a database restart becomes an unhandled EventEmitter
// error and terminates every API/worker process. Keep the process alive so its
// bounded readiness probe can return 503 and the pool can reconnect after the
// database recovers.
pool.on('error', (error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'postgres_pool_error',
      message: error.message,
      code: (error as Error & { code?: string }).code,
    }),
  );
});

export const db = drizzle(pool, { schema });
export * from '../schema/index';
export { schema };
export { COST_LEG_FILE, costLegFile } from './cost-legs-data';
export {
  buildCatalogue,
  entryKey,
  servingModelId,
  splitModelId,
  type CatalogueEntry,
} from './price-catalogue';
export {
  configKey,
  executableIdentity,
  parseCostLegs,
  type CostLeg,
  type CostLegFile,
  type CostLegRole,
  type Mode,
} from './cost-legs';
export { costCatalogue } from './cost-catalogue';
export { nid } from './id';
export {
  FREE_MEDIA_RETENTION_MS,
  hasPaidMediaStorage,
  lockMediaStorageUser,
  mediaExpiresAt,
} from './media-retention';
export {
  PLAN_ACCESS_STATUSES,
  resolveLivePlanSubscription,
  resolveUserPlanTier,
  type PlanSubscription,
  type PlanTier,
} from './plan-access';
export {
  FALLBACK_MARGIN_FLOOR,
  DURATION_FLOOR_EXCEPTIONS,
  activeMarginExceptions,
  assertNoExpiredMarginExceptions,
  expiredMarginExceptions,
  marginFloorForRole,
  PRIMARY_MARGIN_FLOOR,
  WORST_DURATION_MARGIN_FLOOR,
  type ExpiringMarginException,
} from './margin-floors';
export {
  EXPIRING_PRICE_OBLIGATIONS,
  activePriceObligations,
  assertNoExpiredPriceObligations,
  expiredPriceObligationForPoint,
  expiredPriceObligations,
  type ExpiringPriceObligation,
  type PricePointObligationIdentity,
} from './price-obligations';
export {
  creditFloorRub,
  fallbackGatewayOf,
  GATEWAY_FX_RUB,
  gatewayFamilyOf,
  matchesPricePointSeed,
  modelBreakEven,
  pricePointBreakEven,
  realGateway,
  realGatewayFamily,
  type BreakEvenLeg,
  type BreakEvenModel,
  type BreakEvenResult,
  type GatewayFamily,
  type PricePointForBreakEven,
} from './price-breakeven';
export {
  WORKBOOK_SSOT,
  workbookCostForPoint,
  workbookEntryForPoint,
  workbookGatewayFamily,
  workbookReferenceCost,
  workbookReferencePoint,
  workbookReferencePointForGateway,
  type WorkbookGatewayFamily,
  type WorkbookPricePointCost,
} from './workbook-cost-model';
export {
  OFFICIAL_LEG_DAILY_CAP_KEY,
  OFFICIAL_LEG_DAY_WINDOW_MS,
  OFFICIAL_LEG_FX_RUB,
  OFFICIAL_LEG_MONTHLY_CAP_KEY,
  OFFICIAL_LEG_MONTH_WINDOW_MS,
  hasOfficialLegHeadroom,
  officialLegCostRub,
  officialLegRevenueRub,
  parseCapRub,
  withProspectiveLoss,
  type OfficialLegCaps,
  type OfficialLegSpendWindows,
} from './official-leg-budget';
export { readConservativeCreditFloorRub, type DbRunner } from './credit-floor';
export {
  costedLegs,
  landedCostRub,
  landedRubPerUsd,
  upstreamsFor,
  usdAtReferenceCount,
  type CostedLeg,
  type CostedLegOptions,
} from './leg-cost';
export {
  COST_FRESHNESS_MAX_AGE_DAYS,
  COST_FRESHNESS_MAX_AGE_MS,
  COST_FRESHNESS_REPRICED_MAX_AGE_DAYS,
  COST_FRESHNESS_REPRICED_MAX_AGE_MS,
  VENDOR_REPRICING_HISTORY,
  costFreshness,
  staleCostLegs,
  type CostFreshnessResult,
  type VendorRepricingRecord,
} from './cost-freshness';
export {
  readOfficialLegCaps,
  readOfficialLegSpend,
  releaseOfficialLegSpend,
  reserveOfficialLegSpend,
  settleOfficialLegSpend,
  sweepUnsettledOfficialLegSpend,
  type OfficialLegReservation,
  type OfficialLegReservationResult,
  type OfficialLegSettlement,
  type OfficialLegSettleResult,
} from './official-leg-ledger';
export {
  ROUTE_HEALTH_FAILURE_THRESHOLD,
  ROUTE_HEALTH_TTL_MS,
  beginRouteAttempt,
  readRouteAttemptObservations,
  readRouteAttemptByProvider,
  readRouteAttemptRecovery,
  readRouteLegHealth,
  routeLegHealthIsHealthy,
  recordRouteAttemptAccepted,
  recordRouteAttemptAmbiguous,
  recordRouteAttemptDefinitiveFailure,
  recordRouteAttemptOutcome,
  recordRouteLegSubmitFailure,
  recordRouteLegSubmitSuccess,
  type BeginRouteAttemptInput,
  type RouteAttemptObservation,
  type RouteAttemptRecovery,
  type RouteLegHealthSnapshot,
} from './route-attempt-journal';
