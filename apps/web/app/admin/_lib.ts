import { apiGet, apiBaseUrl } from '../../lib/server-api';

export { apiBaseUrl };

// --- response shapes (mirror apps/api/src/admin-panel.ts) ---
export interface CockpitResp {
  window: { days: number; since: string };
  revenue: {
    psp: string;
    note: string;
    grossRub: number;
    grossRubAllTime: number;
    refundedRub: number;
    orderCount: number;
    sbpSplit: null;
  };
  subscriptions: {
    mrrRub: number;
    arrRub: number;
    activeCount: number;
    trialingCount: number;
    byTier: Array<{ tier: string; count: number; mrrRub: number }>;
    churn: { approximate: boolean; churned: number; base: number; ratePct: number };
  };
  margin: {
    creditRubValue: number;
    usdToRub: { direct: number; openrouter: number };
    blended: {
      /** Revenue of the PRICED jobs only — the honest denominator for marginPct. */
      revenueRub: number;
      costRub: number;
      marginPct: number | null;
      approximate: boolean;
      /** Jobs served by a leg whose cost is recorded nowhere (see costUnknown). */
      costUnknownJobs: number;
    };
    perModel: Array<{
      modelId: string;
      model: { family: string; variant: string; displayName: string | null };
      kind: string;
      jobs: number;
      creditsSpent: number;
      revenueRub: number;
      costRub: number | null;
      marginPct: number | null;
      priced: boolean;
      approximate: boolean;
      /** The gap: jobs whose serving leg has no rate, e.g. the chain's 3rd leg. */
      costUnknown: { jobs: number; revenueRub: number; legs: string[] };
    }>;
  };
}

export interface ProviderBalancesResp {
  activeGateway: string;
  providers: Array<{
    provider: string;
    label: string;
    unit: 'usd' | 'credits' | null;
    balance: number | null;
    status: 'ok' | 'error' | 'no_api';
    low: boolean;
    active: boolean;
    dashboardUrl: string;
  }>;
  /** «Сценарий» assist tiers + live text-model routing (kie primary / OR fallback). */
  textModels?: Array<{
    id: string;
    labelRu: string;
    model: string;
    creditsPerCall: Record<string, number>;
    priceUsdPerMTok: { input: number; output: number };
    /** Admin ON/OFF switch (assist_tier_states) — off ⇒ assist calls 409 tier_disabled. */
    isActive: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
    route: {
      primary: 'kie' | 'openrouter';
      fallback?: 'openrouter';
      kiePriceUsdPerMTok?: { input: number; output: number };
    };
  }>;
}

export interface FunnelResp {
  window: { days: number; since: string };
  landingVisit: { available: boolean; reason: string };
  steps: Array<{ key: string; label: string; count: number; conv?: number | null }>;
  wowVideo: { count: number; conv: number | null };
  byChannel: Array<{ channel: string; signups: number }>;
  cohorts: Array<{
    cohort: string;
    channel: string;
    signups: number;
    attempted: number;
    activated: number;
    wowVideo: number;
    paid: number;
    revenueRub: number;
    refundedRub: number;
    retention: { d1: number; d7: number; d30: number };
  }>;
}

export interface GenerationResp {
  window: { days: number; since: string };
  daily: Array<{ day: string; kind: string; total: number; succeeded: number; failed: number }>;
  successRate: Array<{
    kind: string;
    total: number;
    succeeded: number;
    failed: number;
    refunded: number;
    successPct: number | null;
  }>;
  latency: Array<{
    modelId: string;
    model: { family: string; variant: string; displayName: string | null };
    kind: string;
    samples: number;
    p50Ms: number | null;
    p95Ms: number | null;
    expectedP50Ms: number;
    expectedP95Ms: number;
  }>;
  presetLeaderboard: { available: boolean; reason: string };
  fallback:
    | { available: true; total: number; fellBack: number; reason: string }
    | { available: false; reason: string };
}

export interface UsersListResp {
  rows: Array<{
    id: string;
    displayName: string | null;
    tier: string;
    status: string;
    createdAt: string;
    email: string | null;
  }>;
}

