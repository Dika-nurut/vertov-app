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
 * СГОРАНИЯ, ПОЭТОМУ ДОРОЖЕ ULTRA». Video/photo counts use the same conventions
 * as the subscription plates (`plan-content.ts`): 4s-minimum billing for Veo
 * Fast (213 ткн / 8s clip → 106.5 ткн / 4s clip, floored) and Seedream 5.0 Pro
 * at 15 ткн/photo.
 */
export const seedCreditPacks: CreditPackSeed[] = [
  {
    id: 'pack-s',
    credits: 500,
    priceRub: 299,
    title: 'S',
    description: '≈4 видео Veo Fast или 33 фото Seedream 5.0.',
    isActive: true,
    sortOrder: 10,
  },
  {
    id: 'pack-m',
    credits: 1500,
    priceRub: 799,
    title: 'M',
    description: '≈14 видео Veo Fast или 100 фото Seedream 5.0.',
    isActive: true,
    sortOrder: 20,
  },
  {
    id: 'pack-l',
    credits: 4000,
    priceRub: 1899,
    title: 'L',
    description: '≈37 видео Veo Fast или 266 фото Seedream 5.0.',
    isActive: true,
    sortOrder: 30,
  },
  {
    id: 'pack-xl',
    credits: 10000,
    priceRub: 4499,
    title: 'XL',
    description: '≈93 видео Veo Fast или 666 фото Seedream 5.0.',
    isActive: true,
    sortOrder: 40,
  },
  {
    id: 'pack-xxl',
    credits: 25000,
    priceRub: 10999,
    title: 'XXL',
    description: '≈234 видео Veo Fast или 1 666 фото Seedream 5.0.',
    isActive: true,
    sortOrder: 50,
  },
  ...legacyCreditPacks,
];
