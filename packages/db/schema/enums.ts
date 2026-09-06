import { pgEnum } from 'drizzle-orm/pg-core';

// 2026-07-17: expanded to the 5-tier pricing grid (Старт/Плюс/Про/Студия/Макс).
// `plus`/`pro`/`max` are new; `studio` predated the grid; `creator` is a LEGACY
// value kept only so existing Креатор subscribers still resolve — it is not in
// the active catalog. Enum values are additive/forward-only (never removed).
export const tierEnum = pgEnum('tier', [
  'free',
  'start',
  'creator',
  'studio',
  'plus',
  'pro',
  'max',
]);
export const userStatusEnum = pgEnum('user_status', ['active', 'banned', 'deleted']);

export const subStatusEnum = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'expired',
]);

export const creditAccountEnum = pgEnum('credit_account', [
  'available',
  'pending',
  'subscription_grant',
  'pack_grant',
  'bonus_grant',
  'refund',
  'spend',
]);

export const providerEnum = pgEnum('provider', ['byteplus', 'volcengine', 'yandex', 'stub']);
export const modelKindEnum = pgEnum('model_kind', ['image', 'image-edit', 'video', 'voice']);
export const unitKindEnum = pgEnum('unit_kind', ['image', 'second', '1k_chars']);

export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'refunded',
]);

export const galleryKindEnum = pgEnum('gallery_kind', ['image', 'video', 'audio']);

export const orderKindEnum = pgEnum('order_kind', ['subscription', 'pack']);
export const orderOurStatusEnum = pgEnum('order_our_status', [
  'pending',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
]);

/** Lifecycle of a provider refund request. Money/entitlement reversal is
 * allowed only after the provider reports `confirmed`; `pending` and
 * `rejected` are retained for operator reconciliation. */
export const refundStatusEnum = pgEnum('refund_status', [
  'pending',
  'confirmed',
  'applied',
  'rejected',
]);
