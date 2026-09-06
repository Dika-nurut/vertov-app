type OriginInput = {
  nodeEnv?: string;
  configuredOrigin?: string;
  requestOrigin?: string;
};

function parseOrigin(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the origin used for server-side redirects.
 *
 * Production must have an explicit configured origin; using `Host`/`Origin`
 * from a reverse-proxied request would let a caller choose the redirect host.
 * Development may fall back to its local request origin so disposable floors
 * remain usable. A malformed production value fails closed with `null`.
 */
export function resolveTrustedWebOrigin(input: OriginInput): string | null {
  const configured = parseOrigin(input.configuredOrigin);
  if (configured) return configured;
  if (input.nodeEnv === 'production') return null;
  return parseOrigin(input.requestOrigin);
}
