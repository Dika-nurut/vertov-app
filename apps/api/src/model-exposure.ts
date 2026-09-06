/**
 * Public model exposure is a safety boundary, not a mirror of `is_active`.
 *
 * An active row without a real route, non-empty capability metadata, or an active
 * workbook price is not a selectable product: exposing it creates a false affordance
 * and lets the first user discover a paid failure after choosing it. The job route
 * still validates the exact requested configuration; this helper only decides whether
 * the broad public catalogue may mention the model at all.
 */
export interface ModelExposureCandidate {
  kind: unknown;
  providerModelId: unknown;
  providerEndpoint: unknown;
  capabilities: unknown;
}

export type ModelExposureBlock =
  | 'unsupported_kind'
  | 'missing_route'
  | 'missing_capabilities'
  | 'missing_active_price';

/**
 * Voice remains a parked schema kind until a real serializer/adapter and its
 * money contract exist. Keeping the check here prevents a future operator
 * activation from turning a known adapter throw into a public paid affordance.
 */
export function isExecutableGenerationKind(
  kind: unknown,
): kind is 'image' | 'image-edit' | 'video' {
  return kind === 'image' || kind === 'image-edit' || kind === 'video';
}

export function modelExposureBlockReason(
  model: ModelExposureCandidate,
  hasActivePrice: boolean,
): ModelExposureBlock | null {
  if (!isExecutableGenerationKind(model.kind)) return 'unsupported_kind';

  if (
    typeof model.providerModelId !== 'string' ||
    model.providerModelId.trim() === '' ||
    typeof model.providerEndpoint !== 'string' ||
    model.providerEndpoint.trim() === ''
  ) {
    return 'missing_route';
  }

  if (
    model.capabilities === null ||
    typeof model.capabilities !== 'object' ||
    Array.isArray(model.capabilities) ||
    Object.keys(model.capabilities).length === 0
  ) {
    return 'missing_capabilities';
  }

  return hasActivePrice ? null : 'missing_active_price';
}
