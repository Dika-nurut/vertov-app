import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Board tier-gate guard (zero-token CI check).
 *
 * /generate has locked out-of-plan models behind an upsell since P-B2/DEC-3.
 * /boards shipped without any gate: it never fetched the subscription, so a
 * free user could pick `veo-3-1`, wire a whole graph, get a quote, and only hit
 * the wall as a 403 toast at submit — the server comment in
 * `apps/api/src/jobs-routes.ts` even assumed "the UI already hides higher-tier
 * models". The behaviour lives in React components with no DOM test harness
 * here, so this pins the WIRING: each link in the chain must stay connected.
 *
 * The rank logic itself is covered by `model-tier.test.ts`; the default/fallback
 * rules by `node-settings.test.ts`. The server-side 403 stays the real
 * defence — nothing in this file replaces it.
 */

const BOARD_DIR = join(__dirname, '..', 'app', 'boards', '[id]');
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');
/** Collapse whitespace before matching a multi-line expression. These guards pin
 *  WIRING, not formatting: re-indentation from an unrelated merge (a new wrapper
 *  element around the JSX) once failed this file while the behaviour was intact. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('boards: plan tier reaches the node model picker', () => {
  it('the board page fetches the subscription and passes the LIVE plan tier down', () => {
    // W0: the gate reads `planAccess`, the live plan — NOT the top-level
    // manageable row, which is still returned for an elapsed subscription so it
    // can be cancelled. Reading the top-level tier here would show an expired
    // subscriber every paid model as unlocked, then 403 them at submit.
    const page = read(BOARD_DIR, 'page.tsx');
    expect(page).toContain('/v1/billing/subscription');
    expect(page).toContain('planTier={subscription.data?.planAccess?.tier ?? null}');
  });

  it('the board page routes the locked-model CTA through the shared helper', () => {
    // D6: an elapsed subscriber must not be walked into the 1 ₽ upgrade trap.
    const page = read(BOARD_DIR, 'page.tsx');
    expect(page).toContain("import { lockedModelCtaHref } from '../../../lib/locked-model-cta';");
    expect(flat(page)).toContain(
      flat(`lockedCtaHref={lockedModelCtaHref({
        hasLivePlan: Boolean(subscription.data?.planAccess),
        hasManageableSubscription: subscription.data != null,
      })}`),
    );
  });

  it('the mobile/desktop split point carries planTier and the CTA target', () => {
    const surface = read(BOARD_DIR, 'BoardSurface.tsx');
    expect(surface).toContain('planTier: string | null');
    expect(surface).toContain('lockedCtaHref: string');
    expect(surface).toContain(
      'return isMobile ? <MobileBoard {...props} /> : <DesktopBoard {...props} />;',
    );
  });

  it('the graph exposes planTier through the node context', () => {
    const graph = read(BOARD_DIR, 'GraphBoard.tsx');
    expect(graph).toContain('planTier: string | null');
    expect(graph).toContain('lockedCtaHref: string;');
    // Both mode defaults go through the tier-aware resolver, never a raw
    // `models.find(id === 'seedream-5-0-pro')`.
    expect(graph).toContain("defaultModelForMode(models, 'image', 'seedream-5-0-pro', planTier)");
    expect(graph).toContain("defaultModelForMode(models, 'video', 'seedance-2-0-fast', planTier)");
  });

  it('the run path refuses an out-of-plan model before spending a round-trip', () => {
    const graph = read(BOARD_DIR, 'GraphBoard.tsx');
    expect(graph).toContain('if (modelLocked(model)) {');
    expect(graph).toContain('showToast(tierUpsellLabel(model));');
  });

  /**
   * The single-shot gate above was not enough: «Снять всё» summed every shot into one
   * total the user approves, and the structural diagnostic it gated on has no concept of
   * a plan tier. A locked shot was priced (the estimate endpoint answers 200 with
   * `tierAllowed:false` rather than refusing), added to the total, and then dropped at
   * execution — the approved number could never be spent.
   */
  it('the batch preview refuses a locked shot before a total exists to approve', () => {
    const graph = read(BOARD_DIR, 'GraphBoard.tsx');
    expect(graph).toContain('const lockedNode = nodesRef.current.find((candidate) => {');
    expect(graph).toContain(
      'return modelLocked(modelForNode(candidate.data as unknown as GenerateData));',
    );
  });

  it('mobile and desktop share the preflight entitlement predicate and mobile upsell', () => {
    const runner = read(join(__dirname, 'board-run-request.ts'));
    const graph = read(BOARD_DIR, 'GraphBoard.tsx');
    const mobile = read(join(BOARD_DIR, '_mobile', 'MobileBoard.tsx'));
    expect(runner).toContain('boardRunModelLocked');
    expect(graph).toContain('boardRunModelLocked');
    expect(mobile).toContain('data-testid="mobile-board-run-upsell"');
    expect(mobile).toContain('lockedCtaHref');
  });

  it('the node picker marks out-of-plan rows locked and swaps run for the upsell', () => {
    const nodes = read(BOARD_DIR, 'BoardNodes.tsx');
    expect(nodes).toContain('isModelLocked(m, planTier)');
    expect(nodes).toContain('data-testid="node-run-upsell"');
    expect(nodes).toContain('tierUpsellLabel');
    // The upsell link honours the resolved target instead of hardcoding /pricing.
    expect(nodes).toContain('href={lockedCtaHref}');
  });

  it('nothing on the board silently creates a node with an out-of-plan model', () => {
    const graph = read(BOARD_DIR, 'GraphBoard.tsx');
    // The «ключевой кадр» bridge invents a Seedream node on the user's behalf.
    expect(graph).toContain("unlockedModelsForMode(models, 'image', planTier)");
  });
});
