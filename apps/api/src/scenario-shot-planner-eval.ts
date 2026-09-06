import {
  MODEL_PRICES_USD_PER_MTOK,
  STRUCTURIZE_MAX_ATTEMPTS,
  STRUCTURIZE_TOKEN_BUDGET,
} from '@seed/shared';
import {
  SCENARIO_SHOT_PLAN_VERSION,
  scenarioShotPlanSchema,
  type ScenarioShotPlan,
} from '@seed/shared/scenario-shot-plan';

export interface ScenarioShotPlanEvalCase {
  id: string;
  format: 'film' | 'social' | 'ad' | 'sketch';
  sourceText: string;
  targetDurationSeconds: number;
  allowedLockIds: string[];
  expectsUnresolvedAsset: boolean;
  golden: ScenarioShotPlan;
}

const seeds = {
  film: [
    'Механик находит в старом автобусе письмо, которое меняет решение о поездке.',
    'Сестры встречаются на вокзале после десяти лет молчания и делят один билет.',
    'Ночной сторож слышит музыку в закрытом театре и решает войти внутрь.',
    'Учитель прячет дневник ученика, чтобы защитить его от чужого решения.',
    'Повар получает заказ от человека, которого считал погибшим.',
    'Дочь возвращает отцу ключи от дома перед последним поездом.',
    'Фотограф замечает на снимке деталь, которой не было в комнате.',
    'Капитан выбирает короткий маршрут, хотя карта предупреждает о шторме.',
    'Соседи находят во дворе чужой чемодан и спорят, кто позвонит в полицию.',
    'Бывший музыкант слышит свою старую мелодию из квартиры напротив.',
    'Подросток записывает признание на кассету, но стирает его перед встречей.',
    'Врач узнаёт голос пациента в старой радиопередаче.',
    'Отец и сын чинят лодку, пока вода поднимается к причалу.',
  ],
  social: [
    'Покажи быстрый способ спасти пересоленный суп без лишней воды.',
    'Один день человека, который впервые вышел на утренний бег.',
    'Три признака, что домашнее растение просит света, а не воды.',
    'Реакция собаки на звук открывающейся коробки с игрушкой.',
    'Как за минуту собрать рабочее место в маленькой комнате.',
    'Честный тест дешёвого зонта под сильным дождём.',
    'До и после: уборка кухни с одним таймером на десять минут.',
    'Покажи, как отличить спелый арбуз на рынке.',
    'Мини-интервью с курьером о самом странном адресе за день.',
    'Лайфхак для хранения кабелей, который не требует покупки органайзера.',
    'Что происходит с кофе, если дать ему остыть и добавить лёд.',
    'Распаковка старого фотоаппарата с одной неожиданной находкой.',
    'Пять секунд тишины перед тем, как ребёнок впервые видит снег.',
  ],
  ad: [
    'Покажи термокружку, которая сохраняет кофе горячим до конца дороги.',
    'Реклама приложения: один экран превращает список дел в понятный маршрут.',
    'Чемодан переживает дождь, лестницу и тесную полку в поезде.',
    'Пекарня показывает хрустящую корочку и приглашает на завтрак.',
    'Кроссовки помогают пройти новый город без остановки из-за усталости.',
    'Сервис доставки привозит ужин ровно к моменту возвращения домой.',
    'Настольная лампа меняет свет, когда ребёнок открывает книгу.',
    'Крем защищает руки садовника после работы с землёй.',
    'Наушники оставляют музыку слышной, а объявление на станции — различимым.',
    'Рюкзак помещает вещи для рабочего дня и не теряет форму.',
    'Приложение показывает владельцу, где припаркована машина.',
    'Соковыжималка превращает завтрак в один тихий жест.',
    'Камера фиксирует семейную прогулку без сложных настроек.',
  ],
  sketch: [
    'Человек пытается заказать такси, но приложение каждый раз предлагает его дому.',
    'Два коллеги спорят, кто из них сегодня должен быть серьёзным.',
    'Кот становится начальником отдела и вводит запрет на закрытые двери.',
    'Покупатель возвращает идеальный подарок, потому что упаковка слишком красивая.',
    'Робот-пылесос требует отпуск после одного круга по кухне.',
    'Сосед просит тишины и тут же начинает репетицию на саксофоне.',
    'Человек готовит презентацию о том, почему больше не будет презентаций.',
    'Бабушка проходит собеседование на должность собственного внука.',
    'Друзья прячут сюрприз, но каждый считает себя единственным организатором.',
    'Охранник музея объясняет статуе правила поведения посетителей.',
    'Почтальон доставляет письмо самому себе и требует подпись.',
    'Бариста принимает заказ без слов, но ошибается только в настроении гостя.',
    'Семья выбирает фильм и три часа смотрит меню телевизора.',
  ],
} as const;

