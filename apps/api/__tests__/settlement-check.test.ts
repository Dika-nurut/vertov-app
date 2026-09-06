import { describe, expect, it } from 'vitest';
// The monitor VM has no test harness of its own and must not grow one (it ships
// as plain CommonJS with a deliberately tiny dependency set). This suite is the
// nearest runnable harness, so the settlement alert's pure logic is pinned here.
import settlementCheck from '../../../infra/monitor/settlement-check.js';

const { isSettlementStuck, parseSettlementOutput, resolveSettlementMonitorConfig } =
  settlementCheck;

describe('settlement outbox monitor', () => {
  it('parses its fixed count|oldest_age_seconds output contract', () => {
    expect(parseSettlementOutput('2|1865\n')).toEqual({ count: 2, oldestAgeSeconds: 1865 });
  });

  it('rejects malformed forced-command output', () => {
    expect(() => parseSettlementOutput('2 1865\n')).toThrow('unexpected_settlement_output');
  });

  it('does not alert when no settlement rows are pending', () => {
    expect(isSettlementStuck(parseSettlementOutput('0|0\n'), 30)).toBe(false);
  });

  it('does not alert before the oldest row reaches the threshold', () => {
    expect(isSettlementStuck(parseSettlementOutput('1|1799\n'), 30)).toBe(false);
  });

  it('defaults an invalid threshold to 30 minutes with a visible warning', () => {
    expect(
      resolveSettlementMonitorConfig({ SETTLEMENT_STUCK_MINUTES: 'not-a-number' }),
    ).toMatchObject({
      thresholdMinutes: 30,
      warnings: ['invalid SETTLEMENT_STUCK_MINUTES="not-a-number"; defaulting to 30'],
    });
  });

  it('defaults an empty host with a visible warning', () => {
    expect(resolveSettlementMonitorConfig({ SETTLEMENT_MONITOR_HOST: '   ' })).toMatchObject({
      host: 'deploy@203.0.113.10',
      warnings: ['empty SETTLEMENT_MONITOR_HOST; defaulting to deploy@203.0.113.10'],
    });
  });
});
