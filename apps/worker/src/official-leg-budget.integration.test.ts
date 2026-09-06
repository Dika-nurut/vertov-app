import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  appSettings,
  officialLegSpend,
  subscriptionsCatalog,
  OFFICIAL_LEG_DAILY_CAP_KEY,
  OFFICIAL_LEG_DAY_WINDOW_MS,
  OFFICIAL_LEG_FX_RUB,
  OFFICIAL_LEG_MONTHLY_CAP_KEY,
  OFFICIAL_LEG_MONTH_WINDOW_MS,
  nid,
  readConservativeCreditFloorRub,
  readOfficialLegCaps,
  readOfficialLegSpend,
  releaseOfficialLegSpend,
  reserveOfficialLegSpend,
  settleOfficialLegSpend,
} from '@seed/db';

/**
 * The third leg's loss counter against a real database (finance ruling
 * 2026-08-02, Ask 8 b). The pure arithmetic and the cap-crossing decision are
 * unit-tested in `@seed/db` (`__tests__/official-leg-budget.test.ts`); this
 * covers the SQL, the rolling-window boundaries, and — the point of the whole
 * exercise — that a reservation is taken BEFORE the provider call, so the cap
 * caps rather than counting the jobs that happened to succeed.
 */

const NANO_BANANA_PRO_4K_USD = 0.241344;
const ONE_4K_IMAGE_RUB = NANO_BANANA_PRO_4K_USD * OFFICIAL_LEG_FX_RUB;

/** The real catalogue's two extremes: the cheapest ACTIVE plan, and the retired
 *  one whose credits subscribers are still spending. */
const CREATOR_ACTIVE = { tier: 'creator', priceRub: 11699, creditsPerCycle: 32500 };
const LEGACY_RETIRED = { tier: 'start', priceRub: 1490, creditsPerCycle: 4500 };

async function setCaps(dailyRub: number, monthlyRub: number): Promise<void> {
  for (const [key, value] of [
    [OFFICIAL_LEG_DAILY_CAP_KEY, dailyRub],
    [OFFICIAL_LEG_MONTHLY_CAP_KEY, monthlyRub],
  ] as const) {
    await db
      .insert(appSettings)
      .values({ key, value, updatedBy: null })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  }
}

async function setTiers(
  tiers: ReadonlyArray<{
    tier: string;
    priceRub: number;
    creditsPerCycle: number;
    isActive?: boolean;
  }>,
): Promise<void> {
  await db.delete(subscriptionsCatalog);
  for (const tier of tiers) {
    await db.insert(subscriptionsCatalog).values({
      tier: tier.tier as 'creator',
      priceRub: tier.priceRub,
      creditsPerCycle: tier.creditsPerCycle,
      title: tier.tier,
      isActive: tier.isActive ?? true,
    });
  }
}

/** A settled loss that already happened, at a chosen age — the windows are what
 *  is under test, so this writes the row directly rather than reserving. */
async function seedLoss(jobId: string, netRub: number, occurredAt: Date): Promise<void> {
  await db.insert(officialLegSpend).values({
    id: nid(),
    jobId,
    modelId: 'gemini-3-pro-image',
    rung: '4K',
    units: 1,
    costRub: netRub.toFixed(4),
    pendingRub: '0.0000',
    revenueRub: '0.0000',
    costSource: 'configured',
    settledAt: occurredAt,
    occurredAt,
  });
}

async function spendRow(jobId: string) {
  const [row] = await db.select().from(officialLegSpend).where(eq(officialLegSpend.jobId, jobId));
  return row!;
}

function reservationFor(jobId: string, units = 1) {
  return {
    jobId,
    modelId: 'gemini-3-pro-image',
    rung: '4K',
    units,
    usdPerUnit: NANO_BANANA_PRO_4K_USD,
  };
}

beforeEach(async () => {
  await db.delete(officialLegSpend);
  await db
    .delete(appSettings)
    .where(inArray(appSettings.key, [OFFICIAL_LEG_DAILY_CAP_KEY, OFFICIAL_LEG_MONTHLY_CAP_KEY]));
  await setTiers([CREATOR_ACTIVE]);
});

describe('the caps come from data', () => {
  it('reads what finance set in app_settings', async () => {
    await setCaps(3000, 20000);
    expect(await readOfficialLegCaps()).toEqual({ dailyRub: 3000, monthlyRub: 20000 });
  });

  it('reads a DB with no caps configured as a leg that is switched off', async () => {
    // Fail-closed: "no config" must never mean "no limit" — that was the status
    // quo finance rejected.
    expect(await readOfficialLegCaps()).toEqual({ dailyRub: 0, monthlyRub: 0 });
    expect(await reserveOfficialLegSpend(reservationFor('job_no_caps'))).toMatchObject({
      reserved: false,
      reason: 'budget-exhausted',
    });
  });
});

