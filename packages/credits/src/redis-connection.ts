import { readFileSync } from 'node:fs';

/** TLS sub-options we attach to an ioredis connection for managed Redis. */
export interface RedisTlsOptions {
  tls?: { ca?: string; servername?: string; rejectUnauthorized?: boolean };
}

/**
 * Resolve the TLS options for a Redis connection from the `REDIS_URL` scheme
 * (and optional CA pinning). Spread the result into every `new IORedis(url, …)`
 * so the managed-Redis migration is config-only.
 *
 * - `redis://…`  → `{}` (no TLS) — local docker compose is untouched.
 * - `rediss://…` → `{ tls: {…} }`. ioredis already enables TLS and reads the URL
 *   password for `rediss://`, so for a publicly-trusted CA this is config-only.
 *   But managed Redis on a Russian cloud (Yandex Cloud, Selectel) presents a
 *   **private** CA absent from the system trust store, so the default handshake
 *   fails verification. `REDIS_CA_CERT` (a path) pins that CA and turns on
 *   `rejectUnauthorized`; `REDIS_TLS_SERVERNAME` overrides SNI when connecting
 *   through a pooler/IP.
 */
export function redisTlsOptions(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): RedisTlsOptions {
  let isTls: boolean;
  try {
    isTls = new URL(url).protocol === 'rediss:';
  } catch {
    isTls = url.startsWith('rediss://');
  }
  if (!isTls) return {};

  const tls: { ca?: string; servername?: string; rejectUnauthorized?: boolean } = {};

  const caPath = env.REDIS_CA_CERT?.trim();
  if (caPath) {
    try {
      tls.ca = readFileSync(caPath, 'utf8');
    } catch (err) {
      throw new Error(
        `REDIS_CA_CERT is set to "${caPath}" but the CA file could not be read: ` +
          `${(err as Error).message}`,
      );
    }
    tls.rejectUnauthorized = true;
  }

  const servername = env.REDIS_TLS_SERVERNAME?.trim();
  if (servername) tls.servername = servername;

  return { tls };
}
