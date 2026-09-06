/**
 * Trusted-origin helpers. Deliberately side-effect free so it can be unit
 * tested without booting Better Auth (importing `@seed/auth` opens DB pools).
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * Is this origin a loopback address?
 *
 * Matched on the PARSED HOSTNAME, not a substring: `https://localhost.evil.com`
 * is a real remote host and must not be treated as loopback, while
 * `http://127.0.0.1:3000` and `http://[::1]` must. A value `new URL()` cannot
 * parse falls back to a pattern match so a malformed entry fails closed
 * (treated as loopback → rejected in production) rather than silently open.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    // A scheme-less "localhost:3000" still PARSES — as protocol "localhost:"
    // with an empty hostname — so an empty host means "not really a URL" and
    // must fall through to the pattern check rather than report "not loopback".
    const host = new URL(origin).hostname.toLowerCase();
    if (host) return LOOPBACK_HOSTS.has(host);
  } catch {
    // fall through to the pattern check below
  }
  return /(^|\/\/)\[?(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\]?(:|\/|$)/i.test(origin);
}