describe('the two rolling windows are half-open — (now − window, now]', () => {
  it('drops a loss at EXACTLY 24 h out of the day window, keeping it in the month', async () => {
    // The boundary itself, not a comfortable 30 h. A loss 24 h old is not part
    // of "the last 24 hours", and half-open is the only convention under which
    // it belongs to exactly one window as time passes.
    const now = new Date('2026-08-02T12:00:00.000Z');
    await seedLoss('job_exactly_a_day', 900, new Date(now.getTime() - OFFICIAL_LEG_DAY_WINDOW_MS));
    await seedLoss(
      'job_a_hair_inside',
      500,
      new Date(now.getTime() - OFFICIAL_LEG_DAY_WINDOW_MS + 1),
    );
    expect(await readOfficialLegSpend(db, now)).toEqual({ dayRub: 500, monthRub: 1400 });
  });

  it('drops a loss at EXACTLY 30 days out of the month window', async () => {
    const now = new Date('2026-08-02T12:00:00.000Z');
    await seedLoss(
      'job_exactly_a_month',
      5000,
      new Date(now.getTime() - OFFICIAL_LEG_MONTH_WINDOW_MS),
    );
    await seedLoss(
      'job_a_hair_inside',
      120,
      new Date(now.getTime() - OFFICIAL_LEG_MONTH_WINDOW_MS + 1),
    );
    expect(await readOfficialLegSpend(db, now)).toEqual({ dayRub: 0, monthRub: 120 });
  });

  it('reports a net-profitable window as zero spent, not as extra headroom', async () => {
    await db.insert(officialLegSpend).values({
      id: nid(),
      jobId: 'job_profitable',
      modelId: 'gemini-3-pro-image',
      rung: '4K',
      units: 1,
      costRub: '10.0000',
      revenueRub: '99.0000',
      settledAt: new Date(),
      costSource: 'configured',
    });
    expect(await readOfficialLegSpend()).toEqual({ dayRub: 0, monthRub: 0 });
  });

  it('does not let a profitable job buy headroom for a different job loss', async () => {
    // The doc comment above `readOfficialLegSpend` has always said a profitable
    // window "must not hand a future loss extra headroom" — and the SQL summed
    // (cost − revenue) across every row and floored only the TOTAL. One job that
    // came out +89 ₽ therefore financed 89 ₽ of the next job's loss, which is a
    // cap on NET margin, not on the "accumulated negative margin" finance capped.
    await db.insert(officialLegSpend).values({
      id: nid(),
      jobId: 'job_earned_89',
      modelId: 'gemini-3-pro-image',
      rung: '4K',
      units: 1,
      costRub: '10.0000',
      revenueRub: '99.0000',
      settledAt: new Date(),
      costSource: 'configured',
    });
    await seedLoss('job_lost_100', 100, new Date());
    expect(await readOfficialLegSpend()).toEqual({ dayRub: 100, monthRub: 100 });
  });
});