export interface UserDetailResp {
  user: {
    id: string;
    displayName: string | null;
    tier: string;
    status: string;
    locale: string;
    createdAt: string;
    onboardedAt: string | null;
    deletedAt: string | null;
  };
  contact: { email: string | null; phone: string | null };
  balance: { available: number; pending: number };
  subscription: {
    tier: string;
    status: string;
    currentPeriodEnd: string;
    priceRub: number;
    creditsPerCycle: number;
    cancelAtPeriodEnd: boolean;
  } | null;
  linkedAccounts: Array<{ providerId: string; createdAt: string }>;
  recentJobs: Array<{
    id: string;
    modelId: string;
    model: { family: string; variant: string; displayName: string | null } | null;
    status: string;
    creditsSpent: number;
    errorCode: string | null;
    queuedAt: string;
    finishedAt: string | null;
  }>;
  recentOrders: Array<{
    id: string;
    kind: string;
    amountRub: number;
    ourStatus: string;
    paidAt: string | null;
    createdAt: string;
  }>;
  creditHistory: Array<{
    createdAt: string;
    amount: number;
    account: string;
    reason: string;
    relatedOrderId: string | null;
    relatedJobId: string | null;
    origin: string | null;
    expiresAt: string | null;
  }>;
}

// O-1 (2026-09-02): the 'nanobanana'/'geminiomni' chain labels left the admin
// picker; 'laozhang' joined as the real leaf it always built. The API's
// KNOWN_GATEWAYS is the runtime source — this union mirrors it for the client.
export type Gateway = 'atlascloud' | 'openrouter' | 'laozhang' | 'kie';

export interface ModelsResp {
  creditRubValue: number;
  usdToRub: { direct: number; openrouter: number };
  gateways: readonly Gateway[];
  rows: Array<{
    id: string;
    provider: string;
    family: string;
    variant: string;
    kind: string;
    isActive: boolean;
    tierMin: string;
    unitKind: string;
    priceUsdPerUnit: number | null;
    marginPct: number | null;
    workbookMarginPct?: number | null;
    workbookFallbackMarginPct?: number | null;
    workbookPricePointCount?: number;
    pricingSource?: string;
    // A legacy row may still store a chain label ('nanobanana'/'geminiomni')
    // until an operator re-pins it; the API returns it verbatim and the select
    // renders the placeholder from effectiveGateway instead. Type it wide.
    gatewayOverride: Gateway | (string & {}) | null;
    fallbackGateway: Gateway | (string & {}) | null;
    effectiveGateway: string;
    fallbackUsage7d: { total: number; fellBack: number } | null;
  }>;
}

export interface AuditResp {
  rows: Array<{
    id: string;
    userId: string | null;
    action: string;
    payload: Record<string, unknown>;
    ip: string | null;
    ua: string | null;
    createdAt: string;
  }>;
}

// --- fetch (server-only) ---
export async function fetchCockpit(days: number): Promise<CockpitResp | null> {
  return (await apiGet<CockpitResp>(`/v1/admin/cockpit?days=${days}`)).data;
}
export async function fetchFunnel(days: number): Promise<FunnelResp | null> {
  return (await apiGet<FunnelResp>(`/v1/admin/funnel?days=${days}`)).data;
}
export async function fetchGeneration(days: number): Promise<GenerationResp | null> {
  return (await apiGet<GenerationResp>(`/v1/admin/generation?days=${days}`)).data;
}
export async function fetchUsers(q: string): Promise<UsersListResp | null> {
  return (await apiGet<UsersListResp>(`/v1/admin/users?q=${encodeURIComponent(q)}`)).data;
}
export async function fetchUserDetail(id: string): Promise<UserDetailResp | null> {
  return (await apiGet<UserDetailResp>(`/v1/admin/users/${encodeURIComponent(id)}`)).data;
}
export async function fetchModels(): Promise<ModelsResp | null> {
  return (await apiGet<ModelsResp>('/v1/admin/models')).data;
}
export async function fetchAudit(limit = 100): Promise<AuditResp | null> {
  return (await apiGet<AuditResp>(`/v1/admin/audit?limit=${limit}`)).data;
}
export async function fetchProviderBalances(): Promise<ProviderBalancesResp | null> {
  return (await apiGet<ProviderBalancesResp>('/v1/admin/provider-balances')).data;
}

// Pure formatters + window constants live in the client-safe _fmt module;
// re-export so server pages can keep importing them from here.
export { WINDOWS, parseDays, n, rub, pct, ms, dt } from './_fmt';
