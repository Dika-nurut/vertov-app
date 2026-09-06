// Static marketing copy for /pricing. Token figures below are claims against the
// v14 price-row SSOT (`docs/business/pricing-v14-price-rows-2026-07-28.md`).
// The accompanying test binds every claim to an active seeded row, so a change
// to the charge catalogue cannot silently leave publication on an old ladder.

export interface PlanFit {
  /** 'v' = video (port-video dot), 'i' = image (port-image dot). */
  kind: 'v' | 'i';
  /** Bolded count, e.g. "21" or "1 060". */
  count: string;
  /** Trailing label, e.g. "видео Veo Lite". */
  label: string;
}

export interface PlanContent {
  fits: PlanFit[];
  checks: string[];
  /** «Популярно» sticker + accent treatment. */
  popular?: boolean;
}

const CHECKS_BASE = [
  'Сценарий — AI-сценарист',
  'Генерация — 20+ моделей',
  'Доска — узловые пайплайны',
  'Монтаж — таймлайн и рендер',
];

/** The Студия⟷Макс bezel pairs these two tiers into one plate. */
export const BEZEL_PAIR = ['studio', 'max'] as const;

/** «Лучшая цена» lime tag rides the dearest grid plate. */
export const BEST_VALUE_TIER = 'max';

export interface CostRow {
  model: string;
  /** Small mono config suffix, e.g. "720p · звук". Optional. */
  cfg?: string;
  /** Token figure, e.g. "213" or "31–41". */
  tokens: string;
  /** Active v14 rows this published entry describes. Kept for the drift test. */
  claims: readonly PublishedPriceClaim[];
}

export interface PublishedPriceClaim {
  modelId: string;
  resolution: string;
  /** Base clip/image price from the price-row SSOT. */
  credits: number;
  /** Video claims must name the base clip duration they sell. */
  durationSeconds?: number;
  /**
   * Which audio configuration this row quotes, where the model prices both. Rev. 11
   * gave Kling two sellable rows — $0.126 per second with sound, $0.084 without —
   * and a page that names only the model and rung would bind whichever row came
   * first and could advertise the quiet price for an audible clip.
   */
  audio?: boolean;
  /**
   * Which CONFIGURATION this row quotes, where the model prices more than one.
   *
   * `mode` names the generation mode (Wan sells a framed shot above a text one,
   * because the cheap gateway will not serve it); `refsMin` names the reference band
   * (Flux and Seedream Pro price a multi-reference job as its own thing). Both default
   * to «the plain row», and both must be stated wherever a rung has two prices — a
   * page that names only the model and rung would publish whichever row came first,
   * which is always the cheaper one.
   */
  mode?: string;
  refsMin?: number;
}

type CostRowSource = Omit<CostRow, 'tokens'>;
const price = (
  modelId: string,
  resolution: string,
  credits: number,
  durationSeconds?: number,
  audio?: boolean,
  config?: { mode?: string; refsMin?: number },
): PublishedPriceClaim => ({
  modelId,
  resolution,
  credits,
  ...(durationSeconds ? { durationSeconds } : {}),
  ...(audio === undefined ? {} : { audio }),
  ...(config?.mode === undefined ? {} : { mode: config.mode }),
  ...(config?.refsMin === undefined ? {} : { refsMin: config.refsMin }),
});
const costs = (rows: readonly CostRowSource[]): CostRow[] =>
  rows.map((row) => ({
    ...row,
    tokens: [...new Set(row.claims.map((claim) => claim.credits))].join('–'),
  }));

