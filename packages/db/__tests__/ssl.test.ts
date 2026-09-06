import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolvePgSsl } from '../src/ssl';

// Pure unit test — no DB connection. Guards the migration-critical contract that
// PGSSLMODE=verify-full against a managed provider pins the provider's CA
// (PGSSLROOTCERT) instead of silently failing or downgrading to no-verify.

const tmp = mkdtempSync(join(tmpdir(), 'pgssl-'));
const caPath = join(tmp, 'root.crt');
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMANAGEDCAFIXTURE\n-----END CERTIFICATE-----\n';
writeFileSync(caPath, CA_PEM);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('resolvePgSsl', () => {
  it('disables TLS when PGSSLMODE is unset or disable', () => {
    expect(resolvePgSsl({})).toBe(false);
    expect(resolvePgSsl({ PGSSLMODE: 'disable' })).toBe(false);
  });

  it('no-verify enables TLS without certificate verification', () => {
    expect(resolvePgSsl({ PGSSLMODE: 'no-verify' })).toEqual({ rejectUnauthorized: false });
  });

  it('verify-full + PGSSLROOTCERT pins the CA and verifies (rejectUnauthorized: true)', () => {
    const ssl = resolvePgSsl({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: caPath });
    expect(ssl).toEqual({ ca: CA_PEM, rejectUnauthorized: true });
  });

  it('verify-full WITHOUT a cert is a clear boot error, not a silent downgrade', () => {
    expect(() => resolvePgSsl({ PGSSLMODE: 'verify-full' })).toThrow(/PGSSLROOTCERT/);
  });

  it('verify-full with an unreadable cert path throws a clear error', () => {
    expect(() =>
      resolvePgSsl({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: join(tmp, 'missing.crt') }),
    ).toThrow(/could not be read/);
  });

  it('require verifies against the system store when no cert is pinned', () => {
    expect(resolvePgSsl({ PGSSLMODE: 'require' })).toEqual({ rejectUnauthorized: true });
  });

  it('require also honours a pinned CA when provided', () => {
    expect(resolvePgSsl({ PGSSLMODE: 'require', PGSSLROOTCERT: caPath })).toEqual({
      ca: CA_PEM,
      rejectUnauthorized: true,
    });
  });
});
