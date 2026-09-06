/**
 * Post-login destination from a `?next=` query value.
 *
 * Deep links into /generate (a landing-bar prompt, a preset card) survive the
 * login round-trip via /login?next=<path>. Only a same-origin RELATIVE path is
 * honored — anything absolute or protocol-relative ("//evil.com") would be an
 * open redirect, so it falls back to /generate.
 */
export function loginNextTarget(search: string): string {
  const next = new URLSearchParams(search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) {
    return next;
  }
  return '/generate?onboarding=1';
}
