import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { redisTlsOptions } from '../src/redis-connection';

// Pure unit test — no live Redis. Guards PORT-4: the managed-Redis migration is
// config-only (rediss:// + optional private-CA pinning), local redis:// untouched.

const tmp = mkdtempSync(join(tmpdir(), 'redisca-'));
const caPath = join(tmp, 'redis-ca.crt');
const CA_PEM = '-----BEGIN CERTIFICATE-----\nREDISCAFIXTURE\n-----END CERTIFICATE-----\n';
writeFileSync(caPath, CA_PEM);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('redisTlsOptions (PORT-4)', () => {
  it('adds no TLS for a plain redis:// URL (local docker compose untouched)', () => {
    expect(redisTlsOptions('redis://127.0.0.1:6380', {})).toEqual({});
  });

  it('enables TLS for rediss:// (system CA) without pinning', () => {
    expect(redisTlsOptions('rediss://user:pw@mdb.yandexcloud.net:6380', {})).toEqual({ tls: {} });
  });

  it('pins the private CA (REDIS_CA_CERT) and verifies for managed Redis', () => {
    const opts = redisTlsOptions('rediss://user:pw@mdb.yandexcloud.net:6380', {
      REDIS_CA_CERT: caPath,
    });
    expect(opts).toEqual({ tls: { ca: CA_PEM, rejectUnauthorized: true } });
  });

  it('honours REDIS_TLS_SERVERNAME (SNI through a pooler/IP)', () => {
    const opts = redisTlsOptions('rediss://10.0.0.5:6380', {
      REDIS_CA_CERT: caPath,
      REDIS_TLS_SERVERNAME: 'mdb.yandexcloud.net',
    });
    expect(opts.tls?.servername).toBe('mdb.yandexcloud.net');
    expect(opts.tls?.ca).toBe(CA_PEM);
  });

  it('does NOT pin a CA for a non-TLS URL even if REDIS_CA_CERT is set', () => {
    expect(redisTlsOptions('redis://127.0.0.1:6380', { REDIS_CA_CERT: caPath })).toEqual({});
  });

  it('throws a clear error when REDIS_CA_CERT points at an unreadable file', () => {
    expect(() =>
      redisTlsOptions('rediss://host:6380', { REDIS_CA_CERT: join(tmp, 'missing.crt') }),
    ).toThrow(/could not be read/);
  });
});
