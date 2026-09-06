import { readFileSync } from 'node:fs';

/**
 * The `ssl` option we hand to `pg.Pool`. `false` disables TLS; otherwise we
 * always set `rejectUnauthorized` explicitly and optionally pin a CA bundle.
 */
export type PgSslConfig = false | { rejectUnauthorized: boolean; ca?: string };

/**
 * Resolve the Postgres pool `ssl` option from `PGSSLMODE` (+ `PGSSLROOTCERT`).
 *
 * | PGSSLMODE              | result                                              |
 * | --------------------- | --------------------------------------------------- |
 * | unset / `disable`     | `false` — no TLS (local docker compose)             |
 * | `no-verify`           | `{ rejectUnauthorized: false }` — TLS, cert ignored |
 * | `require`             | TLS, verify against the CA cert if given, else system store |
 * | `verify-full`         | TLS, **must** pin a CA via `PGSSLROOTCERT`          |
 *
 * Why the CA matters: managed Postgres on a Russian cloud (Yandex Cloud,
 * Selectel) presents a **private** CA that is not in the OS trust store. Plain
 * `ssl: true` verifies against the system store and therefore fails on those
 * providers, which historically pushed operators to the weaker `no-verify`.
 * `PGSSLROOTCERT` points at the provider's downloaded root cert so `verify-full`
 * works for real. We fail fast (clear boot error) when `verify-full` is asked
 * for without a cert, rather than silently downgrading.
 */
export function resolvePgSsl(env: NodeJS.ProcessEnv = process.env): PgSslConfig {
  const mode = env.PGSSLMODE;
  if (!mode || mode === 'disable') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };

  const certPath = env.PGSSLROOTCERT?.trim();
  if (certPath) {
    let ca: string;
    try {
      ca = readFileSync(certPath, 'utf8');
    } catch (err) {
      throw new Error(
        `PGSSLROOTCERT is set to "${certPath}" but the CA file could not be read: ` +
          `${(err as Error).message}`,
      );
    }
    return { ca, rejectUnauthorized: true };
  }

  if (mode === 'verify-full') {
    throw new Error(
      'PGSSLMODE=verify-full requires PGSSLROOTCERT to point at the database CA ' +
        'certificate (managed providers use a private CA absent from the system trust ' +
        'store). Set PGSSLROOTCERT, or use PGSSLMODE=require for system-CA verification.',
    );
  }

  // require, without a pinned cert: TLS verified against the system trust store.
  return { rejectUnauthorized: true };
}
