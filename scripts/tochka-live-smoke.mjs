#!/usr/bin/env node
/**
 * Tochka live payment smoke test (launch plan item #8).
 *
 * Creates a real subscription order for the Старт tier, then a real 299 RUB
 * credit-pack order; opens both confirmation URLs, waits for each webhook to
 * grant credits, then refunds both orders. Requires:
 *
 *   - A running API with BILLING_PROVIDER=tochka and real Tochka credentials
 *   - A session cookie for a test user (TOCHKA_SMOKE_COOKIE env var)
 *   - An admin session cookie for the refund step (TOCHKA_SMOKE_ADMIN_COOKIE)
 *   - The webhook endpoint reachable from Tochka (not localhost)
 *
 * Usage: TOCHKA_SMOKE_EXPECTED_RELEASE=<full SHA> TOCHKA_SMOKE_MAX_RUB=898 \
 *   node scripts/tochka-live-smoke.mjs
 * Owner approval required: this spends exactly 599 RUB for Старт plus 299 RUB
 * for the one-time pack (898 RUB total). The explicit ceiling is required so a
 * later price/catalog change cannot silently raise the spend. The script fails
 * closed if production does not expose those exact active catalog rows.
 */

// The public site edge proxies the Fastify API at /v1/* on the root origin.
// `/api` is the Next.js app namespace and therefore makes `/api/v1/*` a web
// 404. Override this with the dedicated API origin when exercising that edge.
const API_URL = (process.env.SMOKE_API_URL ?? 'https://vertov.space').replace(/\/+$/, '');
const COOKIE = process.env.TOCHKA_SMOKE_COOKIE;
const ADMIN_COOKIE = process.env.TOCHKA_SMOKE_ADMIN_COOKIE;
const EXPECTED_RELEASE = process.env.TOCHKA_SMOKE_EXPECTED_RELEASE?.trim();
const MAX_SPEND_RUB = Number(process.env.TOCHKA_SMOKE_MAX_RUB ?? '');
const POLL_TIMEOUT_MS = Number(process.env.TOCHKA_SMOKE_TIMEOUT_MS ?? 180_000);
const POLL_INTERVAL_MS = Number(process.env.TOCHKA_SMOKE_POLL_MS ?? 5_000);
const REQUEST_TIMEOUT_MS = Number(process.env.TOCHKA_SMOKE_REQUEST_TIMEOUT_MS ?? 15_000);
const START_TIER = 'start';
const START_PRICE_RUB = 599;
const PACK_PRICE_RUB = 299;
const PLANNED_SPEND_RUB = START_PRICE_RUB + PACK_PRICE_RUB;

const parsedApiUrl = new URL(API_URL);
if (parsedApiUrl.protocol !== 'https:') {
  console.error('SMOKE_API_URL must use HTTPS; refusing to send session cookies over plain HTTP.');
  process.exit(1);
}

if (!COOKIE || !ADMIN_COOKIE) {
  console.error('Set TOCHKA_SMOKE_COOKIE and TOCHKA_SMOKE_ADMIN_COOKIE before running.');
  console.error('Both are Better Auth session cookies from logged-in browser tabs,');
  console.error(
    'copied via DevTools → Application → Cookies; never commit or paste them into evidence.',
  );
  console.error('The admin cookie is used only for the refund step.');
  console.error(
    'Owner approval required — also set TOCHKA_SMOKE_MAX_RUB to the approved spend ceiling before creating a payment.',
  );
  process.exit(1);
}
if (!EXPECTED_RELEASE || !/^[0-9a-f]{40}$/u.test(EXPECTED_RELEASE)) {
  console.error(
    'Set TOCHKA_SMOKE_EXPECTED_RELEASE to the full 40-character commit SHA served by /ready before creating a payment.',
  );
  process.exit(1);
}

