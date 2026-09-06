import { describe, expect, it } from 'vitest';
import {
  COST_DIVERGENCE,
  MemoryAlarmStateStore,
  evaluateRouteMarginAlarms,
  driftExceedsThreshold,
  type AlarmClock,
  type MarginAlarmObservation,
} from './route-margin-alarm';

const now = new Date('2026-08-08T12:00:00.000Z');

describe('route margin alarms', () => {
  it('fires the named drift and margin-floor alarms on sustained real invoices', async () => {
    const observations = invoiceRows(5, {
      configuredExpectedCostRub: 100,
      vendorReportedCostRub: 160,
      revenueRub: 100,
      role: 'primary',
    });
    const notified: string[] = [];

    const events = await evaluateRouteMarginAlarms({
      observations,
      state: new MemoryAlarmStateStore(),
      notifier: {
        notify: async (message) => {
          notified.push(message);
        },
      },
      clock: fixedClock(now),
    });

    expect(events.map((event) => event.condition)).toEqual(['drift', 'margin-floor']);
    expect(events.every((event) => event.attempts === 5 && event.breaches === 5)).toBe(true);
    expect(notified[0]).toMatch(/^⚠️ route drift/);
    expect(notified[1]).toMatch(/^🛑 route margin-floor/);
  });

  it('does not fire for one outlier and ignores configured-only rows', async () => {
    const observations = [
      ...invoiceRows(4, {
        configuredExpectedCostRub: 100,
        vendorReportedCostRub: 100,
        revenueRub: 200,
        role: 'primary',
      }),
      ...invoiceRows(1, {
        configuredExpectedCostRub: 100,
        vendorReportedCostRub: 130,
        revenueRub: 200,
        role: 'primary',
      }),
      ...invoiceRows(8, {
        configuredExpectedCostRub: 100,
        vendorReportedCostRub: null,
        revenueRub: 100,
        role: 'primary',
        costSource: 'configured',
      }),
    ];
    const events = await evaluateRouteMarginAlarms({
      observations,
      state: new MemoryAlarmStateStore(),
      notifier: { notify: async () => undefined },
      clock: fixedClock(now),
    });

    expect(events).toEqual([]);
  });

  it('deduplicates each condition for six hours and re-fires at cooldown', async () => {
    const observations = invoiceRows(5, {
      configuredExpectedCostRub: 100,
      vendorReportedCostRub: 140,
      revenueRub: 100,
      role: 'primary',
    });
    const state = new MemoryAlarmStateStore();
    const notified: string[] = [];
    const input = {
      observations,
      state,
      notifier: {
        notify: async (message: string) => {
          notified.push(message);
        },
      },
    };

    expect(await evaluateRouteMarginAlarms({ ...input, clock: fixedClock(now) })).toHaveLength(2);
    expect(
      await evaluateRouteMarginAlarms({
        ...input,
        clock: fixedClock(new Date(now.getTime() + 60 * 60 * 1000)),
      }),
    ).toEqual([]);
    expect(
      await evaluateRouteMarginAlarms({
        ...input,
        clock: fixedClock(new Date(now.getTime() + 6 * 60 * 60 * 1000)),
      }),
    ).toHaveLength(2);
    expect(notified).toHaveLength(4);
  });

  it('keeps the fallback equality boundary at zero margin', async () => {
    const equality = await evaluateRouteMarginAlarms({
      observations: invoiceRows(5, {
        configuredExpectedCostRub: 100,
        vendorReportedCostRub: 100,
        revenueRub: 100,
        role: 'fallback',
      }),
      state: new MemoryAlarmStateStore(),
      notifier: { notify: async () => undefined },
      clock: fixedClock(now),
    });
    expect(equality).toEqual([]);

    const loss = await evaluateRouteMarginAlarms({
      observations: invoiceRows(5, {
        configuredExpectedCostRub: 100,
        vendorReportedCostRub: 100.01,
        revenueRub: 100,
        role: 'fallback',
      }),
      state: new MemoryAlarmStateStore(),
      notifier: { notify: async () => undefined },
      clock: fixedClock(now),
    });
    expect(loss.map((event) => event.condition)).toEqual(['margin-floor']);
  });

  it('keeps drift at strictly greater than the existing 20 percent threshold', () => {
    expect(COST_DIVERGENCE).toBe(0.2);
    expect(driftExceedsThreshold(120, 100)).toBe(false);
    expect(driftExceedsThreshold(120.01, 100)).toBe(true);
  });
});

function fixedClock(value: Date): AlarmClock {
  return { now: () => value };
}

function invoiceRows(
  count: number,
  over: Partial<MarginAlarmObservation>,
): MarginAlarmObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${over.role ?? 'primary'}-${index}`,
    legIdentity: 'seedream-4-5|1K|t2i|-|-|any|leg1',
    rung: '1K',
    role: 'primary',
    submittedAt: new Date(now.getTime() - index * 60_000),
    configuredExpectedCostRub: 100,
    vendorReportedCostRub: 100,
    revenueRub: 200,
    costSource: 'invoiced',
    ...over,
  }));
}
