import { priceModeForRequest, priceResolutionForRequest, type PriceModeModel } from '@seed/shared';
import type { AdapterRouteRequest } from '@seed/provider-byteplus';

function imageReferenceCount(
  params: Record<string, unknown>,
  referenceAssets: readonly string[],
): number {
  const imageUrls = params['imageUrls'];
  if (Array.isArray(imageUrls)) {
    const valid = imageUrls.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (valid.length > 0) return valid.length;
  }
  return referenceAssets.filter((url) => !/\.(mp4|mov|webm)(\?|$)/i.test(url)).length;
}

export function adapterRouteRequest(
  model: PriceModeModel,
  params: Record<string, unknown>,
  referenceAssets: readonly string[],
): AdapterRouteRequest {
  const resolution = priceResolutionForRequest(params, model.capabilities, model.kind);
  return {
    modelId: model.id,
    rung: resolution,
    mode: priceModeForRequest(model, params, imageReferenceCount(params, referenceAssets)),
  };
}
