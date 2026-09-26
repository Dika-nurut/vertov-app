/**
 * Gift-token SSOT (WS3 — copy SSOT + credits voice).
 *
 * Mirrors the welcome ladder in `packages/credits/src/welcome.ts`
 * (`WELCOME_GRANT_AMOUNTS`: L0 210 / L1 70 / L2 100 / L3 100,
 * `L0_EXPIRY_HOURS`: 72). Web copy must not hardcode these numbers —
 * import them instead, so a ladder change updates every surface at once.
 *
 * Also mirrors the daily grant (`DAILY_GRANT_AMOUNT` 70 over `DAILY_WINDOW_DAYS` 3,
 * owner ruling 2026-07-27). Every headline CTA names ONE number — the upfront
 * grant; the full schedule is spelled out only in the pricing FAQ.
 */

/** L0 — registration grant, any method. Burns after GIFT_TOKENS_EXPIRY_HOURS if unspent. */
export const GIFT_TOKENS_UPFRONT = 210;
/** L1 — first qualified return (18h+, a new UTC day, completed generation). */
export const GIFT_TOKENS_RETURN = 70;
/** L2 — phone verification (settings workstream owns the copy, value stays here). */
export const GIFT_TOKENS_PHONE = 100;
/** L3 — first paid order. */
export const GIFT_TOKENS_FIRST_ORDER = 100;
/** Daily grant on the first visit of each Moscow day after registration. */
export const GIFT_TOKENS_DAILY = 70;
/** Number of days after registration the daily grant runs. */
export const GIFT_TOKENS_DAILY_DAYS = 3;
/** Unspent L0 and daily grants expire this long after they are credited. */
export const GIFT_TOKENS_EXPIRY_HOURS = 72;
