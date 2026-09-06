function firstString(params: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function declaredResolutions(
  capabilities: Record<string, unknown> | null | undefined,
): string[] | null {
  if (!capabilities || !Array.isArray(capabilities['resolutions'])) return null;
  return capabilities['resolutions'].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/**
 * Resolve the price-key rung without widening the shared helper into a full price
 * selector. An explicit empty `resolutions` list is a provider contract for one fixed
 * output, so crafted request values are pinned to `default`; video deliberately reads
 * only `resolution`, while image requests retain the legacy `quality` alias.
 */
export function priceResolutionForRequest(
  params: Record<string, unknown>,
  capabilities: Record<string, unknown> | null | undefined,
  kind?: string,
): string {
  const resolutions = declaredResolutions(capabilities);
  if (resolutions?.length === 0) return 'default';
  const aliases =
    kind === 'video' ? (['resolution'] as const) : (['resolution', 'quality'] as const);
  return firstString(params, aliases) ?? 'default';
}