async function api(method, path, body, cookie = COOKIE) {
  const res = await fetch(API_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, data: json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOrderStatus(orderId, expectedStatus) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    // `/v1/billing/return` is deliberately NOT used here: the Tochka return
    // endpoint performs a provider status reconciliation and may apply the
    // payment itself. Polling history is side-effect-free, so a pending→paid
    // transition observed here proves the webhook path (or an operator action),
    // rather than this drill silently granting via the return page.
    let state;
    try {
      state = await api('GET', '/v1/billing/history?limit=200');
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const row =
      state.status === 200 && Array.isArray(state.data)
        ? state.data.find((candidate) => candidate?.id === orderId)
        : undefined;
    last = { status: state.status, row };
    if (row?.status === expectedStatus) return row;
    if (row && ['failed', 'refunded'].includes(row.status)) {
      throw new Error(`order ${orderId} reached ${row.status} while waiting for ${expectedStatus}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for order ${orderId}=${expectedStatus}: ${JSON.stringify(last)}`,
  );
}

async function getInvoice(orderId) {
  const res = await fetch(`${API_URL}/v1/billing/invoice/${encodeURIComponent(orderId)}.pdf`, {
    headers: { Cookie: COOKIE },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.arrayBuffer();
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    bytes: body.byteLength,
  };
}

async function getBillingState() {
  const [balance, subscription, media] = await Promise.all([
    api('GET', '/v1/credits/balance'),
    api('GET', '/v1/billing/subscription'),
    api('GET', '/v1/billing/media-storage'),
  ]);
  if (balance.status !== 200 || typeof balance.data?.available !== 'number') {
    throw new Error(`Failed to fetch balance: ${balance.status}`);
  }
  if (subscription.status !== 200) {
    throw new Error(`Failed to fetch subscription state: ${subscription.status}`);
  }
  if (media.status !== 200 || typeof media.data?.paid !== 'boolean') {
    throw new Error(`Failed to fetch media-storage state: ${media.status}`);
  }
  return {
    available: balance.data.available,
    subscription: subscription.data,
    mediaPaid: media.data.paid,
  };
}

function requirePaidOrder(row, expected) {
  if (
    !row ||
    row.status !== 'paid' ||
    row.kind !== expected.kind ||
    row.amountRub !== expected.amountRub ||
    !row.paidAt
  ) {
    throw new Error(`paid order mismatch: ${JSON.stringify({ row, expected })}`);
  }
}

function requireLiveStartSubscription(state, startCredits) {
  const sub = state.subscription;
  if (
    !sub ||
    !['active', 'trialing'].includes(sub.status) ||
    sub.tier !== START_TIER ||
    sub.priceRub !== START_PRICE_RUB ||
    sub.planAccess?.tier !== START_TIER
  ) {
    throw new Error(`subscription state mismatch after payment: ${JSON.stringify(sub)}`);
  }
  if (state.available < startCredits) {
    throw new Error(`subscription balance is below the granted cycle amount: ${state.available}`);
  }
  if (!state.mediaPaid) {
    throw new Error('media-storage entitlement was not enabled by the subscription');
  }
}

async function waitForEnter(label) {
  console.log(`   → ${label}; complete it manually, then press Enter here.`);
  await new Promise((resolve) => process.stdin.once('data', resolve));
}

async function refundOrder(orderId, label) {
  console.log(`8. Requesting ${label} refund…`);
  const refund = await api('POST', '/v1/admin/billing/refund', { orderId }, ADMIN_COOKIE);
  if (refund.status !== 200) {
    throw new Error(`${label} refund returned ${refund.status}: ${JSON.stringify(refund.data)}`);
  }
  const refunded = await waitForOrderStatus(orderId, 'refunded');
  if (!refunded.status) throw new Error(`${label} refund status was not persisted`);
  console.log(
    `   ${label} refund response:`,
    JSON.stringify({ orderId, result: refund.data?.result ?? null }),
  );
  console.log(`   ${label} refunded order:`, JSON.stringify(refunded));
  return { refund, refunded };
}

async function main() {
  console.log('0. Preflighting the deployed release…');
  const readyResponse = await fetch(`${API_URL}/ready`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const readyText = await readyResponse.text();
  let ready;
  try {
    ready = JSON.parse(readyText);
  } catch {
    ready = { raw: readyText };
  }
  if (readyResponse.status !== 200 || ready?.ok !== true) {
    throw new Error(
      `deployed release is not ready: ${readyResponse.status} ${JSON.stringify(ready)}`,
    );
  }
  if (ready.commit !== EXPECTED_RELEASE) {
    throw new Error(
      `release mismatch: expected ${EXPECTED_RELEASE}, /ready reports ${ready.commit ?? 'unknown'}. No checkout created.`,
    );
  }
  console.log('   Release:', ready.commit ?? 'unknown');
  console.log('   Readiness:', JSON.stringify(ready.checks ?? {}));

  if (!Number.isInteger(MAX_SPEND_RUB) || MAX_SPEND_RUB <= 0) {
    throw new Error(
      'Set TOCHKA_SMOKE_MAX_RUB to the explicitly approved spend ceiling before creating a payment.',
    );
  }
  if (PLANNED_SPEND_RUB > MAX_SPEND_RUB) {
    throw new Error(
      `Planned smoke spend is ${PLANNED_SPEND_RUB} RUB, above approved ceiling ${MAX_SPEND_RUB} RUB. No checkout created.`,
    );
  }

  console.log('1. Reading initial balance and entitlements…');
  const initial = await getBillingState();
  if (initial.subscription !== null || initial.mediaPaid) {
    throw new Error(
      `Smoke account is not fresh (subscription=${JSON.stringify(initial.subscription)}, mediaPaid=${initial.mediaPaid}). No checkout created.`,
    );
  }
  const initialAvailable = initial.available;

  console.log('2. Verifying the exact production catalog…');
  const tiers = await api('GET', '/v1/billing/tiers');
  if (tiers.status !== 200 || !Array.isArray(tiers.data)) {
    throw new Error('Failed to fetch subscription tiers: ' + tiers.status);
  }
  const start = tiers.data.find((tier) => tier?.tier === START_TIER);
  if (!start || start.title !== 'Старт' || start.priceRub !== START_PRICE_RUB) {
    throw new Error(
      `Active Старт catalog row must be ${START_PRICE_RUB} RUB; got ${JSON.stringify(start)}. No checkout created.`,
    );
  }
  if (!Number.isInteger(start.creditsPerCycle) || start.creditsPerCycle <= 0) {
    throw new Error(`Старт catalog row has invalid creditsPerCycle: ${JSON.stringify(start)}`);
  }

  const packs = await api('GET', '/v1/billing/packs');
  if (packs.status !== 200 || !Array.isArray(packs.data))
    throw new Error('Failed to fetch packs: ' + packs.status);
  const matchingPacks = packs.data.filter((pack) => pack?.priceRub === PACK_PRICE_RUB);
  if (matchingPacks.length !== 1 || !matchingPacks[0]?.id) {
    throw new Error(
      `Active catalog must expose exactly one ${PACK_PRICE_RUB} RUB pack; got ${JSON.stringify(matchingPacks)}. No checkout created.`,
    );
  }
  const pack = matchingPacks[0];
  if (!Number.isInteger(pack.credits) || pack.credits <= 0) {
    throw new Error(`Pack has invalid credits: ${JSON.stringify(pack)}`);
  }
  console.log(
    '   Старт:',
    start.tier,
    '=',
    start.priceRub,
    'RUB;',
    start.creditsPerCycle,
    'credits',
  );
  console.log('   Pack:', pack.id, '=', pack.priceRub, 'RUB;', pack.credits, 'credits');
  console.log('   Approved total spend ceiling:', MAX_SPEND_RUB, 'RUB');

  console.log('3. Creating Старт subscription checkout…');
  const subscriptionCheckout = await api('POST', '/v1/billing/subscribe', { tier: START_TIER });
  if (![200, 201].includes(subscriptionCheckout.status)) {
    throw new Error(JSON.stringify(subscriptionCheckout.data));
  }
  const subscriptionOrderId = subscriptionCheckout.data.orderId;
  if (!subscriptionOrderId || !subscriptionCheckout.data.confirmationUrl) {
    throw new Error(
      `Subscription checkout response is incomplete: ${JSON.stringify(subscriptionCheckout.data)}`,
    );
  }
  console.log('   Subscription order:', subscriptionOrderId);
  console.log('   Confirmation URL:', subscriptionCheckout.data.confirmationUrl);
  await waitForEnter('open the subscription confirmation URL and pay 599 RUB');

  console.log('4. Waiting for verified subscription webhook settlement…');
  const paidSubscription = await waitForOrderStatus(subscriptionOrderId, 'paid');
  requirePaidOrder(paidSubscription, {
    kind: 'subscription',
    amountRub: START_PRICE_RUB,
  });
  const afterSubscription = await getBillingState();
  if (afterSubscription.available !== initialAvailable + start.creditsPerCycle) {
    throw new Error(
      `balance mismatch after subscription: expected ${initialAvailable + start.creditsPerCycle}, got ${afterSubscription.available}`,
    );
  }
  requireLiveStartSubscription(afterSubscription, start.creditsPerCycle);
  const subscriptionInvoice = await getInvoice(subscriptionOrderId);
  if (
    subscriptionInvoice.status !== 200 ||
    subscriptionInvoice.contentType !== 'application/pdf' ||
    subscriptionInvoice.bytes < 100
  ) {
    throw new Error(`subscription invoice check failed: ${JSON.stringify(subscriptionInvoice)}`);
  }
  console.log('   Paid subscription:', JSON.stringify(paidSubscription));
  console.log('   Balance after subscription:', afterSubscription.available);
  console.log('   Subscription state:', JSON.stringify(afterSubscription.subscription));
  console.log('   Subscription invoice:', JSON.stringify(subscriptionInvoice));

  console.log('5. Creating 299 RUB pack checkout…');
  const packCheckout = await api('POST', '/v1/billing/checkout', { packId: pack.id });
  if (![200, 201].includes(packCheckout.status)) throw new Error(JSON.stringify(packCheckout.data));
  const packOrderId = packCheckout.data.orderId;
  if (!packOrderId || !packCheckout.data.confirmationUrl) {
    throw new Error(`Pack checkout response is incomplete: ${JSON.stringify(packCheckout.data)}`);
  }
  console.log('   Pack order:', packOrderId);
  console.log('   Confirmation URL:', packCheckout.data.confirmationUrl);
  await waitForEnter('open the pack confirmation URL and pay 299 RUB');

  console.log('6. Waiting for verified pack webhook settlement…');
  const paidPack = await waitForOrderStatus(packOrderId, 'paid');
  requirePaidOrder(paidPack, { kind: 'pack', amountRub: PACK_PRICE_RUB });
  const afterPack = await getBillingState();
  if (afterPack.available !== initialAvailable + start.creditsPerCycle + pack.credits) {
    throw new Error(
      `balance mismatch after pack: expected ${initialAvailable + start.creditsPerCycle + pack.credits}, got ${afterPack.available}`,
    );
  }
  requireLiveStartSubscription(afterPack, start.creditsPerCycle);
  const packInvoice = await getInvoice(packOrderId);
  if (
    packInvoice.status !== 200 ||
    packInvoice.contentType !== 'application/pdf' ||
    packInvoice.bytes < 100
  ) {
    throw new Error(`pack invoice check failed: ${JSON.stringify(packInvoice)}`);
  }
  console.log('   Paid pack:', JSON.stringify(paidPack));
  console.log('   Balance after pack:', afterPack.available);
  console.log('   Pack invoice:', JSON.stringify(packInvoice));

  await refundOrder(packOrderId, 'Pack');
  const afterPackRefund = await getBillingState();
  if (afterPackRefund.available !== initialAvailable + start.creditsPerCycle) {
    throw new Error(
      `balance mismatch after pack refund: expected ${initialAvailable + start.creditsPerCycle}, got ${afterPackRefund.available}`,
    );
  }
  requireLiveStartSubscription(afterPackRefund, start.creditsPerCycle);
  console.log('   Balance after pack refund:', afterPackRefund.available);
  console.log('   Media entitlement after pack refund:', afterPackRefund.mediaPaid);

  await refundOrder(subscriptionOrderId, 'Старт subscription');
  const final = await getBillingState();
  if (final.available !== initialAvailable) {
    throw new Error(
      `balance mismatch after subscription refund: expected ${initialAvailable}, got ${final.available}`,
    );
  }
  if (final.subscription !== null || final.mediaPaid) {
    throw new Error(
      `subscription/media entitlement remained after full refund: ${JSON.stringify(final)}`,
    );
  }
  console.log('   Final balance:', final.available);
  console.log('   Final subscription:', final.subscription);
  console.log('   Final media entitlement:', final.mediaPaid);

  console.log(
    '\nDone. Save this output together with webhook logs; it contains both order IDs, paid/refunded timestamps, balances, subscription state, and provider refund responses.',
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
