import { readFile, writeFile } from 'node:fs/promises';
import {
  FALLBACK_MARGIN_FLOOR,
  PRIMARY_MARGIN_FLOOR,
  readRouteAttemptObservations,
  type RouteAttemptObservation,
} from '@seed/db';

export const COST_DIVERGENCE = 0.2;
export const MARGIN_ALARM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MARGIN_ALARM_MIN_ATTEMPTS = 5;
export const MARGIN_ALARM_BREACH_RATIO = 0.6;
export const MARGIN_ALARM_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const PRIMARY_ROUTE_MARGIN_FLOOR = PRIMARY_MARGIN_FLOOR;
export const FALLBACK_ROUTE_MARGIN_FLOOR = FALLBACK_MARGIN_FLOOR;

export function driftExceedsThreshold(vendorCostRub: number, configuredCostRub: number): boolean {
  return (
    Number.isFinite(vendorCostRub) &&
    Number.isFinite(configuredCostRub) &&
    configuredCostRub > 0 &&
    Math.abs(vendorCostRub - configuredCostRub) / configuredCostRub > COST_DIVERGENCE
  );
}

export type MarginAlarmCondition = 'drift' | 'margin-floor';

export interface MarginAlarmObservation {
  id: string;
  legIdentity: string;
  rung: string;
  role: 'primary' | 'fallback';
  submittedAt: Date;
  configuredExpectedCostRub: number | null;
  vendorReportedCostRub: number | null;
  revenueRub: number | null;
  costSource: string;
}

export interface AlarmClock {
  now(): Date;
}

export interface AlarmStateStore {
  read(key: string): Promise<{ lastAlertAt: string } | null>;
  write(key: string, value: { lastAlertAt: string }): Promise<void>;
}

export interface AlarmNotifier {
  notify(message: string): Promise<void>;
}

export interface MarginAlarmEvent {
  condition: MarginAlarmCondition;
  key: string;
  attempts: number;
  breaches: number;
  ratio: number;
  message: string;
}

export const systemClock: AlarmClock = { now: () => new Date() };

/** In-memory state is useful for a poller's unit tests; production uses JSON below. */
export class MemoryAlarmStateStore implements AlarmStateStore {
  private readonly values = new Map<string, { lastAlertAt: string }>();

  read(key: string): Promise<{ lastAlertAt: string } | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  write(key: string, value: { lastAlertAt: string }): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

/** JSON state keeps cooldown/dedup durable across a monitor restart. */
export class JsonAlarmStateStore implements AlarmStateStore {
  constructor(private readonly path: string) {}

  async read(key: string): Promise<{ lastAlertAt: string } | null> {
    let parsed: Record<string, { lastAlertAt: string }>;
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<
        string,
        { lastAlertAt: string }
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return parsed[key] ?? null;
  }

  async write(key: string, value: { lastAlertAt: string }): Promise<void> {
    let parsed: Record<string, { lastAlertAt: string }> = {};
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<
        string,
        { lastAlertAt: string }
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    parsed[key] = value;
    await writeFile(this.path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }
}

/** Adapter for the established one-line Telegram delivery seam. */
export class TelegramMarginAlarmNotifier implements AlarmNotifier {
  constructor(private readonly sendTelegramAlert: (message: string) => Promise<void>) {}

  notify(message: string): Promise<void> {
    return this.sendTelegramAlert(message);
  }
}

/**
 * Evaluate both named alarms from real invoice rows. Configured-only rows are
 * intentionally excluded from the denominator: they are useful for finance,
 * but cannot prove vendor drift or a real margin breach.
 */
export async function evaluateRouteMarginAlarms(input: {
  observations: readonly MarginAlarmObservation[];
  state: AlarmStateStore;
  notifier: AlarmNotifier;
  clock?: AlarmClock;
}): Promise<MarginAlarmEvent[]> {
  const now = (input.clock ?? systemClock).now();
  const invoiceRows = input.observations.filter(
    (row) => row.costSource === 'invoiced' && row.vendorReportedCostRub !== null,
  );
  const groups = new Map<string, MarginAlarmObservation[]>();
  for (const row of invoiceRows) {
    if (row.submittedAt.getTime() > now.getTime()) continue;
    if (now.getTime() - row.submittedAt.getTime() >= MARGIN_ALARM_WINDOW_MS) continue;
    const key = `${row.legIdentity}|${row.rung}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const events: MarginAlarmEvent[] = [];
  for (const [groupKey, rows] of groups) {
    const conditions: Array<{
      condition: MarginAlarmCondition;
      breach: (row: MarginAlarmObservation) => boolean;
    }> = [
      {
        condition: 'drift',
        breach: (row) =>
          row.configuredExpectedCostRub !== null &&
          driftExceedsThreshold(row.vendorReportedCostRub!, row.configuredExpectedCostRub),
      },
      {
        condition: 'margin-floor',
        breach: (row) => {
          if (row.revenueRub === null || !Number.isFinite(row.revenueRub) || row.revenueRub <= 0) {
            return false;
          }
          const floor =
            row.role === 'primary' ? PRIMARY_ROUTE_MARGIN_FLOOR : FALLBACK_ROUTE_MARGIN_FLOOR;
          const realMargin = 1 - row.vendorReportedCostRub! / row.revenueRub;
          return realMargin < floor;
        },
      },
    ];

    for (const { condition, breach } of conditions) {
      const breaches = rows.filter(breach).length;
      const ratio = breaches / rows.length;
      if (rows.length < MARGIN_ALARM_MIN_ATTEMPTS || ratio < MARGIN_ALARM_BREACH_RATIO) continue;
      const key = `${condition}:${groupKey}`;
      const previous = await input.state.read(key);
      if (previous) {
        const last = Date.parse(previous.lastAlertAt);
        if (Number.isFinite(last) && now.getTime() - last < MARGIN_ALARM_COOLDOWN_MS) continue;
      }
      const emoji = condition === 'drift' ? '⚠️' : '🛑';
      const message = `${emoji} route ${condition} leg=${rows[0]!.legIdentity} rung=${rows[0]!.rung} invoice_breaches=${breaches}/${rows.length} ratio=${ratio.toFixed(2)}`;
      await input.notifier.notify(message);
      await input.state.write(key, { lastAlertAt: now.toISOString() });
      events.push({ condition, key, attempts: rows.length, breaches, ratio, message });
    }
  }
  return events;
}

/** Poller seam: DB observations remain separate from the pure evaluator. */
export async function evaluatePersistedRouteMarginAlarms(input: {
  state: AlarmStateStore;
  notifier: AlarmNotifier;
  clock?: AlarmClock;
}): Promise<MarginAlarmEvent[]> {
  // Bound the read to the same window the evaluator applies in memory. Without it
  // this is a full scan of an append-only journal that never prunes, run on a timer.
  const windowStart = new Date(
    (input.clock ?? systemClock).now().getTime() - MARGIN_ALARM_WINDOW_MS,
  );
  const rows = await readRouteAttemptObservations(undefined, windowStart);
  return evaluateRouteMarginAlarms({
    observations: rows
      .map(toAlarmObservation)
      .filter((row): row is MarginAlarmObservation => row !== null),
    ...input,
  });
}

function toAlarmObservation(row: RouteAttemptObservation): MarginAlarmObservation | null {
  if (row.role !== 'primary' && row.role !== 'fallback') return null;
  return { ...row, role: row.role };
}
