import { describe, expect, it } from 'vitest';
import { seedModels } from '@seed/db/seed/models';
import { FAQ } from '../app/pricing/plan-content';
import { getOnboardingCopy } from './onboarding-copy';
import {
  GIFT_TOKENS_DAILY,
  GIFT_TOKENS_DAILY_DAYS,
  GIFT_TOKENS_EXPIRY_HOURS,
  GIFT_TOKENS_FIRST_ORDER,
  GIFT_TOKENS_PHONE,
  GIFT_TOKENS_RETURN,
  GIFT_TOKENS_UPFRONT,
} from './gift-tokens';

describe('gift-token copy SSOT', () => {
  it('matches the backend welcome ladder defaults', () => {
    expect({
      upfront: GIFT_TOKENS_UPFRONT,
      return: GIFT_TOKENS_RETURN,
      phone: GIFT_TOKENS_PHONE,
      firstOrder: GIFT_TOKENS_FIRST_ORDER,
      daily: GIFT_TOKENS_DAILY,
      dailyDays: GIFT_TOKENS_DAILY_DAYS,
      expiryHours: GIFT_TOKENS_EXPIRY_HOURS,
    }).toEqual({
      upfront: 210,
      return: 70,
      phone: 100,
      firstOrder: 100,
      daily: 70,
      dailyDays: 3,
      expiryHours: 72,
    });
  });

  it('keeps the FAQ and onboarding copy tied to the shared figures', () => {
    const faq = FAQ.find((item) => item.q === 'Что за бесплатные токены?');
    expect(faq?.a).toContain(`${GIFT_TOKENS_UPFRONT} токенов сразу`);
    expect(faq?.a).toContain(`по +${GIFT_TOKENS_DAILY} за первый заход в день`);
    // Free tokens may only be promised on a model a free account can actually run.
    expect(faq?.a).toContain('Seedance 2.0 Mini');
    const mini = seedModels.find((m) => m.id === 'seedance-2-0-mini');
    expect(mini?.isActive).toBe(true);
    expect(mini?.tierMin).toBe('free');
    expect(faq?.a).toContain(`${GIFT_TOKENS_EXPIRY_HOURS} часа после начисления`);
    expect(getOnboardingCopy('ru').card.gift).toBe(`${GIFT_TOKENS_UPFRONT} токенов в подарок`);
    expect(getOnboardingCopy('en').card.gift).toBe(`${GIFT_TOKENS_UPFRONT} bonus tokens`);
  });
});
