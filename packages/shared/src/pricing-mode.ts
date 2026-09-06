import { resolveBoardModelContract } from './board-contract';

export interface PriceModeModel {
  id: string;
  kind: string;
  capabilities?: Record<string, unknown> | null;
}

/**
 * Does this request carry an input image at all — a typed frame slot (Boards), a
 * legacy `imageUrls` list (/generate), or a reference that exists but has not
 * rendered yet (the Run All count)? Presence is the whole question here; how
 * many and which one are the reference band's business.
 */
function carriesInputImage(params: Record<string, unknown>, referenceCount: number): boolean {
  const frames = params['frameImages'];
  if (Array.isArray(frames) && frames.length > 0) return true;
  const imageUrls = params['imageUrls'];
  if (Array.isArray(imageUrls) && imageUrls.some((u) => typeof u === 'string' && u.length > 0)) {
    return true;
  }
  return referenceCount > 0;
}

/**
 * The generation mode a request will be SERVED in — the price dimension finance
 * calls `mode`.
 *
 * It is derived from the model's CATALOGUE contract (`resolveBoardModelContract`),
 * not from the route contract in `byteplusRouteContracts`. That distinction is the
 * whole correctness of this function: Wan's primary route contract declares
 * `imageRole: 'none'` (its kie t2v route takes no frame) and seedream has no route
 * contract at all, so a route-derived mode would call a framed Wan job `t2v`, miss
 * the signed i2v row, and keep charging the legacy 163/244. The catalogue is what
 * says what the MODEL accepts; the route only says which leg serves it.
 *
 * A frame-role model carrying `videoUrls` as well is still `i2v` — the adapter
 * ignores the video there and renders from the frame, so pricing it as a video
 * edit would charge for a configuration nobody serves.
 */
export function priceModeForRequest(
  model: Pick<PriceModeModel, 'id' | 'kind' | 'capabilities'>,
  params: Record<string, unknown>,
  referenceCount: number,
): string {
  const contract = resolveBoardModelContract({
    id: model.id,
    kind: model.kind as 'image' | 'image-edit' | 'video' | 'voice',
    capabilities: model.capabilities ?? null,
  });
  // Voice (and anything the contract cannot read) has no mode dimension: 'any'
  // matches every row, which is exactly the pre-mode behaviour.
  if (!contract) return 'any';
  const withImage = carriesInputImage(params, referenceCount);
  // A model that declares NO image input cannot be in an image mode, whatever the
  // request carries. Grok is the live case: `frames: []` because its kie route is
  // text-to-video only, so a crafted `imageUrls` on it is a request the adapter will
  // refuse — and calling it `i2v` would go looking for an i2v price for a
  // configuration that does not exist rather than pricing the job we can serve.
  const acceptsImage = contract.imageInput.role !== 'none';
  if (contract.mode === 'image') return withImage && acceptsImage ? 'i2i' : 't2i';
  if (!withImage || !acceptsImage) return 't2v';
  return contract.imageInput.role === 'reference' ? 'r2v' : 'i2v';
}
