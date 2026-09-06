#!/usr/bin/env node

/** Read-only Tochka connectivity/readiness check; never creates a payment. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The production app deliberately scopes the Russian Trusted Root CA to the
// Tochka client instead of changing Node's process-wide trust store. Keep this
// operator preflight on the same transport path, otherwise a healthy provider
// adapter would be reported as a false TLS failure.
const requireFromTochka = createRequire(
  new URL('../packages/providers/tochka/package.json', import.meta.url),
);
const { Agent: ProviderAgent } = requireFromTochka('undici');
const mode = (process.env.TOCHKA_MODE ?? 'live').toLowerCase() === 'sandbox' ? 'sandbox' : 'live';
const base =
  process.env.TOCHKA_BASE_URL ??
  (mode === 'sandbox' ? 'https://enter.tochka.com/sandbox/v2' : 'https://enter.tochka.com/uapi');
const token = mode === 'sandbox' ? 'sandbox.jwt.token' : process.env.TOCHKA_JWT;
const caPath = process.env.TOCHKA_CA_CERT?.trim();
let dispatcher;

if (caPath) {
  try {
    dispatcher = new ProviderAgent({ connect: { ca: readFileSync(caPath, 'utf8') } });
  } catch (error) {
    console.error(
      `FAIL Tochka preflight: cannot load TOCHKA_CA_CERT at ${caPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (!token) {
  console.error('FAIL TOCHKA_JWT is missing for live preflight');
  process.exit(1);
}

async function get(path) {
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
    ...(dispatcher ? { dispatcher } : {}),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function list(data, key) {
  const values = data?.Data?.[key];
  return Array.isArray(values) ? values : [];
}

try {
  const customers = list(await get('/open-banking/v1.0/customers'), 'Customer');
  const businesses = customers.filter((customer) => customer?.customerType === 'Business');
  const configuredCustomer = process.env.TOCHKA_CUSTOMER_CODE || undefined;
  const configuredRow = configuredCustomer
    ? customers.find((customer) => customer?.customerCode === configuredCustomer)
    : undefined;
  const customerCode = configuredCustomer ?? businesses[0]?.customerCode;
  if (!customerCode) throw new Error('no Business customerCode returned');
  if (
    configuredCustomer &&
    !businesses.some((customer) => customer.customerCode === configuredCustomer) &&
    mode !== 'sandbox'
  ) {
    throw new Error('TOCHKA_CUSTOMER_CODE is not a Business customer returned by the API');
  }

  const query = new URLSearchParams({ customerCode });
  const retailers = list(await get(`/acquiring/v1.0/retailers?${query}`), 'Retailer');
  const registered = retailers.filter(
    (retailer) => retailer?.status === 'REG' && retailer?.isActive === true,
  );
  const configuredMerchant = process.env.TOCHKA_MERCHANT_ID || undefined;
  const merchant = configuredMerchant
    ? registered.find((retailer) => retailer.merchantId === configuredMerchant)
    : registered[0];
  if (!merchant) throw new Error('no active REG retailer matched TOCHKA_MERCHANT_ID');

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode,
        customerCode,
        customerType: configuredRow?.customerType ?? 'Business',
        businessCustomers: businesses.length,
        registeredActiveRetailers: registered.length,
        merchantId: merchant.merchantId,
        terminalId: merchant.terminalId ?? null,
        paymentModes: merchant.paymentModes ?? [],
        cashbox: Boolean(merchant.cashbox),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`FAIL Tochka preflight: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
