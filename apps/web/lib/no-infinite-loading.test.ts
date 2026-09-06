import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CJM stall guard (zero-token CI check).
 *
 * The recurring "infinite loading" bug in this app is a client poller that
 * re-schedules itself against a job/render status endpoint but never bounds
 * itself: if the backend job is wedged (stuck queued / hung run) the poll spins
 * a spinner forever and the user never sees an error. We fixed three of these
 * by hand (generate `pollJob`, studio `pollRender`, checkout `poll`); this test
 * stops the pattern from coming back without anyone having to re-audit by eye.
 *
 * Convention enforced: any SELF-RESCHEDULING poller — `setTimeout(() => …
 * poll…())` — must, in the same file:
 *   1. carry a deadline/elapsed bound (so it can't loop forever), AND
 *   2. give its poll fetch a per-request timeout via `AbortSignal.timeout`
 *      (so a hung socket can't stall a single iteration indefinitely).
 *
 * Background `setInterval` refreshers (JobsTray, the boards running-node poll)
 * are intentionally NOT matched: each tick is independent and they don't drive
 * a blocking spinner — they lean on the server reaper for terminal state.
 */

const APP_DIR = join(__dirname, '..', 'app');

// A poller that re-arms itself: setTimeout(() => void pollFoo(...)) / => pollFoo(
const SELF_RESCHEDULE = /setTimeout\(\s*\(\)\s*=>\s*(?:void\s+)?(\w*[Pp]oll\w*)\s*\(/;
// Evidence the loop is bounded (a deadline check or an elapsed/Date.now() guard).
const HAS_DEADLINE = /deadline|elapsed|Date\.now\(\)/i;
// Evidence the poll fetch is bounded per request.
const HAS_FETCH_TIMEOUT = /AbortSignal\.timeout/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

describe('CJM: no unbounded status pollers (no infinite loading)', () => {
  const files = sourceFiles(APP_DIR);

  it('finds source to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!SELF_RESCHEDULE.test(src)) continue;
    const rel = file.slice(file.indexOf('/app/'));

    it(`${rel} bounds its poller with a deadline`, () => {
      expect(
        HAS_DEADLINE.test(src),
        `${rel} re-schedules a poll() but has no deadline/elapsed guard — a wedged ` +
          `backend would spin the UI forever. Add an overall deadline like generate's pollJob.`,
      ).toBe(true);
    });

    it(`${rel} gives its poll fetch a request timeout`, () => {
      expect(
        HAS_FETCH_TIMEOUT.test(src),
        `${rel} re-schedules a poll() but no fetch uses AbortSignal.timeout — a hung ` +
          `socket can stall a poll iteration indefinitely. Add signal: AbortSignal.timeout(...).`,
      ).toBe(true);
    });
  }
});