// «Сколько стоит генерация» — generated from explicit v14 SSOT claims. For
// video, every per-clip amount names the row's base duration.
export const COST_VIDEO = costs([
  {
    model: 'Grok Imagine',
    cfg: '720p · 6 с',
    claims: [price('grok-imagine-video', '720p', 69, 6)],
  },
  {
    model: 'Veo 3.1 Lite',
    cfg: '720p · звук · 8 с',
    claims: [price('veo-3-1-lite', '720p', 66, 8)],
  },
  {
    model: 'Seedance 2.0 Fast',
    cfg: '720p · 5 с',
    claims: [price('seedance-2-0-fast', '720p', 259, 5)],
  },
  {
    model: 'Veo 3.1 Fast',
    cfg: '720p · звук · 8 с',
    claims: [price('veo-3-1-fast', '720p', 122, 8)],
  },
  { model: 'HappyHorse 1.1', cfg: '720p · 5 с', claims: [price('happyhorse-1-1', '720p', 212, 5)] },
  {
    model: 'Gemini Omni',
    // 720p only, deliberately: neither leg sells a higher rung (owner ruling 2026-08-09).
    cfg: '720p · 8 с',
    claims: [price('gemini-omni-flash', 'default', 273, 8)],
  },
  {
    // ONE row since rev. 21, where there were two. A framed shot used to cost more on
    // this model and the page had to say so: the cheap gateway served text-to-video
    // only, so a still-conditioned shot ran on the dearer leg. `wan/2-7-image-to-video`
    // was wired on 2026-08-11 and both modes now run the same kie leg at the same rate,
    // so the page publishes one price and BINDS BOTH MODES to it — two identical rows
    // would read as a distinction we no longer charge for.
    model: 'Wan 2.7',
    cfg: '720p · в т.ч. из кадра · 5 с',
    claims: [
      price('wan-2-7', '720p', 163, 5, undefined, { mode: 'any' }),
      price('wan-2-7', '720p', 163, 5, undefined, { mode: 'i2v' }),
    ],
  },
  {
    // Two rows since rev. 11: the vendor charges $0.126 per second with sound and
    // $0.084 without, both are sellable, and the page has to say which one it is
    // quoting or it advertises the cheap number for the audible job.
    model: 'Kling v3',
    cfg: '720p · звук · 5 с',
    claims: [price('kling-v3-0-std', '720p', 270, 5, true)],
  },
  {
    model: 'Kling v3',
    cfg: '720p · без звука · 5 с',
    claims: [price('kling-v3-0-std', '720p', 180, 5, false)],
  },
  { model: 'Seedance 2.0', cfg: '1080p · 5 с', claims: [price('seedance-2-0', '1080p', 775, 5)] },
  {
    model: 'Veo 3.1 Quality',
    cfg: '1080p · звук · 8 с',
    claims: [price('veo-3-1', '1080p', 597, 8)],
  },
]);

export const COST_PHOTO = costs([
  { model: 'Nano Banana 2 Lite', claims: [price('gemini-3-1-flash-lite-image', 'default', 9)] },
  {
    model: 'Seedream 5.0 Lite',
    cfg: '2K / 3K / 4K',
    claims: [
      price('seedream-5-0-lite', '2K', 12),
      price('seedream-5-0-lite', '3K', 14),
      price('seedream-5-0-lite', '4K', 17),
    ],
  },
  { model: 'GPT Image 2', cfg: 'low', claims: [price('gpt-image-2', 'low', 13)] },
  {
    model: 'Seedream 5.0 Pro',
    cfg: '1K / 2K · до 1 референса',
    claims: [
      price('seedream-5-0-pro', '1K', 16, undefined, undefined, { refsMin: 0 }),
      price('seedream-5-0-pro', '2K', 31, undefined, undefined, { refsMin: 0 }),
    ],
  },
  {
    model: 'Seedream 5.0 Pro',
    cfg: '1K / 2K · от 2 референсов',
    claims: [
      price('seedream-5-0-pro', '1K', 24, undefined, undefined, { refsMin: 2 }),
      price('seedream-5-0-pro', '2K', 38, undefined, undefined, { refsMin: 2 }),
    ],
  },
  {
    model: 'Nano Banana 2',
    cfg: '1K / 2K / 4K',
    claims: [
      price('gemini-3-1-flash-image', '1K', 17),
      price('gemini-3-1-flash-image', '2K', 23),
      price('gemini-3-1-flash-image', '4K', 28),
    ],
  },
  { model: 'Recraft V4', claims: [price('recraft-v4', 'default', 18)] },
  { model: 'GPT Image 2', cfg: 'high', claims: [price('gpt-image-2', 'high', 33)] },
  {
    model: 'Nano Banana Pro',
    cfg: '1K / 2K / 4K',
    claims: [
      price('gemini-3-pro-image', '1K', 37),
      price('gemini-3-pro-image', '2K', 43),
      price('gemini-3-pro-image', '4K', 50),
    ],
  },
  { model: 'Recraft V4 Vector', cfg: 'SVG', claims: [price('recraft-v4-vector', 'default', 35)] },
  // rev. 14 re-banded Flux's cheap rung `default` → `1K` and opened `2K`. The former
  // 1K 2–8-reference band is intentionally absent: the approved 2026-08-26 ruling
  // retired that exact row, so the page must not continue to promise it.
  {
    model: 'Flux 2 Pro',
    cfg: '1K · до 1 референса',
    claims: [price('flux-2-pro', '1K', 11, undefined, undefined, { refsMin: 0 })],
  },
  {
    model: 'Flux 2 Pro',
    cfg: '2K · до 1 референса',
    // Named since rev. 19: 2K now prices three configurations — plain, image-to-image
    // and the 2–8 reference band. All three are 15 credits, because kie bills the image
    // and does not meter the input, so the PUBLISHED number does not change. The claim
    // still has to say which row it quotes, or the page binds to whichever came first
    // and would go on agreeing by luck after any one of them moved.
    claims: [price('flux-2-pro', '2K', 15, undefined, undefined, { mode: 'any', refsMin: 0 })],
  },
]);