describe('the reservation is the gate', () => {
  it('books the job worst case before it goes out, and counts it immediately', async () => {
    await setCaps(3000, 20000);
    const outcome = await reserveOfficialLegSpend(reservationFor('job_in_flight'));
    expect(outcome).toMatchObject({
      reserved: true,
      reservedRub: expect.closeTo(ONE_4K_IMAGE_RUB, 6),
      // The handle a release must name. Without it, giving back a refused
      // attempt gave back the whole job's accumulated bookings.
      attemptId: expect.any(String),
    });
    // Nothing has settled and no asset exists yet — and the budget is already
    // smaller. That is the difference between a cap and a scoreboard.
    expect((await readOfficialLegSpend()).dayRub).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
    const row = await spendRow('job_in_flight');
    expect(row.costSource).toBe('reserved');
    expect(row.settledAt).toBeNull();
    expect(Number(row.pendingRub)).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
  });

  it('includes the asking job own loss, so the last approval cannot break the cap', async () => {
    // Headroom for one and a bit: the historical sum alone says yes to the
    // second job, and the cap is then breached by the very job it approved.
    await setCaps(ONE_4K_IMAGE_RUB * 2 - 0.05, 20000);
    await reserveOfficialLegSpend(reservationFor('job_one'));
    expect(await reserveOfficialLegSpend(reservationFor('job_two'))).toMatchObject({
      reserved: false,
      reason: 'budget-exhausted',
    });
  });

  it('lets four concurrent jobs through a budget that fits two, and no more', async () => {
    // The defect this design exists for. A read-then-submit gate hands all four
    // the same headroom and all four go out; overshoot is then bounded by
    // concurrency, not by the cap.
    await setCaps(ONE_4K_IMAGE_RUB * 2.5, 20000);
    const outcomes = await Promise.all(
      ['a', 'b', 'c', 'd'].map((k) => reserveOfficialLegSpend(reservationFor(`job_race_${k}`))),
    );
    expect(outcomes.filter((o) => o.reserved)).toHaveLength(2);
    expect((await readOfficialLegSpend()).dayRub).toBeLessThan(ONE_4K_IMAGE_RUB * 2.5);
  });

  it('prices a 4-image request at four images, not one', async () => {
    await setCaps(3000, 20000);
    expect(await reserveOfficialLegSpend(reservationFor('job_fanout', 4))).toMatchObject({
      reserved: true,
      reservedRub: expect.closeTo(ONE_4K_IMAGE_RUB * 4, 6),
    });
  });

  it('refuses outright when no tier prices a credit, before anything is submitted', async () => {
    // With no priced tier, revenue is 0 and every job here is a 100% loss. The
    // caps alone would still say yes — they only look at history — so the leg
    // would keep routing and the truth would surface one settlement too late.
    await setCaps(3000, 20000);
    await setTiers([]);
    expect(await readConservativeCreditFloorRub()).toBe(0);
    expect(await reserveOfficialLegSpend(reservationFor('job_no_tiers'))).toMatchObject({
      reserved: false,
      reason: 'no-credit-floor',
    });
    expect(await readOfficialLegSpend()).toEqual({ dayRub: 0, monthRub: 0 });
  });

  it('adds a retry to the same row rather than re-using its first booking', async () => {
    // A second submit is a second real charge. One job id must not cap how much
    // of the budget one job can consume.
    await setCaps(3000, 20000);
    await reserveOfficialLegSpend(reservationFor('job_retried'));
    await reserveOfficialLegSpend(reservationFor('job_retried'));
    expect((await readOfficialLegSpend()).dayRub).toBeCloseTo(ONE_4K_IMAGE_RUB * 2, 3);
  });
});

describe('the revenue floor is the cheapest credit ANY subscriber can obtain', () => {
  it('values a settled job at the retired plan rate, not the cheapest active one', async () => {
    // 1490/4500 = 0.331111 ₽/credit against 11699/32500 = 0.359969. Scoring at
    // the active-only floor overstates revenue by 15.91% and understates every
    // loss measured against it by the same amount — while the admin cost report
    // and the CI break-even guard were already using the conservative figure.
    await setCaps(3000, 20000);
    await setTiers([CREATOR_ACTIVE, { ...LEGACY_RETIRED, isActive: false }]);
    await reserveOfficialLegSpend(reservationFor('job_floor'));
    await settleOfficialLegSpend({ jobId: 'job_floor', creditsSpent: 50 });
    const row = await spendRow('job_floor');
    expect(Number(row.revenueRub)).toBeCloseTo(50 * (1490 / 4500), 3);
    expect(Number(row.revenueRub)).toBeLessThan(50 * (11699 / 32500));
  });
});

