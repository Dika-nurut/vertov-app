import { eq } from 'drizzle-orm';
import { appSettings, db as defaultDb } from '@seed/db';

type DbLike = typeof defaultDb;
type Tx = Parameters<Parameters<DbLike['transaction']>[0]>[0];

/**
 * Runtime feature flags backed by the `app_settings` table. Read at grant time,
 * toggled by the admin PATCH route.
 *
 * Ships-as defaults (returned when no row exists yet):
 *   - free_grants_enabled  → false (fail-closed; an operator explicitly
 *                                    enables grants after checking the rollout)
 *   - phone_binding_enabled → false (SMSC operators unpaid; UI dark-launched)
 *   - smartcaptcha_enabled  → false until the client widget/token path ships
 */
export const FREE_GRANTS_ENABLED = 'free_grants_enabled';
export const PHONE_BINDING_ENABLED = 'phone_binding_enabled';
export const SMARTCAPTCHA_ENABLED = 'smartcaptcha_enabled';
export const FREE_COHORT_FREEZE = 'free_program_cohort_freeze';
export const PROMPT_ENHANCER_ENABLED = 'prompt_enhancer_enabled';

export const APP_FLAG_DEFAULTS: Record<string, boolean> = {
  [FREE_GRANTS_ENABLED]: false,
  [PHONE_BINDING_ENABLED]: false,
  // Deferred: SmartCaptcha has no client widget/token-forwarding path yet.
  [SMARTCAPTCHA_ENABLED]: false,
  [FREE_COHORT_FREEZE]: false,
  // Disabled at launch: the free prompt enhancer is not yet a paid, margin-guarded
  // feature. Flip to true only after it has credit reservation + pricing.
  [PROMPT_ENHANCER_ENABLED]: false,
};

export async function readBoolFlag(
  key: string,
  fallback: boolean,
  runner: DbLike | Tx = defaultDb,
): Promise<boolean> {
  // Materialise the safe default, then lock the row. This closes the race in
  // which an admin writes a flag while a grant is deciding whether to issue.
  // Missing/unknown flags are fail-closed; callers must explicitly enable them.
  await runner
    .insert(appSettings)
    .values({ key, value: APP_FLAG_DEFAULTS[key] ?? false, updatedBy: null })
    .onConflictDoNothing({ target: appSettings.key });
  const rows = await runner
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .for('update')
    .limit(1);
  if (rows.length === 0) return false;
  const v = rows[0]!.value;
  return typeof v === 'boolean' ? v : fallback && Boolean(v);
}

export async function writeBoolFlag(
  key: string,
  value: boolean,
  updatedBy: string | null,
  runner: DbLike | Tx = defaultDb,
): Promise<void> {
  await runner
    .insert(appSettings)
    .values({ key, value, updatedBy })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedBy, updatedAt: new Date() },
    });
}