interface PlanFitSource {
  kind: PlanFit['kind'];
  label: string;
  creditsPerCycle: number;
  claim: PublishedPriceClaim;
}
const planFit = ({ kind, label, creditsPerCycle, claim }: PlanFitSource): PlanFit => ({
  kind,
  count: Math.floor(creditsPerCycle / claim.credits).toLocaleString('ru-RU'),
  label,
});
const PLAN_CREDITS = { start: 1175, plus: 4400, pro: 10300, studio: 15900, max: 32500 } as const;
const veoLite = price('veo-3-1-lite', '720p', 66, 8);
const seedanceFast = price('seedance-2-0-fast', '720p', 259, 5);
const seedance1080 = price('seedance-2-0', '1080p', 775, 5);
const veoFast = price('veo-3-1-fast', '720p', 122, 8);
const nanoBanana2 = price('gemini-3-1-flash-image', '1K', 17);
const seedreamLite = price('seedream-5-0-lite', '2K', 12);

// Keyed by backend tier. Counts are floor(plan credits ÷ the active base clip /
// image price), never scaled from an old mock.
export const PLAN_FIT_CLAIMS: Record<keyof typeof PLAN_CREDITS, readonly PlanFitSource[]> = {
  start: [
    { kind: 'v', label: 'видео Veo Lite', creditsPerCycle: PLAN_CREDITS.start, claim: veoLite },
    {
      kind: 'v',
      label: 'видео Seedance Fast',
      creditsPerCycle: PLAN_CREDITS.start,
      claim: seedanceFast,
    },
    {
      kind: 'i',
      label: 'фото Seedream 5.0 Lite',
      creditsPerCycle: PLAN_CREDITS.start,
      claim: seedreamLite,
    },
  ],
  plus: [
    {
      kind: 'v',
      label: 'видео Seedance Fast',
      creditsPerCycle: PLAN_CREDITS.plus,
      claim: seedanceFast,
    },
    {
      kind: 'i',
      label: 'фото Seedream 5.0 Lite',
      creditsPerCycle: PLAN_CREDITS.plus,
      claim: seedreamLite,
    },
  ],
  pro: [
    { kind: 'v', label: 'видео Veo Fast', creditsPerCycle: PLAN_CREDITS.pro, claim: veoFast },
    {
      kind: 'v',
      label: 'видео Seedance 1080p',
      creditsPerCycle: PLAN_CREDITS.pro,
      claim: seedance1080,
    },
    {
      kind: 'i',
      label: 'фото Nano Banana 2',
      creditsPerCycle: PLAN_CREDITS.pro,
      claim: nanoBanana2,
    },
    {
      kind: 'i',
      label: 'фото Seedream 5.0 Lite',
      creditsPerCycle: PLAN_CREDITS.pro,
      claim: seedreamLite,
    },
  ],
  studio: [
    {
      kind: 'v',
      label: 'видео Seedance Fast',
      creditsPerCycle: PLAN_CREDITS.studio,
      claim: seedanceFast,
    },
    {
      kind: 'v',
      label: 'видео Seedance 1080p',
      creditsPerCycle: PLAN_CREDITS.studio,
      claim: seedance1080,
    },
    {
      kind: 'i',
      label: 'фото Nano Banana 2',
      creditsPerCycle: PLAN_CREDITS.studio,
      claim: nanoBanana2,
    },
    {
      kind: 'i',
      label: 'фото Seedream 5.0 Lite',
      creditsPerCycle: PLAN_CREDITS.studio,
      claim: seedreamLite,
    },
  ],
  max: [
    {
      kind: 'v',
      label: 'видео Seedance Fast',
      creditsPerCycle: PLAN_CREDITS.max,
      claim: seedanceFast,
    },
    {
      kind: 'v',
      label: 'видео Seedance 1080p',
      creditsPerCycle: PLAN_CREDITS.max,
      claim: seedance1080,
    },
    {
      kind: 'i',
      label: 'фото Nano Banana 2',
      creditsPerCycle: PLAN_CREDITS.max,
      claim: nanoBanana2,
    },
    {
      kind: 'i',
      label: 'фото Seedream 5.0 Lite',
      creditsPerCycle: PLAN_CREDITS.max,
      claim: seedreamLite,
    },
  ],
};

