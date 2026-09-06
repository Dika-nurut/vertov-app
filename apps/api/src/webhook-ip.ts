import { isIP } from 'node:net';

/**
 * SF-2 — YooKassa webhook source-IP allow-list (defense-in-depth).
 *
 * The webhook's authenticity rests on a single shared Bearer token. As an extra
 * layer, when `YOOKASSA_WEBHOOK_IPS` is configured the handler also requires the
 * request to originate from a YooKassa notification range (the client IP is the
 * real caller — see BL-7 trustProxy). It is OPT-IN so a future change to
 * YooKassa's ranges can't silently break payments; ops enable it by setting
 * `YOOKASSA_WEBHOOK_IPS` (use `default` for the published ranges below).
 *
 * Published ranges: https://yookassa.ru/developers/using-api/webhooks
 */
export const YOOKASSA_DEFAULT_IPS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11',
  '77.75.156.35',
  '77.75.154.128/25',
  '2a02:5180::/32',
] as const;

/** Expand an IPv4/IPv6 literal to a 32/128-bit BigInt, or null if unparsable. */
function ipToBigInt(ip: string): { value: bigint; bits: 32 | 128 } | null {
  const host = ip.replace(/^\[|\]$/g, '');
  const fam = isIP(host);
  if (fam === 4) {
    const parts = host.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    let v = 0n;
    for (const o of parts) v = (v << 8n) | BigInt(o);
    return { value: v, bits: 32 };
  }
  if (fam === 6) {
    // Split off an embedded IPv4 tail (e.g. ::ffff:1.2.3.4) into two hextets.
    let head = host;
    let tailHextets: string[] = [];
    const v4m = head.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (v4m) {
      const v4 = ipToBigInt(v4m[1]!);
      if (!v4) return null;
      const n = Number(v4.value);
      tailHextets = [((n >>> 16) & 0xffff).toString(16), (n & 0xffff).toString(16)];
      head = head.slice(0, host.length - v4m[1]!.length).replace(/:$/, '') || '::';
    }
    const [left, right] = head.split('::') as [string, string?];
    const leftGroups = left ? left.split(':').filter((s) => s !== '') : [];
    const rightGroups = right !== undefined ? right.split(':').filter((s) => s !== '') : [];
    const all =
      right === undefined
        ? [...leftGroups, ...tailHextets]
        : [
            ...leftGroups,
            ...Array(8 - leftGroups.length - rightGroups.length - tailHextets.length).fill('0'),
            ...rightGroups,
            ...tailHextets,
          ];
    if (all.length !== 8) return null;
    let v = 0n;
    for (const g of all) {
      const n = parseInt(g, 16);
      if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
      v = (v << 16n) | BigInt(n);
    }
    return { value: v, bits: 128 };
  }
  return null;
}

/** True when `ip` falls inside the CIDR (or equals a bare IP). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  const network = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const a = ipToBigInt(ip);
  const b = ipToBigInt(network);
  if (!a || !b || a.bits !== b.bits) return false;
  const prefix = slash >= 0 ? Number(cidr.slice(slash + 1)) : a.bits;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > a.bits) return false;
  if (prefix === 0) return true;
  const shift = BigInt(a.bits - prefix);
  return a.value >> shift === b.value >> shift;
}

/** True when `ip` matches any entry in the allow-list. */
export function isAllowedWebhookIp(ip: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => ipInCidr(ip, entry));
}

/**
 * The configured webhook IP allow-list, or null when enforcement is OFF.
 * `YOOKASSA_WEBHOOK_IPS=default` expands to the published YooKassa ranges.
 */
export function webhookIpAllowlist(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.YOOKASSA_WEBHOOK_IPS?.trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'default') return [...YOOKASSA_DEFAULT_IPS];
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}
