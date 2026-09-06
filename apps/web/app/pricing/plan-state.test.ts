import { describe, expect, it } from 'vitest';
import {
  arePacksUnlocked,
  bezelLockedTier,
  deriveCta,
  isLegacyActiveTier,
  type PricingContext,
} from './plan-state';

// The visible 5-tier grid, cheapest → dearest, mirroring the seeded catalog.
const GRID = [
  { tier: 'start', priceRub: 599 },
  { tier: 'plus', priceRub: 1649 },
  { tier: 'pro', priceRub: 3799 },
  { tier: 'studio', priceRub: 5799 },
  { tier: 'max', priceRub: 11699 },
] as const;
const GRID_TIERS = GRID.map((p) => p.tier);

const guest: PricingContext = {
  guest: true,
  activeTier: null,
  activePriceRub: null,
  planBlocked: false,
  planStateUnknown: false,
};
const authedNoSub: PricingContext = {
  guest: false,
  activeTier: null,
  activePriceRub: null,
  planBlocked: false,
  planStateUnknown: false,
};
const authedPro: PricingContext = {
  guest: false,
  activeTier: 'pro',
  activePriceRub: 3799,
  planBlocked: false,
  planStateUnknown: false,
};
const authedMax: PricingContext = {
  guest: false,
  activeTier: 'max',
  activePriceRub: 11699,
  planBlocked: false,
  planStateUnknown: false,
};
const legacyCreator: PricingContext = {
  guest: false,
  activeTier: 'creator',
  activePriceRub: 1490,
  planBlocked: false,
  planStateUnknown: false,
};
const elapsedSubscriber = {
  guest: false,
  activeTier: null,
  activePriceRub: null,
  planBlocked: true,
  planStateUnknown: false,
};
const subscriptionStateUnknown = {
  guest: false,
  activeTier: null,
  activePriceRub: null,
  planBlocked: false,
  planStateUnknown: true,
} as PricingContext;

describe('deriveCta — guest', () => {
  it('every plate routes to login with «Получить»', () => {
    for (const plate of GRID) {
      const cta = deriveCta(plate, guest);
      expect(cta).toEqual({ label: 'Получить', action: 'login', disabled: false });
    }
  });
});

describe('deriveCta — authed, no active subscription', () => {
  it('every plate offers a real subscribe with «Получить»', () => {
    for (const plate of GRID) {
      const cta = deriveCta(plate, authedNoSub);
      expect(cta).toEqual({ label: 'Получить', action: 'subscribe', disabled: false });
    }
  });
});

describe('deriveCta — elapsed subscription with no live plan access', () => {
  it('routes every plate to subscription management, never an upgrade or a new subscription', () => {
    for (const plate of GRID) {
      expect(deriveCta(plate, elapsedSubscriber)).toEqual({
        label: 'Управлять подпиской',
        action: 'manage',
        disabled: false,
      });
    }
  });

  it('locks packs and suppresses all live-plan affordances', () => {
    expect(arePacksUnlocked(elapsedSubscriber)).toBe(false);
    expect(isLegacyActiveTier(elapsedSubscriber, GRID_TIERS)).toBe(false);
    expect(bezelLockedTier(elapsedSubscriber, ['studio', 'max'])).toBeNull();
  });
});

describe('deriveCta — authenticated user whose subscription lookup failed', () => {
  it('fails closed to billing management, while guest and live-plan behaviour remains separate', () => {
    expect(deriveCta({ tier: 'max', priceRub: 11699 }, subscriptionStateUnknown)).toEqual({
      label: 'Управлять подпиской',
      action: 'manage',
      disabled: false,
    });
    expect(arePacksUnlocked(subscriptionStateUnknown)).toBe(false);
    expect(isLegacyActiveTier(subscriptionStateUnknown, GRID_TIERS)).toBe(false);
    expect(bezelLockedTier(subscriptionStateUnknown, ['studio', 'max'])).toBeNull();
  });
});

