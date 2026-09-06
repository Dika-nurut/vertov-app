import { assistTierStates, db } from '@seed/db';

/**
 * Admin ON/OFF state for the «Сценарий» assist text tiers (owner 2026-07-24).
 * The tiers themselves are code-configured (@seed/shared assist-tiers.ts); the
 * `assist_tier_states` table holds ONLY the switch (is_active + who/when).
 *
 * The assist route is hot, so reads go through a short process-local cache —
 * the same idiom as the 2-min provider-balances cache in admin-panel.ts. The
 * admin PATCH (text-tiers) calls `invalidateAssistTierStates` so a toggle takes
 * effect immediately in THIS process; other api processes pick it up within the
 * TTL. Fail-open ONLY at read time: a missing row means the tier was never
 * toggled → ACTIVE (the seed ships all three ACTIVE); writes upsert.
 */

export interface AssistTierStateView {
  isActive: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

const TIER_STATE_TTL_MS = 30_000;
let cache: { at: number; rows: Map<string, AssistTierStateView> } | null = null;

async function readStates(): Promise<Map<string, AssistTierStateView>> {
  if (cache && Date.now() - cache.at < TIER_STATE_TTL_MS) return cache.rows;
  const rows = await db.select().from(assistTierStates);
  const rows2 = new Map<string, AssistTierStateView>(
    rows.map((r) => [
      r.tierId,
      { isActive: r.isActive, updatedAt: r.updatedAt, updatedBy: r.updatedBy },
    ]),
  );
  cache = { at: Date.now(), rows: rows2 };
  return rows2;
}

/** One tier's state. A missing row reads as ACTIVE (never toggled). */
export async function assistTierState(tierId: string): Promise<AssistTierStateView> {
  const states = await readStates();
  return states.get(tierId) ?? { isActive: true, updatedAt: null, updatedBy: null };
}

/** True when the tier accepts new assist calls. */
export async function assistTierIsActive(tierId: string): Promise<boolean> {
  return (await assistTierState(tierId)).isActive;
}

/** All known rows, keyed by tier id (admin panel's textModels block). */
export async function assistTierStatesView(): Promise<Record<string, AssistTierStateView>> {
  return Object.fromEntries(await readStates());
}

/** Bust the process-local cache — called by the admin toggle route on write. */
export function invalidateAssistTierStates(): void {
  cache = null;
}
