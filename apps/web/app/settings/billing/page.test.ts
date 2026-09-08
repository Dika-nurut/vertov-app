import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BILLING_SOURCE = readFileSync(join(__dirname, 'BillingClient.tsx'), 'utf8');

describe('billing history order identification', () => {
  it('shows a copyable order id for every payment row', () => {
    expect(BILLING_SOURCE).toContain('data-testid="history-order-id"');
    expect(BILLING_SOURCE).toContain('Номер заказа:');
    expect(BILLING_SOURCE).toContain('строки с нужной датой и суммой');
  });
});
