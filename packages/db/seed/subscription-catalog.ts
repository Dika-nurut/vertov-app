/**
 * Subscription tier catalog — the 5-tier pricing grid (owner-approved v9 mock,
 * 2026-07-17). One priced row per plate; prices/token grants are the source of
 * truth the /pricing plates render from.
 *
 *   Старт  ₽599   → 1 175   Плюс ₽1 649 → 4 400   Про ₽3 799 → 10 300
 *   Студия ₽5 799 → 15 900  Макс ₽11 699 → 32 500
 *
 * `creator` is a LEGACY tier (the old «Креатор»): kept in the catalog but
 * deactivated (`isActive:false`) so it drops out of `/v1/billing/tiers` while
 * existing Креатор subscribers still resolve their title on the account/pricing
 * pages. Existing subscribers are NOT migrated — their price/credits snapshot
 * lives on the `subscriptions` row.
 */
export interface SubscriptionTierSeed {
  tier: 'start' | 'plus' | 'pro' | 'studio' | 'max' | 'creator';
  priceRub: number;
  creditsPerCycle: number;
  title: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
}

export const seedSubscriptionTiers: SubscriptionTierSeed[] = [
  {
    tier: 'start',
    priceRub: 599,
    creditsPerCycle: 1175,
    title: 'Старт',
    description: '1 175 токенов в месяц. Вся линейка: сценарий, генерация, доска, монтаж.',
    isActive: true,
    sortOrder: 10,
  },
  {
    tier: 'plus',
    priceRub: 1649,
    creditsPerCycle: 4400,
    title: 'Плюс',
    description: '4 400 токенов в месяц. Больше видео и фото — дешевле за токен.',
    isActive: true,
    sortOrder: 20,
  },
  {
    tier: 'pro',
    priceRub: 3799,
    creditsPerCycle: 10300,
    title: 'Про',
    description: '10 300 токенов в месяц. Все модели Seedance, лучшая цена для потока.',
    isActive: true,
    sortOrder: 30,
  },
  {
    tier: 'studio',
    priceRub: 5799,
    creditsPerCycle: 15900,
    title: 'Студия',
    description:
      '15 900 токенов в месяц. Ранний доступ к новым моделям, самая низкая цена за токен.',
    isActive: true,
    sortOrder: 40,
  },
  {
    tier: 'max',
    priceRub: 11699,
    creditsPerCycle: 32500,
    title: 'Макс',
    description: '32 500 токенов в месяц. Та же Студия на максимальном объёме.',
    isActive: true,
    sortOrder: 50,
  },
  {
    // LEGACY — deactivated, retained so existing «Креатор» subs resolve.
    tier: 'creator',
    priceRub: 1490,
    creditsPerCycle: 4500,
    title: 'Креатор',
    description: 'Архивный тариф. Новые подписки открываются на актуальной линейке.',
    isActive: false,
    sortOrder: 90,
  },
];
