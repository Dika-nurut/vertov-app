/**
 * BL-12 — fail-closed auth configuration.
 *
 * Kept deliberately dependency-free (no `better-auth`/`@seed/db` imports) so the
 * boot assertions are unit-testable without standing up the whole auth graph or
 * a database connection.
 */

/** The dev placeholder secret shipped in `.env.example` — forbidden in prod. */
export const DEV_AUTH_SECRET = 'dev-secret-change-me';

type SecretEnv = { NODE_ENV?: string; BETTER_AUTH_SECRET?: string };
type CookieEnv = { NODE_ENV?: string; BETTER_AUTH_URL?: string };

const isProd = (env: { NODE_ENV?: string }): boolean =>
  (env.NODE_ENV ?? '').toLowerCase() === 'production';

/**
 * Resolve `BETTER_AUTH_SECRET`. Refuses to boot in production with the dev
 * default or an empty/whitespace value — a known or leaked secret lets anyone
 * forge a valid session cookie. Outside production the dev default stands so
 * local/e2e flows keep working with no config.
 */
export function resolveAuthSecret(env: SecretEnv = process.env as SecretEnv): string {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (isProd(env) && (!secret || secret === DEV_AUTH_SECRET)) {
    throw new Error(
      'BETTER_AUTH_SECRET must be set to a strong, non-default value in production — ' +
        'refusing to boot (the dev default / empty secret makes session cookies forgeable).',
    );
  }
  return secret || DEV_AUTH_SECRET;
}

/**
 * Whether session cookies must carry the `Secure` flag. Forced **on** in
 * production regardless of how `BETTER_AUTH_URL` is written, so a stray
 * `http://` baseURL can never ship a non-Secure session cookie. Outside
 * production it tracks an `https://` public URL (and stays off for the plain
 * http dev/e2e origin so the magic-link cookie still rides over http).
 */
export function shouldUseSecureCookies(env: CookieEnv = process.env as CookieEnv): boolean {
  if (isProd(env)) return true;
  return (env.BETTER_AUTH_URL ?? '').startsWith('https://');
}
