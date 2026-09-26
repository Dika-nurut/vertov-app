export interface CreditPackSeed {
  id: string;
  credits: number;
  priceRub: number;
  title: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
}

// LEGACY — deactivated, retained (not deleted) so old order history still
// resolves a title via the billing-history join. Superseded 2026-07-17 by the
// finance workbook's authoritative pack grid (Тарифы!B23:E29).
const legacyCreditPacks: CreditPackSeed[] = [
  {
    id: 'pack-200',
    credits: 200,
    priceRub: 199,
    title: 'Стартовый',
    description: 'Около 13 изображений Seedream.',
    isActive: false,
    sortOrder: 10,
  },
  {
    id: 'pack-1000',
    credits: 1000,
    priceRub: 899,
    title: 'Стандарт',
    description: '~66 изображений Seedream или 16 секунд Seedance 1.0.',
    isActive: false,
    sortOrder: 20,
  },
  {
    id: 'pack-5000',
    credits: 5000,
    priceRub: 3990,
    title: 'Студия',
    description: '~333 изображения Seedream или 15 секунд Seedance 2.0.',
    isActive: false,
    sortOrder: 30,
  },
];

/**
 * Docs/finance workbook «Тарифы!B23:E29» — «ДОКУПКА КРЕДИТОВ — БЕЗ СРОКА
 * СГОРАНИЯ, ПОЭТОМУ ДОРОЖЕ ULTRA». Packs are sold only on top of a live plan
 * (K-3), so the counts name models the cheapest plan (Старт) unlocks: Veo 3.1
 * Lite 720p at 66 ткн per 8 s clip and Nano Banana 2 1K at 17 ткн. Counts are
 * floor(credits ÷ price), pinned against the price-point seed by
 * `apps/web/app/pricing/plan-content.test.ts`; migration 0112 carries them to prod.
 */
export const seedCreditPacks: CreditPackSeed[] = [
  {
    id: 'pack-s',
    credits: 500,
    priceRub: 299,
    title: 'S',
    description: '≈7 видео Veo Lite или 29 фото Nano Banana 2.',
    isActive: true,
    sortOrder: 10,
  },
  {
    id: 'pack-m',
    credits: 1500,
    priceRub: 799,
    title: 'M',
    description: '≈22 видео Veo Lite или 88 фото Nano Banana 2.',
    isActive: true,
    sortOrder: 20,
  },
  {
    id: 'pack-l',
    credits: 4000,
    priceRub: 1899,
    title: 'L',
    description: '≈60 видео Veo Lite или 235 фото Nano Banana 2.',
    isActive: true,
    sortOrder: 30,
  },
  {
    id: 'pack-xl',
    credits: 10000,
    priceRub: 4499,
    title: 'XL',
    description: '≈151 видео Veo Lite или 588 фото Nano Banana 2.',
    isActive: true,
    sortOrder: 40,
  },
  {
    id: 'pack-xxl',
    credits: 25000,
    priceRub: 10999,
    title: 'XXL',
    description: '≈378 видео Veo Lite или 1 470 фото Nano Banana 2.',
    isActive: true,
    sortOrder: 50,
  },
  ...legacyCreditPacks,
];
