import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { modelKindEnum, providerEnum, tierEnum, unitKindEnum } from './enums';

export const models = pgTable(
  'models',
  {
    id: text('id').primaryKey(),
    provider: providerEnum('provider').notNull(),
    family: text('family').notNull(),
    variant: text('variant').notNull(),
    displayName: text('display_name'),
    kind: modelKindEnum('kind').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    tierMin: tierEnum('tier_min').notNull().default('free'),
    unitKind: unitKindEnum('unit_kind').notNull(),
    expectedLatencyMsP50: integer('expected_latency_ms_p50').notNull(),
    expectedLatencyMsP95: integer('expected_latency_ms_p95').notNull(),
    maxDurationSeconds: integer('max_duration_seconds'),
    maxResolution: text('max_resolution'),
    providerModelId: text('provider_model_id').notNull(),
    providerEndpoint: text('provider_endpoint').notNull(),
    capabilities: jsonb('capabilities').notNull().$type<Record<string, unknown>>().default({}),
    // Admin-editable routing overrides (PATCH /v1/admin/models/:id). Null means
    // "fall back to capabilities.forceGateway / the worker's default resolution" —
    // see getAdapter() in @seed/provider-byteplus and resolveGateways() in the worker.
    gatewayOverride: text('gateway_override'),
    fallbackGateway: text('fallback_gateway'),
    rightsModerationProvider: text('rights_moderation_provider').notNull().default('internal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('models_active_tier_idx').on(t.isActive, t.tierMin),
    index('models_kind_idx').on(t.kind),
  ],
);