describe('settling a reservation, whatever happened to the job', () => {
  beforeEach(async () => {
    await setCaps(3000, 20000);
  });

  it('keeps the reserved cost and books zero revenue for a refunded job', async () => {
    // The single largest class the settle-only counter missed: the provider was
    // paid, the customer got their credits back, and nothing was recorded.
    await reserveOfficialLegSpend(reservationFor('job_failed'));
    expect(await settleOfficialLegSpend({ jobId: 'job_failed', creditsSpent: 0 })).toMatchObject({
      settled: true,
      source: 'configured',
    });
    const row = await spendRow('job_failed');
    expect(Number(row.costRub)).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
    expect(Number(row.revenueRub)).toBe(0);
    expect(Number(row.pendingRub)).toBe(0);
    expect(row.settledAt).not.toBeNull();
    expect((await readOfficialLegSpend()).dayRub).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
  });

  it('replaces our configured guess with the provider own invoice when it sends one', async () => {
    // `capabilities.officialUsdPerUnit` is one observed charge copied by hand
    // and never re-checked. `usage.cost` is the bill.
    await reserveOfficialLegSpend(reservationFor('job_invoiced'));
    expect(
      await settleOfficialLegSpend({
        jobId: 'job_invoiced',
        creditsSpent: 50,
        providerCostUsd: 0.5,
      }),
    ).toMatchObject({ settled: true, source: 'invoiced' });
    const row = await spendRow('job_invoiced');
    expect(Number(row.costRub)).toBeCloseTo(0.5 * OFFICIAL_LEG_FX_RUB, 3);
    expect(row.costSource).toBe('invoiced');
  });

  it('is a no-op for a job that never touched the leg', async () => {
    expect(await settleOfficialLegSpend({ jobId: 'job_never_here', creditsSpent: 50 })).toEqual({
      settled: false,
    });
  });

  it('keeps an earlier attempt cost when a later attempt reports its own invoice', async () => {
    // Two submits are two real charges. Settlement computed
    // `cost − pending + invoiced`, and `pending` was the ACCUMULATED reservation
    // of every attempt — so the final attempt's invoice erased the earlier one's
    // 25.6264 ₽ as well as its own, and one bill paid for two.
    await reserveOfficialLegSpend(reservationFor('job_retry_invoiced'));
    await reserveOfficialLegSpend(reservationFor('job_retry_invoiced'));
    await settleOfficialLegSpend({
      jobId: 'job_retry_invoiced',
      creditsSpent: 0,
      providerCostUsd: NANO_BANANA_PRO_4K_USD,
    });
    expect((await readOfficialLegSpend()).dayRub).toBeCloseTo(ONE_4K_IMAGE_RUB * 2, 3);
  });

  it('counts a retried settle once, not twice', async () => {
    await reserveOfficialLegSpend(reservationFor('job_double_settle'));
    await settleOfficialLegSpend({ jobId: 'job_double_settle', creditsSpent: 50 });
    const first = await readOfficialLegSpend();
    expect(await settleOfficialLegSpend({ jobId: 'job_double_settle', creditsSpent: 50 })).toEqual({
      settled: false,
    });
    expect(await readOfficialLegSpend()).toEqual(first);
  });
});

describe('a settlement that RAISES a cost is part of the cap decision', () => {
  it('makes a concurrent reservation wait for it instead of reading the old total', async () => {
    // Reservations serialize on `pg_advisory_xact_lock`, so two of them cannot
    // both be approved off the same headroom. A settlement whose invoice is
    // LARGER than the reservation raises the same total without taking that
    // lock — so a reservation running beside it reads a pre-invoice snapshot and
    // is approved over the cap. The invoice is the only figure that can move a
    // cost up, and it is exactly the one we do not control.
    await setCaps(ONE_4K_IMAGE_RUB * 2.4, 20000);
    await reserveOfficialLegSpend(reservationFor('job_invoice_spike'));

    let settleIssued = false;
    const settling = db.transaction(async (tx) => {
      await settleOfficialLegSpend(
        {
          jobId: 'job_invoice_spike',
          creditsSpent: 0,
          // Google repriced its own listing: the bill is 5× the rate we booked.
          providerCostUsd: NANO_BANANA_PRO_4K_USD * 5,
        },
        tx,
      );
      settleIssued = true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    while (!settleIssued) await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await reserveOfficialLegSpend(reservationFor('job_after_spike'));
    await settling;
    expect(second).toMatchObject({ reserved: false, reason: 'budget-exhausted' });
  });
});

describe('releasing a reservation the vendor never billed', () => {
  it('gives the budget back and leaves a zero-impact row', async () => {
    // A wrong API key 401s every request. Without this, a few hundred failures
    // that cost nothing would burn the day's whole budget and take the leg
    // offline for 24 h — during the ban wave it exists for.
    await setCaps(3000, 20000);
    const booking = await reserveOfficialLegSpend(reservationFor('job_rejected'));
    expect(booking.reserved).toBe(true);
    expect(await releaseOfficialLegSpend(booking.reserved ? booking.attemptId : '')).toBe(true);
    expect(await readOfficialLegSpend()).toEqual({ dayRub: 0, monthRub: 0 });
    const row = await spendRow('job_rejected');
    expect(row.costSource).toBe('released');
    expect(Number(row.costRub)).toBe(0);
  });

  it('cannot un-spend a reservation that already settled', async () => {
    await setCaps(3000, 20000);
    const booking = await reserveOfficialLegSpend(reservationFor('job_settled_then_released'));
    await settleOfficialLegSpend({ jobId: 'job_settled_then_released', creditsSpent: 0 });
    expect(await releaseOfficialLegSpend(booking.reserved ? booking.attemptId : '')).toBe(false);
    expect((await readOfficialLegSpend()).dayRub).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
  });
});