describe('deriveCta — authed with active «Про» subscription', () => {
  it('marks the Про plate as the current tier — a lime status marker, not an action', () => {
    const cta = deriveCta({ tier: 'pro', priceRub: 3799 }, authedPro);
    expect(cta).toEqual({
      label: 'Текущий тариф',
      action: 'none',
      disabled: true,
      status: true,
    });
  });

  it('offers «Перейти» (upgrade) on dearer plates — Студия, Макс', () => {
    expect(deriveCta({ tier: 'studio', priceRub: 5799 }, authedPro)).toEqual({
      label: 'Перейти',
      action: 'upgrade',
      disabled: false,
    });
    expect(deriveCta({ tier: 'max', priceRub: 11699 }, authedPro)).toEqual({
      label: 'Перейти',
      action: 'upgrade',
      disabled: false,
    });
  });

  it('offers «Перейти» (downgrade) on cheaper plates — Старт, Плюс', () => {
    expect(deriveCta({ tier: 'start', priceRub: 599 }, authedPro)).toEqual({
      label: 'Перейти',
      action: 'downgrade',
      disabled: false,
    });
    expect(deriveCta({ tier: 'plus', priceRub: 1649 }, authedPro)).toEqual({
      label: 'Перейти',
      action: 'downgrade',
      disabled: false,
    });
  });
});

describe('deriveCta — a scheduled downgrade (Про → Старт)', () => {
  const proDowngradingToStart: PricingContext = {
    guest: false,
    activeTier: 'pro',
    activePriceRub: 3799,
    pendingTier: 'start',
    planBlocked: false,
    planStateUnknown: false,
  };

  it('shows the target plate as «Запланирован» and cancellable', () => {
    expect(deriveCta({ tier: 'start', priceRub: 599 }, proDowngradingToStart)).toEqual({
      label: 'Запланирован',
      action: 'cancel-downgrade',
      disabled: false,
      scheduled: true,
    });
  });

  it('keeps the current Про plate a lime status marker while the downgrade is pending', () => {
    expect(deriveCta({ tier: 'pro', priceRub: 3799 }, proDowngradingToStart).status).toBe(true);
  });

  it('leaves a different cheaper plate (Плюс) as an ordinary downgrade', () => {
    expect(deriveCta({ tier: 'plus', priceRub: 1649 }, proDowngradingToStart).action).toBe(
      'downgrade',
    );
  });
});

describe('deriveCta — authed on the top tier «Макс»', () => {
  it('marks Макс current and every cheaper plate as a downgrade', () => {
    expect(deriveCta({ tier: 'max', priceRub: 11699 }, authedMax).status).toBe(true);
    for (const plate of GRID.filter((p) => p.tier !== 'max')) {
      expect(deriveCta(plate, authedMax).action).toBe('downgrade');
    }
  });
});

describe('deriveCta — legacy «Креатор» subscriber (tier not in the grid)', () => {
  it('splits the grid by price: dearer than 1490 ⇒ upgrade, cheaper ⇒ downgrade', () => {
    // start 599 < 1490 → downgrade; plus 1649 > 1490 → upgrade.
    expect(deriveCta({ tier: 'start', priceRub: 599 }, legacyCreator).action).toBe('downgrade');
    expect(deriveCta({ tier: 'plus', priceRub: 1649 }, legacyCreator).action).toBe('upgrade');
    expect(deriveCta({ tier: 'max', priceRub: 11699 }, legacyCreator).action).toBe('upgrade');
  });
});

describe('arePacksUnlocked', () => {
  it('locks packs for guests and authed-without-sub, unlocks for subscribers', () => {
    expect(arePacksUnlocked(guest)).toBe(false);
    expect(arePacksUnlocked(authedNoSub)).toBe(false);
    expect(arePacksUnlocked(authedPro)).toBe(true);
    expect(arePacksUnlocked(legacyCreator)).toBe(true);
  });
});

describe('isLegacyActiveTier', () => {
  it('is true only when an active tier is absent from the visible grid', () => {
    expect(isLegacyActiveTier(guest, GRID_TIERS)).toBe(false);
    expect(isLegacyActiveTier(authedNoSub, GRID_TIERS)).toBe(false);
    expect(isLegacyActiveTier(authedPro, GRID_TIERS)).toBe(false);
    expect(isLegacyActiveTier(legacyCreator, GRID_TIERS)).toBe(true);
  });
});

describe('bezelLockedTier — Студия⟷Макс', () => {
  const pair = ['studio', 'max'] as const;

  it('is unlocked (null) for guests, no-sub, and unrelated tiers', () => {
    expect(bezelLockedTier(guest, pair)).toBeNull();
    expect(bezelLockedTier(authedNoSub, pair)).toBeNull();
    expect(bezelLockedTier(authedPro, pair)).toBeNull();
  });

  it('locks to the active tier when it is one of the pair', () => {
    expect(
      bezelLockedTier(
        {
          guest: false,
          activeTier: 'studio',
          activePriceRub: 5799,
          planBlocked: false,
          planStateUnknown: false,
        },
        pair,
      ),
    ).toBe('studio');
    expect(bezelLockedTier(authedMax, pair)).toBe('max');
  });
});