export const PLAN_CONTENT: Record<string, PlanContent> = {
  start: {
    fits: PLAN_FIT_CLAIMS.start.map(planFit),
    checks: [...CHECKS_BASE, 'Seedance — Fast'],
  },
  plus: {
    fits: PLAN_FIT_CLAIMS.plus.map(planFit),
    checks: [...CHECKS_BASE, 'Seedance — Fast'],
  },
  pro: {
    popular: true,
    fits: PLAN_FIT_CLAIMS.pro.map(planFit),
    checks: [...CHECKS_BASE, 'Seedance — все модели'],
  },
  studio: {
    fits: PLAN_FIT_CLAIMS.studio.map(planFit),
    checks: [
      ...CHECKS_BASE,
      'Seedance — все модели',
      'Ранний доступ к новым моделям',
      'Самая низкая цена за токен',
    ],
  },
  max: {
    fits: PLAN_FIT_CLAIMS.max.map(planFit),
    checks: [
      ...CHECKS_BASE,
      'Seedance — все модели',
      'Ранний доступ к новым моделям',
      'Самая низкая цена за токен',
    ],
  },
};

export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: 'Токены сгорают?',
    a: 'Из разовых пакетов — никогда. По подписке начисляются каждый месяц; условия остатка — в оферте, на одной странице.',
  },
  {
    q: 'Почему у моделей разная цена?',
    a: 'Вендоры берут с нас за каждую генерацию по-разному: Veo Quality дороже Grok почти в двадцать раз. Цена в токенах повторяет эту разницу честно.',
  },
  {
    q: 'Как оплатить?',
    a: 'СБП, карты «Мир» и другие способы — через интернет-эквайринг Точка Банка. Чек по 54-ФЗ приходит на почту автоматически.',
  },
  {
    q: 'Можно вернуть деньги?',
    a: 'Да, за неиспользованные токены — по оферте. Без мелкого шрифта.',
  },
  {
    q: 'Что за бесплатные токены?',
    a: 'До 400 токенов в подарок, по шагам: 130 сразу за регистрацию любым способом (почта, VK, Яндекс, телефон), +70 когда вернётесь на следующий день и сделаете первую генерацию, +100 за подтверждение номера и ещё +100 за первую покупку. Стартовые 130 сгорают через 72 часа, если их не потратить. Бесплатные токены действуют на Seedance Mini 480p с вотермарком.',
  },
  {
    q: 'Нужна ли подписка, чтобы смотреть?',
    a: 'Нет. Витрина и чужие работы открыты без регистрации; пресеты доступны прямо внутри Генерации. Токены нужны только для собственных генераций.',
  },
];
