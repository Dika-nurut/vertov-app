import { describe, expect, it } from 'vitest';
import {
  YOOKASSA_DEFAULT_IPS,
  ipInCidr,
  isAllowedWebhookIp,
  webhookIpAllowlist,
} from '../src/webhook-ip';

/**
 * SF-2 — YooKassa webhook source-IP allow-list (defense-in-depth on top of the
 * shared Bearer). The matcher must correctly include/exclude IPv4 CIDRs, bare
 * IPs, and IPv6 prefixes so the webhook handler can reject off-range callers.
 */
describe('SF-2: ipInCidr', () => {
  it('matches inside an IPv4 /27 and excludes outside', () => {
    expect(ipInCidr('185.71.76.5', '185.71.76.0/27')).toBe(true);
    expect(ipInCidr('185.71.76.31', '185.71.76.0/27')).toBe(true);
    expect(ipInCidr('185.71.76.40', '185.71.76.0/27')).toBe(false); // /27 = .0–.31
    expect(ipInCidr('185.71.77.5', '185.71.76.0/27')).toBe(false);
  });

  it('matches a bare IPv4 exactly', () => {
    expect(ipInCidr('77.75.156.11', '77.75.156.11')).toBe(true);
    expect(ipInCidr('77.75.156.12', '77.75.156.11')).toBe(false);
  });

  it('matches an IPv6 /32 prefix', () => {
    expect(ipInCidr('2a02:5180::1', '2a02:5180::/32')).toBe(true);
    expect(ipInCidr('2a02:5180:abcd:ef::9', '2a02:5180::/32')).toBe(true);
    expect(ipInCidr('2a02:5181::1', '2a02:5180::/32')).toBe(false);
  });

  it('does not cross address families', () => {
    expect(ipInCidr('1.2.3.4', '2a02:5180::/32')).toBe(false);
    expect(ipInCidr('2a02:5180::1', '185.71.76.0/27')).toBe(false);
  });
});

describe('SF-2: isAllowedWebhookIp against the published YooKassa ranges', () => {
  it('allows real YooKassa source IPs', () => {
    expect(isAllowedWebhookIp('185.71.76.1', YOOKASSA_DEFAULT_IPS)).toBe(true);
    expect(isAllowedWebhookIp('77.75.153.50', YOOKASSA_DEFAULT_IPS)).toBe(true);
    expect(isAllowedWebhookIp('77.75.156.35', YOOKASSA_DEFAULT_IPS)).toBe(true);
    expect(isAllowedWebhookIp('2a02:5180:dead:beef::1', YOOKASSA_DEFAULT_IPS)).toBe(true);
  });

  it('rejects an arbitrary attacker IP', () => {
    expect(isAllowedWebhookIp('203.0.113.7', YOOKASSA_DEFAULT_IPS)).toBe(false);
    expect(isAllowedWebhookIp('77.75.156.99', YOOKASSA_DEFAULT_IPS)).toBe(false);
  });
});

describe('SF-2: webhookIpAllowlist is opt-in', () => {
  it('is OFF (null) when unset or blank', () => {
    expect(webhookIpAllowlist({} as NodeJS.ProcessEnv)).toBeNull();
    expect(webhookIpAllowlist({ YOOKASSA_WEBHOOK_IPS: '  ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('"default" expands to the published ranges', () => {
    expect(webhookIpAllowlist({ YOOKASSA_WEBHOOK_IPS: 'default' } as NodeJS.ProcessEnv)).toEqual([
      ...YOOKASSA_DEFAULT_IPS,
    ]);
  });

  it('parses a custom comma list', () => {
    expect(
      webhookIpAllowlist({ YOOKASSA_WEBHOOK_IPS: '10.0.0.0/8, 1.2.3.4' } as NodeJS.ProcessEnv),
    ).toEqual(['10.0.0.0/8', '1.2.3.4']);
  });
});
