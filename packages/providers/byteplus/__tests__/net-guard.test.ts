import { describe, expect, it } from 'vitest';
import { EvolinkClient } from '../src/evolink-client';
import {
  AtlasCloudClient,
  BytePlusClient,
  KieClient,
  OpenRouterClient,
  ProviderError,
  SsrfError,
  assertUrlPublic,
  isBlockedIp,
} from '../src/index';

/**
 * BL-5 — provider `fetchAsset` downloads arbitrary provider-returned URLs.
 *
 * Pre-fix, `fetchAsset` fed any `z.string().url()` straight to `undici.request`,
 * so a `127.0.0.1` / `169.254.169.254` / internal URL became an SSRF/egress
 * channel from the worker. The guard fails closed BEFORE any socket. Every
 * blocked case below would resolve+connect on the pre-fix code.
 */
describe('BL-5: isBlockedIp covers the non-public ranges', () => {
  it.each([
    '0.0.0.0',
    '127.0.0.1',
    '10.0.0.1',
    '172.16.5.4',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '224.0.0.1', // multicast
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1', // link-local
    'fc00::1', // unique-local
    'fd12:3456::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.0.0.1',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])(
    'allows public %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it('fails closed on a non-IP string', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('BL-5: assertUrlPublic refuses unsafe targets before any socket', () => {
  it.each([
    'http://127.0.0.1/x',
    'http://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/internal',
    'http://192.168.0.1/admin',
    'http://[::1]:9000/x',
    'http://localhost/x', // resolves to loopback
  ])('throws SsrfError for %s', async (url) => {
    await expect(assertUrlPublic(url)).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a non-http(s) scheme', async () => {
    await expect(assertUrlPublic('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlPublic('gopher://x/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('allows a public IP literal URL', async () => {
    await expect(assertUrlPublic('https://93.184.216.34/asset.mp4')).resolves.toBeUndefined();
  });
});

describe('BL-5: client.fetchAsset is SSRF-guarded (no socket on a blocked URL)', () => {
  // Contract over EVERY gateway client: fetchAsset must refuse a provider-returned
  // URL that points at a blocked target, BEFORE any socket. This is the regression
  // guard that catches a future client (or a regressed one — BytePlus shipped on raw
  // `request` until this was fixed) dropping the guard. Port 9 (discard) would
  // hang/refuse, so a fast rejection proves the guard short-circuited the connection.
  const clients: Array<[string, () => { fetchAsset(url: string): Promise<unknown> }]> = [
    ['evolink', () => new EvolinkClient({ baseUrl: 'https://api.evolink.ai/v1', apiKey: 'sk-x' })],
    [
      'byteplus',
      () =>
        new BytePlusClient({
          baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
          apiKey: 'sk-x',
        }),
    ],
    [
      'atlascloud',
      () => new AtlasCloudClient({ baseUrl: 'https://api.atlascloud.ai/v1', apiKey: 'sk-x' }),
    ],
    [
      'openrouter',
      () => new OpenRouterClient({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x' }),
    ],
    ['kie', () => new KieClient({ baseUrl: 'https://api.kie.ai', apiKey: 'sk-x' })],
  ];

  it.each(clients)(
    '%s fetchAsset throws a non-retryable SSRF_BLOCKED ProviderError on a loopback URL',
    async (_name, make) => {
      let err: unknown;
      await make()
        .fetchAsset('http://127.0.0.1:9/secret')
        .catch((e) => {
          err = e;
        });
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError & { code?: string }).code).toBe('SSRF_BLOCKED');
      expect((err as ProviderError & { retryable?: boolean }).retryable).toBe(false);
    },
  );

  it.each(clients)('%s fetchAsset also blocks the cloud-metadata IP', async (_name, make) => {
    let err: unknown;
    await make()
      .fetchAsset('http://169.254.169.254/latest/meta-data/iam/security-credentials/')
      .catch((e) => {
        err = e;
      });
    expect(err).toBeInstanceOf(SsrfError);
  });
});
