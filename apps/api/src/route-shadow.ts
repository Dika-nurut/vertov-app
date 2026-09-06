import { CHAIN_RELAY_EXPANSIONS } from '@seed/shared';
import { selectRoute, type RouteRequest, type RouteDecision } from '@seed/shared/select-route';
import { executableIdentity, type CatalogueEntry, type CostLeg } from '@seed/db';

export interface ShadowRouteLogger {
  info(bindings: Record<string, unknown>, message?: string): void;
  warn(bindings: Record<string, unknown>, message?: string): void;
}

export interface ShadowRouteInput {
  jobId: string;
  modelId: string;
  entry: CatalogueEntry;
  request: Omit<RouteRequest, 'entry'>;
  now: Date;
  legacyChoice: string;
  apiForcedGateway: string | null;
  logger: ShadowRouteLogger;
  selector?: typeof selectRoute;
}

function isCostLeg(leg: CostLeg | { gateway: string }): leg is CostLeg {
  return 'relay' in leg;
}

function legacyPrimaryGateway(legacyChoice: string): string | null {
  if (!legacyChoice) return null;
  const chain = CHAIN_RELAY_EXPANSIONS[legacyChoice as keyof typeof CHAIN_RELAY_EXPANSIONS];
  return chain ? chain[0]!.replace('-official', '') : legacyChoice.toLowerCase();
}

function serializedDecision(decision: RouteDecision) {
  return {
    ordered: decision.ordered.map((candidate) => ({
      gateway: candidate.leg.relay.toLowerCase(),
      executableIdentity: candidate.executableIdentity,
      landedRubTotal: candidate.landedRubTotal,
    })),
    rejected: decision.rejected.map((rejection) => ({
      gateway: isCostLeg(rejection.leg) ? rejection.leg.relay.toLowerCase() : rejection.leg.gateway,
      executableIdentity: isCostLeg(rejection.leg)
        ? executableIdentity(rejection.leg)
        : rejection.leg.executableIdentity,
      reason: rejection.reason,
      detail: rejection.detail,
      ...(rejection.unknownKind ? { unknownKind: rejection.unknownKind } : {}),
    })),
  };
}

/** Run the route selector as an informational, swallowed shadow calculation. */
export function emitShadowRoute(input: ShadowRouteInput): void {
  try {
    const decision = (input.selector ?? selectRoute)(
      { entry: input.entry, ...input.request },
      input.now,
    );
    const serialized = serializedDecision(decision);
    const chosenGateway = serialized.ordered[0]?.gateway ?? null;
    const legacyGateway = legacyPrimaryGateway(input.legacyChoice);
    input.logger.info(
      {
        shadowRoute: {
          jobId: input.jobId,
          modelId: input.modelId,
          rung: input.entry.rung,
          chosen: serialized.ordered[0]?.executableIdentity ?? null,
          legacyChoice: legacyGateway ?? 'legacy_not_statically_knowable',
          agrees: legacyGateway === null ? null : chosenGateway === legacyGateway,
          apiForcedGateway: input.apiForcedGateway,
          ...serialized,
        },
      },
      'route-selection shadow',
    );
  } catch (err) {
    input.logger.warn(
      {
        shadowRouteError: {
          jobId: input.jobId,
          modelId: input.modelId,
          error: err instanceof Error ? err.message : String(err),
        },
      },
      'route-selection shadow failed',
    );
  }
}