function makeGolden(
  id: string,
  format: ScenarioShotPlanEvalCase['format'],
  sourceText: string,
  targetDurationSeconds: number,
  expectsUnresolvedAsset: boolean,
): ScenarioShotPlan {
  const first = Math.floor(targetDurationSeconds / 3);
  const durations = [first, first, targetDurationSeconds - first * 2];
  const excerpt = sourceText.slice(0, 72);
  return {
    version: SCENARIO_SHOT_PLAN_VERSION,
    sceneId: `eval:${id}`,
    targetDurationSeconds,
    shots: durations.map((durationSec, index) => ({
      order: index + 1,
      title: `${format}: действие ${index + 1} — ${excerpt.slice(0, 38)}`,
      durationSec,
      dramaticBeat: `Состояние героя меняется на шаге ${index + 1}: ${excerpt}`,
      promptDraft: `Кадр ${index + 1}: конкретное действие из сцены «${excerpt}».`,
      shotGrammar: {
        size: index === 0 ? 'medium' : 'close',
        move: index === 1 ? 'push-in' : 'static',
        energy: index === 2 ? 'release' : 'rising',
      },
      requiredLocks: ['canon:character:1'],
      unresolvedAssets: expectsUnresolvedAsset && index === 1 ? ['неуказанный референс'] : [],
    })),
  };
}

export const SCENARIO_SHOT_PLAN_EVAL_CORPUS: ScenarioShotPlanEvalCase[] = (
  Object.entries(seeds) as Array<[ScenarioShotPlanEvalCase['format'], readonly string[]]>
).flatMap(([format, entries]) =>
  entries.map((sourceText, index) => {
    const id = `${format}-${String(index + 1).padStart(2, '0')}`;
    const targetDurationSeconds =
      format === 'film' ? 60 : format === 'ad' ? 24 : format === 'sketch' ? 48 : 30;
    const expectsUnresolvedAsset = index % 4 === 0;
    return {
      id,
      format,
      sourceText,
      targetDurationSeconds,
      allowedLockIds: ['canon:character:1'],
      expectsUnresolvedAsset,
      golden: makeGolden(id, format, sourceText, targetDurationSeconds, expectsUnresolvedAsset),
    };
  }),
);

export interface ScenarioShotPlanEvalScore {
  validJsonFirstAttempt: boolean;
  durationSumExact: boolean;
  shotsConcrete: boolean;
  locksCorrect: boolean;
  unresolvedAssetsCorrect: boolean;
  passed: boolean;
  score: number;
}

const PLACEHOLDER = /^(?:shot|кадр|scene|сцена|beat|бит)\s*\d*$/iu;

export function scoreScenarioShotPlan(
  entry: ScenarioShotPlanEvalCase,
  plan: unknown,
): ScenarioShotPlanEvalScore {
  const parsed = scenarioShotPlanSchema.safeParse(plan);
  const validJsonFirstAttempt = parsed.success;
  const value = parsed.success ? parsed.data : null;
  const durationSumExact =
    value?.targetDurationSeconds === entry.targetDurationSeconds &&
    value.shots.reduce((sum, shot) => sum + shot.durationSec, 0) === entry.targetDurationSeconds;
  const shotsConcrete =
    value !== null &&
    value.shots.length >= 2 &&
    value.shots.every(
      (shot) =>
        shot.title.length >= 12 &&
        !PLACEHOLDER.test(shot.title) &&
        shot.promptDraft.length >= 20 &&
        shot.dramaticBeat.length >= 12,
    );
  const locksCorrect =
    value !== null &&
    value.shots.every((shot) =>
      shot.requiredLocks.every((lock) => entry.allowedLockIds.includes(lock)),
    );
  const unresolvedAssetsCorrect =
    value !== null &&
    (entry.expectsUnresolvedAsset
      ? value.shots.some((shot) => shot.unresolvedAssets.length > 0)
      : value.shots.every((shot) => shot.unresolvedAssets.every((asset) => asset.length >= 1)));
  const checks = [
    validJsonFirstAttempt,
    durationSumExact,
    shotsConcrete,
    locksCorrect,
    unresolvedAssetsCorrect,
  ];
  const score = checks.filter(Boolean).length / checks.length;
  return {
    validJsonFirstAttempt,
    durationSumExact,
    shotsConcrete,
    locksCorrect,
    unresolvedAssetsCorrect,
    passed: checks.every(Boolean),
    score,
  };
}

export interface ScenarioShotPlanModelEval {
  model: string;
  mode: 'mock_replay';
  sceneCount: number;
  validJsonRate: number;
  passRate: number;
  meanScore: number;
  costPerSuccessUsd: number;
}

function worstCaseCost(model: string): number {
  const price = MODEL_PRICES_USD_PER_MTOK[model];
  if (!price) return Number.POSITIVE_INFINITY;
  return (
    (STRUCTURIZE_MAX_ATTEMPTS *
      (STRUCTURIZE_TOKEN_BUDGET.input * price.input +
        STRUCTURIZE_TOKEN_BUDGET.output * price.output)) /
    1_000_000
  );
}

export function runScenarioShotPlanMockEval(): ScenarioShotPlanModelEval[] {
  const scored = SCENARIO_SHOT_PLAN_EVAL_CORPUS.map((entry) =>
    scoreScenarioShotPlan(entry, entry.golden),
  );
  const passRate = scored.filter((score) => score.passed).length / scored.length;
  const meanScore = scored.reduce((sum, score) => sum + score.score, 0) / scored.length;
  return ['deepseek/deepseek-v4-flash', 'qwen/qwen3.5-plus-02-15'].map((model) => ({
    model,
    mode: 'mock_replay' as const,
    sceneCount: scored.length,
    validJsonRate: passRate,
    passRate,
    meanScore,
    costPerSuccessUsd: worstCaseCost(model) / Math.max(passRate, Number.EPSILON),
  }));
}
