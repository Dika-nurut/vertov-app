import type { PresetPackInsert, PresetPackSlot } from '../schema/preset-packs';
import { composeCinemaTemplate, CINEMA_NEGATIVE } from './cinema-vocabulary';

/**
 * 12 preset packs × 2 locales (ru + en) = 24 rows.
 * samplePreviewUrl is read from the MINIO_PUBLIC_URL env var at runtime;
 * it points to the seed-preset-previews bucket where placeholder PNGs live.
 * The actual URL is resolved here so the seed file stays free of hardcoded IPs.
 */
const PUBLIC_BASE = (
  process.env.ASSET_PUBLIC_URL ??
  process.env.MINIO_PUBLIC_URL ??
  'http://127.0.0.1:9000'
).replace(/\/$/, '');
const PREVIEW_BASE = `${PUBLIC_BASE}/seed-preset-previews`;

interface PackDef {
  slug: string;
  sortOrder: number;
  modelId: string;
  /** Intrinsic dimensions of the preview poster, when the asset is measured. */
  previewWidth?: number;
  previewHeight?: number;
  /** Catalog facet: scene (editorial image packs) | camera | effect | style. */
  category?: 'scene' | 'camera' | 'effect' | 'style';
  /** 'image' → the preset wants a user photo and runs image-to-video. */
  inputKind?: 'none' | 'image';
  /** Generation params applied on top of the prompt (duration, ratio…). */
  params?: Record<string, unknown>;
  // --- Recipe fields (migration 0018). Omit → derived from category/inputKind. ---
  /** How promptTemplate merges with user text. Default: motion→suffix, scene→replace. */
  mergeMode?: 'replace' | 'prefix' | 'suffix' | 'slots';
  /** {key} slots for slots-mode templates. */
  slots?: PresetPackSlot[];
  negativePrompt?: string;
  /** Facet tags for search/filter shelves. */
  tags?: string[];
  /** '' | trending | new | pro. */
  badge?: string;
  /** Degrade chain of catalog ids tried after modelId when it's gated off. */
  fallbackModelIds?: string[];
  /** Explicit override for the derived image/video modality (e.g. a text-to-video
   *  demo pack has no user photo, so isMotion is false — without this it would be
   *  misclassified as an image preset). Omit to keep the isMotion-derived default. */
  modality?: 'image' | 'video';
  /** Default true. false → row seeds but stays off the public catalog/Vitrina
   *  (e.g. superseded by a higher-res rerun, or blocked on a provider cap). */
  isActive?: boolean;
  ru: { title: string; description: string; promptTemplate: string };
  en: { title: string; description: string; promptTemplate: string };
}

/** Shared params for Seedance motion presets: short clip, adaptive ratio so
 * the user's photo keeps its framing. */
const MOTION_PARAMS: Record<string, unknown> = {
  duration_seconds: 5,
  resolution: '720p',
  aspect_ratio: 'adaptive',
};

/** Single {subject} slot shared by the «Кино» presets: the user's own prompt
 * drops into it (mergePresetPrompt single-slot convenience — no apply sheet). */
const CINEMA_SUBJECT_SLOT: PresetPackSlot[] = [
  {
    key: 'subject',
    label: 'Что снимаем',
    required: true,
    placeholder: 'Например: девушка в красном платье на пустой улице',
  },
];

const PACK_DEFS: PackDef[] = [
  {
    slug: 'vk-avatar',
    sortOrder: 10,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'ВК-аватарка',
      description: 'Яркий портрет для профиля ВКонтакте',
      promptTemplate:
        'Портрет молодого человека, яркий фон, квадратный кадр, стиль для аватарки социальной сети, высокое качество',
    },
    en: {
      title: 'VK Avatar',
      description: 'Bright portrait for VKontakte profile',
      promptTemplate:
        'Portrait of a young person, vivid background, square frame, social network avatar style, high quality',
    },
  },
  {
    slug: 'piter-roof-sunset',
    previewWidth: 1400,
    previewHeight: 1400,
    sortOrder: 20,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Питерская крыша на закате',
      description: 'Романтичный вид с крыши Санкт-Петербурга',
      promptTemplate:
        'Вид с крыши петербургского дома на закате, исторические здания, золотой час, кинематографичное освещение',
    },
    en: {
      title: 'St. Petersburg Rooftop at Sunset',
      description: 'Romantic rooftop view of Saint Petersburg',
      promptTemplate:
        'View from a Saint Petersburg rooftop at sunset, historic buildings, golden hour, cinematic lighting',
    },
  },
  {
    slug: 'dacha-2007-polaroid',
    sortOrder: 30,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Дача 2007 (Polaroid)',
      description: 'Ностальгический снимок в стиле Polaroid',
      promptTemplate:
        'Летняя дача, 2007 год, фотография в стиле Polaroid с эффектом старения, ностальгическая атмосфера, лето',
    },
    en: {
      title: 'Dacha 2007 (Polaroid)',
      description: 'Nostalgic Polaroid-style shot',
      promptTemplate:
        'Summer dacha, year 2007, Polaroid-style photo with aging effect, nostalgic atmosphere, summer',
    },
  },
  {
    slug: 'anime-portrait',
    previewWidth: 1400,
    previewHeight: 1400,
    sortOrder: 40,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Аниме-портрет',
      description: 'Портрет в японском аниме-стиле',
      promptTemplate:
        'Аниме-портрет, японский стиль, детальная прорисовка глаз, яркие цвета, студийный рисунок',
    },
    en: {
      title: 'Anime Portrait',
      description: 'Portrait in Japanese anime style',
      promptTemplate:
        'Anime portrait, Japanese style, detailed eye drawing, vivid colors, studio illustration',
    },
  },
  {
    slug: 'business-avatar-white',
    sortOrder: 50,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Бизнес-аватар на белом фоне',
      description: 'Профессиональный портрет для LinkedIn',
      promptTemplate:
        'Профессиональный деловой портрет на белом фоне, деловой костюм, уверенная улыбка, студийное освещение',
    },
    en: {
      title: 'Business Avatar on White',
      description: 'Professional portrait for LinkedIn',
      promptTemplate:
        'Professional business portrait on white background, business suit, confident smile, studio lighting',
    },
  },
  {
    slug: 'cat-winter-hat',
    sortOrder: 60,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Котик в зимней шапке',
      description: 'Милый кот в зимнем уборе',
      promptTemplate:
        'Милый рыжий кот в пушистой зимней шапке, крупный план, размытый фон, тёплые тона',
    },
    en: {
      title: 'Cat in Winter Hat',
      description: 'Cute cat in winter headwear',
      promptTemplate:
        'Cute ginger cat wearing a fluffy winter hat, close-up, blurred background, warm tones',
    },
  },
  {
    slug: 'logo-emblem',
    sortOrder: 70,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Логотип-эмблема',
      description: 'Векторная эмблема для бренда',
      promptTemplate:
        'Минималистичная эмблема-логотип, векторный стиль, чистые линии, профессиональный дизайн, белый фон',
    },
    en: {
      title: 'Logo Emblem',
      description: 'Vector emblem for a brand',
      promptTemplate:
        'Minimalist logo emblem, vector style, clean lines, professional design, white background',
    },
  },
  {
    slug: 'drink-ad',
    sortOrder: 80,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Реклама напитка',
      description: 'Рекламный постер напитка',
      promptTemplate:
        'Рекламный постер освежающего напитка, яркие брызги, профессиональная фотосъёмка продукта, студийный свет',
    },
    en: {
      title: 'Drink Advertisement',
      description: 'Advertising poster for a beverage',
      promptTemplate:
        'Advertising poster of a refreshing drink, vivid splashes, professional product photography, studio light',
    },
  },
  {
    slug: 'ps1-game-screenshot',
    previewWidth: 1400,
    previewHeight: 1400,
    sortOrder: 90,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Скриншот игры в стиле PS1',
      description: 'Игровая сцена в эстетике PlayStation 1',
      promptTemplate:
        'Скриншот видеоигры в стиле PlayStation 1, низкополигональная 3D графика, пиксельные текстуры, ретро UI',
    },
    en: {
      title: 'PS1 Game Screenshot',
      description: 'Game scene in PlayStation 1 aesthetics',
      promptTemplate:
        'Video game screenshot in PlayStation 1 style, low-poly 3D graphics, pixelated textures, retro UI',
    },
  },
  {
    slug: 'samovar-still-life',
    previewWidth: 1400,
    previewHeight: 1400,
    sortOrder: 100,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Натюрморт с самоваром',
      description: 'Классический русский натюрморт',
      promptTemplate:
        'Классический русский натюрморт с самоваром, блюдечки с чаем, баранки, деревянный стол, масляная живопись',
    },
    en: {
      title: 'Samovar Still Life',
      description: 'Classic Russian still life',
      promptTemplate:
        'Classic Russian still life with samovar, tea saucers, bagels, wooden table, oil painting style',
    },
  },
  {
    slug: 'horror-poster-90s',
    previewWidth: 1400,
    previewHeight: 1400,
    sortOrder: 110,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Постер фильма ужасов 90-х',
      description: 'Жуткий постер в стиле VHS-эпохи',
      promptTemplate:
        'Постер фильма ужасов в стиле 90-х годов, VHS зернистость, мрачная атмосфера, пугающий силуэт, ночной лес',
    },
    en: {
      title: '90s Horror Movie Poster',
      description: 'Creepy poster in VHS-era style',
      promptTemplate:
        'Horror movie poster in 90s style, VHS grain, dark atmosphere, frightening silhouette, night forest',
    },
  },
  {
    slug: 'birthday-card',
    sortOrder: 120,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedream-5-0-pro',
    ru: {
      title: 'Поздравительная открытка с днём рождения',
      description: 'Яркая открытка для поздравления',
      promptTemplate:
        'Праздничная поздравительная открытка с днём рождения, воздушные шарики, конфетти, яркие цвета, текст "С днём рождения!"',
    },
    en: {
      title: 'Birthday Greeting Card',
      description: 'Bright card for congratulations',
      promptTemplate:
        'Festive birthday greeting card, balloons, confetti, vivid colors, "Happy Birthday!" text',
    },
  },

  /* ---- Phase 3: Seedance motion presets (Higgsfield-style catalog). ----
     All take a user photo (inputKind: image → i2v) and animate it with a
     specific camera move or effect. Prompt describes ONLY the motion/effect —
     the subject comes from the photo. */

  // Камера
  {
    slug: 'crash-zoom',
    sortOrder: 200,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'camera',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Crash Zoom',
      description: 'Резкий стремительный наезд камеры на героя',
      promptTemplate:
        'Резкий стремительный наезд камеры на объект (crash zoom), драматичное ускорение, лёгкое размытие движения, кинематографичный энергичный кадр',
    },
    en: {
      title: 'Crash Zoom',
      description: 'Rapid dramatic push-in on the subject',
      promptTemplate:
        'Rapid crash zoom toward the subject, dramatic acceleration, slight motion blur, cinematic high-energy shot',
    },
  },
  {
    slug: 'dolly-in',
    sortOrder: 210,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'camera',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Долли-наезд',
      description: 'Медленный плавный наезд, малая глубина резкости',
      promptTemplate:
        'Медленный плавный наезд камеры (dolly in), малая глубина резкости, мягкий боке-фон, спокойное кинематографичное движение',
    },
    en: {
      title: 'Dolly In',
      description: 'Slow smooth push-in with shallow depth of field',
      promptTemplate:
        'Slow smooth dolly-in, shallow depth of field, soft bokeh background, calm cinematic camera movement',
    },
  },
  {
    slug: 'orbit-360',
    sortOrder: 220,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'camera',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Орбита 360°',
      description: 'Камера облетает героя по кругу',
      promptTemplate:
        'Камера плавно облетает объект по кругу на 360 градусов, объект в центре кадра, равномерное орбитальное движение, кинематографично',
    },
    en: {
      title: '360° Orbit',
      description: 'Camera circles around the subject',
      promptTemplate:
        'Camera smoothly orbits 360 degrees around the subject, subject centered, steady orbital motion, cinematic',
    },
  },
  {
    slug: 'fpv-drone',
    sortOrder: 230,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'camera',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'FPV-дрон',
      description: 'Стремительный пролёт как на гоночном дроне',
      promptTemplate:
        'Стремительный пролёт FPV-дрона мимо объекта, резкие виражи и наклоны камеры, динамичный гоночный полёт, эффект присутствия',
    },
    en: {
      title: 'FPV Drone',
      description: 'Fast racing-drone flythrough',
      promptTemplate:
        'Fast FPV drone flythrough past the subject, sharp banking turns and camera tilts, dynamic racing flight, immersive feel',
    },
  },
  {
    slug: 'bullet-time',
    sortOrder: 240,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'camera',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Bullet Time',
      description: 'Время замирает, камера скользит вокруг',
      promptTemplate:
        'Эффект bullet time: время почти останавливается, камера плавно скользит вокруг застывшего объекта, частицы зависают в воздухе, стиль «Матрицы»',
    },
    en: {
      title: 'Bullet Time',
      description: 'Time freezes while the camera sweeps around',
      promptTemplate:
        'Bullet time effect: time nearly stops, camera glides around the frozen subject, particles suspended mid-air, Matrix style',
    },
  },
  {
    slug: 'handheld-doc',
    sortOrder: 250,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'camera',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Репортажная камера',
      description: 'Живое «ручное» документальное движение',
      promptTemplate:
        'Ручная репортажная камера, лёгкое естественное покачивание, документальная подача, живой реалистичный кадр',
    },
    en: {
      title: 'Handheld Documentary',
      description: 'Natural handheld documentary motion',
      promptTemplate:
        'Handheld documentary camera, subtle natural shake, vérité feel, lively realistic shot',
    },
  },

  // Эффекты
  {
    slug: 'levitate',
    sortOrder: 300,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'effect',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Левитация',
      description: 'Герой медленно отрывается от земли',
      promptTemplate:
        'Объект медленно и плавно поднимается в воздух, левитация, волосы и одежда слегка развеваются, лёгкое свечение, магическая атмосфера',
    },
    en: {
      title: 'Levitation',
      description: 'The subject slowly lifts off the ground',
      promptTemplate:
        'Subject slowly and smoothly rises into the air, levitation, hair and clothes gently flowing, soft glow, magical atmosphere',
    },
  },
  {
    slug: 'explosion-behind',
    previewWidth: 960,
    previewHeight: 960,
    sortOrder: 310,
    modelId: 'seedance-2-0-fast',
    category: 'effect',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Взрыв за спиной',
      description: 'Кинематографичный взрыв в слоумо позади героя',
      promptTemplate:
        'Кинематографичный взрыв на заднем плане позади объекта, замедленная съёмка, разлетающиеся искры и обломки, герой невозмутимо идёт вперёд, стиль боевика',
    },
    en: {
      title: 'Explosion Behind',
      description: 'Cinematic slow-mo explosion behind the hero',
      promptTemplate:
        'Cinematic explosion in the background behind the subject, slow motion, flying sparks and debris, hero walks forward unfazed, action movie style',
    },
  },
  {
    slug: 'neon-rain',
    previewWidth: 960,
    previewHeight: 960,
    sortOrder: 320,
    modelId: 'seedance-2-0-fast',
    category: 'effect',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Неоновый дождь',
      description: 'Начинается дождь в неоновом свете',
      promptTemplate:
        'Начинается дождь, капли блестят в неоновом свете, отражения на мокрых поверхностях, киберпанк-атмосфера, кинематографичное освещение',
    },
    en: {
      title: 'Neon Rain',
      description: 'Rain starts falling in neon light',
      promptTemplate:
        'Rain starts falling, drops glistening in neon light, reflections on wet surfaces, cyberpunk atmosphere, cinematic lighting',
    },
  },
  {
    slug: 'time-freeze',
    sortOrder: 330,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'effect',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Стоп-время',
      description: 'Всё замирает — двигается только герой',
      promptTemplate:
        'Всё вокруг застывает на месте, двигается только главный объект, застывшие в воздухе частицы и люди вокруг, сюрреалистичный эффект остановленного времени',
    },
    en: {
      title: 'Time Freeze',
      description: 'Everything freezes — only the hero moves',
      promptTemplate:
        'Everything around freezes in place, only the main subject keeps moving, particles and people frozen mid-motion, surreal stopped-time effect',
    },
  },
  {
    slug: 'ice-frost',
    sortOrder: 340,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'effect',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Заморозка',
      description: 'Кадр покрывается инеем и льдом',
      promptTemplate:
        'Кадр постепенно покрывается инеем и кристаллами льда, морозное дыхание, холодный голубой свет, зимняя магия',
    },
    en: {
      title: 'Frost Over',
      description: 'The frame ices over with frost crystals',
      promptTemplate:
        'The frame gradually covers with frost and ice crystals, freezing breath, cold blue light, winter magic',
    },
  },
  {
    slug: 'zoom-out-reveal',
    sortOrder: 350,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'effect',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Отъезд-раскрытие',
      description: 'Камера отъезжает и раскрывает масштаб сцены',
      promptTemplate:
        'Камера плавно и быстро отъезжает от объекта, раскрывая огромный масштаб окружающей сцены, эпичное раскрытие пространства, кинематографично',
    },
    en: {
      title: 'Zoom-Out Reveal',
      description: 'Camera pulls back to reveal the scene scale',
      promptTemplate:
        'Camera smoothly pulls far back from the subject, revealing the vast scale of the surrounding scene, epic reveal, cinematic',
    },
  },

  // Стили
  {
    slug: 'anime-motion',
    sortOrder: 400,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'style',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'Аниме-оживление',
      description: 'Фото оживает в аниме-стилистике',
      promptTemplate:
        'Кадр оживает в стилистике японского аниме: мягкая рисованная анимация, развевающиеся волосы, блики в глазах, плавное движение',
    },
    en: {
      title: 'Anime Motion',
      description: 'The photo comes alive in anime style',
      promptTemplate:
        'The frame comes alive in Japanese anime style: soft hand-drawn animation, flowing hair, sparkling eyes, smooth motion',
    },
  },
  {
    slug: 'vhs-90s',
    sortOrder: 410,
    previewWidth: 2048,
    previewHeight: 2048,
    modelId: 'seedance-2-0-fast',
    category: 'style',
    inputKind: 'image',
    params: MOTION_PARAMS,
    ru: {
      title: 'VHS 90-х',
      description: 'Живое видео с камкордера из 90-х',
      promptTemplate:
        'Кадр оживает как запись с VHS-камкордера 90-х: лёгкий шум плёнки, смазанные цвета, дрожание ручной камеры, ностальгия',
    },
    en: {
      title: '90s VHS',
      description: 'Living footage from a 90s camcorder',
      promptTemplate:
        'The frame comes alive as 90s VHS camcorder footage: slight tape noise, washed colors, handheld jitter, nostalgia',
    },
  },

  // «Кино» — A1 curated cinema presets (Open-Generative-AI §A). Each is an IMAGE
  // preset (Seedream) with a single {subject} slot: the user's own prompt drops
  // into the slot and the fixed cinematography scaffold composites around it via
  // mergePresetPrompt (slots mode). Templates are built from cinema-vocabulary.ts.
  {
    slug: 'cinema-70mm-epic',
    sortOrder: 500,
    modelId: 'seedream-5-0-pro',
    category: 'camera',
    mergeMode: 'slots',
    slots: CINEMA_SUBJECT_SLOT,
    negativePrompt: CINEMA_NEGATIVE,
    tags: ['cinema', 'epic', '70mm', 'anamorphic'],
    ru: {
      title: '70мм Эпик',
      description: 'Грандиозный кинокадр как в большом кино на 70-мм плёнку',
      promptTemplate: composeCinemaTemplate({
        camera: '70mm',
        lens: 'anamorphic',
        focal: '35mm',
        aperture: 'f4',
      }),
    },
    en: {
      title: '70mm Epic',
      description: 'Grand cinematic frame, shot on 70mm film',
      promptTemplate: composeCinemaTemplate({
        camera: '70mm',
        lens: 'anamorphic',
        focal: '35mm',
        aperture: 'f4',
      }),
    },
  },
  {
    slug: 'cinema-16mm-vintage',
    sortOrder: 510,
    modelId: 'seedream-5-0-pro',
    category: 'camera',
    mergeMode: 'slots',
    slots: CINEMA_SUBJECT_SLOT,
    negativePrompt: CINEMA_NEGATIVE,
    tags: ['cinema', 'vintage', '16mm', 'grain'],
    ru: {
      title: '16мм Винтаж',
      description: 'Тёплое зерно и ретро-фактура 16-мм плёнки',
      promptTemplate: composeCinemaTemplate({
        camera: '16mm',
        lens: 'spherical',
        focal: '35mm',
        aperture: 'f2.8',
      }),
    },
    en: {
      title: '16mm Vintage',
      description: 'Warm grain and retro texture of 16mm film',
      promptTemplate: composeCinemaTemplate({
        camera: '16mm',
        lens: 'spherical',
        focal: '35mm',
        aperture: 'f2.8',
      }),
    },
  },
  {
    slug: 'cinema-anamorphic-portrait',
    sortOrder: 520,
    modelId: 'seedream-5-0-pro',
    category: 'camera',
    mergeMode: 'slots',
    slots: CINEMA_SUBJECT_SLOT,
    negativePrompt: CINEMA_NEGATIVE,
    tags: ['cinema', 'portrait', 'anamorphic', 'bokeh'],
    ru: {
      title: 'Анаморф-портрет',
      description: 'Портрет с овальным боке и мягким разделением планов',
      promptTemplate: composeCinemaTemplate({
        camera: '35mm',
        lens: 'anamorphic',
        focal: '85mm',
        aperture: 'f1.4',
      }),
    },
    en: {
      title: 'Anamorphic Portrait',
      description: 'Portrait with oval bokeh and soft subject separation',
      promptTemplate: composeCinemaTemplate({
        camera: '35mm',
        lens: 'anamorphic',
        focal: '85mm',
        aperture: 'f1.4',
      }),
    },
  },
  {
    slug: 'cinema-macro-detail',
    sortOrder: 530,
    modelId: 'seedream-5-0-pro',
    category: 'camera',
    mergeMode: 'slots',
    slots: CINEMA_SUBJECT_SLOT,
    negativePrompt: CINEMA_NEGATIVE,
    tags: ['cinema', 'macro', 'detail', 'closeup'],
    ru: {
      title: 'Макро-деталь',
      description: 'Сверхкрупный план с тонкой детализацией фактуры',
      promptTemplate: composeCinemaTemplate({
        camera: 'digital',
        lens: 'macro',
        focal: '50mm',
        aperture: 'f2.8',
      }),
    },
    en: {
      title: 'Macro Detail',
      description: 'Extreme close-up with fine textural detail',
      promptTemplate: composeCinemaTemplate({
        camera: 'digital',
        lens: 'macro',
        focal: '50mm',
        aperture: 'f2.8',
      }),
    },
  },
  {
    slug: 'cinema-tilt-shift',
    sortOrder: 540,
    modelId: 'seedream-5-0-pro',
    category: 'camera',
    mergeMode: 'slots',
    slots: CINEMA_SUBJECT_SLOT,
    negativePrompt: CINEMA_NEGATIVE,
    tags: ['cinema', 'tilt-shift', 'miniature', 'selective-focus'],
    ru: {
      title: 'Тилт-шифт',
      description: 'Игрушечный «миниатюрный» эффект с узкой зоной резкости',
      promptTemplate: composeCinemaTemplate({
        camera: 'digital',
        lens: 'tiltShift',
        focal: '50mm',
        aperture: 'f2.8',
      }),
    },
    en: {
      title: 'Tilt-Shift',
      description: 'Toy-like miniature effect with a thin focus band',
      promptTemplate: composeCinemaTemplate({
        camera: 'digital',
        lens: 'tiltShift',
        focal: '50mm',
        aperture: 'f2.8',
      }),
    },
  },

  // Model demos — 13 real render captures from the live-route-test batch
  // (2026-07-16), one per viral format × model/vendor combination. Fixed
  // canned prompt (mergeMode 'replace'); modality forced to 'video' since
  // these are text-to-video demo clips with no user photo (isMotion would
  // otherwise misclassify them as image presets). Format names per
  // docs/strategy/vitrina-prompt-research/02-claude-round2-viral-formats-VERIFIED.md.
  // Owner ruling (2026-07-16 rework): the public wall is 1080p-only — only
  // the 5 defs with a genuine 1920x1080 rerun stay isActive:true; the rest
  // (sub-1080p originals, AtlasCloud dupes, grok's 720p model cap, both
  // seedance defs pending a kie top-up) are seeded but isActive:false.
  {
    slug: 'demo-veo-3-1-lite-jumbotron',
    previewWidth: 1400,
    previewHeight: 788,
    sortOrder: 600,
    modelId: 'veo-3-1-lite',
    category: 'camera',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 4, resolution: '1080p' },
    ru: {
      title: 'Джамботрон',
      description: 'Стадионная трансляция крупным планом',
      promptTemplate:
        'Ultra-realistic single continuous 4-second live TV broadcast clip of a young man seated in a packed baseball stadium crowd. He notices the camera, breaks into a wide happy smile, makes eye contact and waves enthusiastically. Background crowd cheers and waves thundersticks. Telephoto broadcast zoom, subtle handheld shake, shallow depth of field, realistic stadium lighting. Pure live TV capture energy.',
    },
    en: {
      title: 'Jumbotron',
      description: 'Stadium broadcast close-up',
      promptTemplate:
        'Ultra-realistic single continuous 4-second live TV broadcast clip of a young man seated in a packed baseball stadium crowd. He notices the camera, breaks into a wide happy smile, makes eye contact and waves enthusiastically. Background crowd cheers and waves thundersticks. Telephoto broadcast zoom, subtle handheld shake, shallow depth of field, realistic stadium lighting. Pure live TV capture energy.',
    },
  },
  {
    slug: 'demo-veo-3-1-fast-dolly-zoom',
    sortOrder: 610,
    modelId: 'veo-3-1-fast',
    category: 'camera',
    mergeMode: 'replace',
    modality: 'video',
    // Sub-1080p original — superseded by demo-veo-3-1-fast-dolly-zoom-1080p on
    // the 1080p-only wall (owner, 2026-07-16).
    isActive: false,
    params: { duration_seconds: 4, resolution: '720p' },
    ru: {
      title: 'Долли-зум',
      description: 'Классический вертиго-эффект (Zolly)',
      promptTemplate:
        'One continuous 4-second vertigo dolly-zoom shot. A young woman stands centered in a narrow city corridor, staying the same size while the camera dollies backward and the lens zooms in, compressing the background behind her. She realizes and inhales once, body still. Strong accurate parallax, smooth stabilized motion, cinematic realistic lighting. No cut, no orbit, no ordinary zoom, no wobble.',
    },
    en: {
      title: 'Dolly Zoom',
      description: 'Classic Hitchcock vertigo effect (Zolly)',
      promptTemplate:
        'One continuous 4-second vertigo dolly-zoom shot. A young woman stands centered in a narrow city corridor, staying the same size while the camera dollies backward and the lens zooms in, compressing the background behind her. She realizes and inhales once, body still. Strong accurate parallax, smooth stabilized motion, cinematic realistic lighting. No cut, no orbit, no ordinary zoom, no wobble.',
    },
  },
  {
    slug: 'demo-veo-3-1-fast-dolly-zoom-1080p',
    previewWidth: 1400,
    previewHeight: 788,
    sortOrder: 620,
    modelId: 'veo-3-1-fast',
    category: 'camera',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 4, resolution: '1080p' },
    ru: {
      title: 'Долли-зум (1080p)',
      description: 'Тот же кадр в повышенном разрешении',
      promptTemplate:
        'One continuous 4-second vertigo dolly-zoom shot. A young woman stands centered in a narrow city corridor, staying the same size while the camera dollies backward and the lens zooms in, compressing the background behind her. She realizes and inhales once, body still. Strong accurate parallax, smooth stabilized motion, cinematic realistic lighting. No cut, no orbit, no ordinary zoom, no wobble.',
    },
    en: {
      title: 'Dolly Zoom (1080p)',
      description: 'Same shot upscaled to 1080p',
      promptTemplate:
        'One continuous 4-second vertigo dolly-zoom shot. A young woman stands centered in a narrow city corridor, staying the same size while the camera dollies backward and the lens zooms in, compressing the background behind her. She realizes and inhales once, body still. Strong accurate parallax, smooth stabilized motion, cinematic realistic lighting. No cut, no orbit, no ordinary zoom, no wobble.',
    },
  },
  {
    slug: 'demo-seedance-2-0-fast-food-jutsu',
    sortOrder: 630,
    modelId: 'seedance-2-0-fast',
    category: 'effect',
    mergeMode: 'replace',
    modality: 'video',
    // 1080p rerun blocked on a kie balance top-up — off the 1080p-only wall
    // until that lands (owner, 2026-07-16).
    isActive: false,
    params: { duration_seconds: 4, resolution: '480p' },
    ru: {
      title: 'Джутсу еды',
      description: 'Продукт материализуется из частиц',
      promptTemplate:
        'Presenter behind an empty counter performs one fast three-gesture sequence without touching anything; a tight spiral of glowing particles resolves into a bottle of orange soda, landing upright with a contact shadow. Subtle dolly in, light trails fade after the reveal. No cut, no extra hands, no fire.',
    },
    en: {
      title: 'Food Jutsu',
      description: 'Product materializes out of glowing particles',
      promptTemplate:
        'Presenter behind an empty counter performs one fast three-gesture sequence without touching anything; a tight spiral of glowing particles resolves into a bottle of orange soda, landing upright with a contact shadow. Subtle dolly in, light trails fade after the reveal. No cut, no extra hands, no fire.',
    },
  },
  {
    slug: 'demo-seedance-2-0-reference-to-video-portrait',
    sortOrder: 640,
    modelId: 'seedance-2-0-reference-to-video',
    category: 'effect',
    inputKind: 'image',
    mergeMode: 'replace',
    modality: 'video',
    // 1080p rerun blocked on a kie balance top-up — off the 1080p-only wall
    // until that lands (owner, 2026-07-16).
    isActive: false,
    params: { duration_seconds: 4, resolution: '480p' },
    ru: {
      title: 'Оживление референса',
      description: 'Фото оживает с сохранением внешности',
      promptTemplate:
        'Animate the reference subject naturally: it turns its head slowly toward the camera as the camera gently pushes in. Preserve the exact subject appearance. Cinematic realistic lighting, shallow depth of field. No cut, no morph.',
    },
    en: {
      title: 'Reference to Video',
      description: 'A reference photo comes alive, appearance preserved',
      promptTemplate:
        'Animate the reference subject naturally: it turns its head slowly toward the camera as the camera gently pushes in. Preserve the exact subject appearance. Cinematic realistic lighting, shallow depth of field. No cut, no morph.',
    },
  },
  {
    slug: 'demo-grok-imagine-video-freeze-kie',
    sortOrder: 650,
    modelId: 'grok-imagine-video',
    category: 'effect',
    mergeMode: 'replace',
    modality: 'video',
    // grok-imagine caps at 720p (1080p request rejected) — off the
    // 1080p-only wall; owner call pending on whether to keep it in the
    // catalog at 720p once it's clear it can't be promoted (2026-07-16).
    isActive: false,
    params: { duration_seconds: 6, resolution: '720p' },
    ru: {
      title: 'Заморозка',
      description: 'Стакан воды превращается в лёд',
      promptTemplate:
        'A single glass of water on a wooden table suddenly freezes into ice from the center outward in a spreading crystal pattern. Locked camera, fixed background and shadow, one clean physics transform that settles. No cut, no duplicate, no camera move.',
    },
    en: {
      title: 'Freeze',
      description: 'A glass of water turns to ice',
      promptTemplate:
        'A single glass of water on a wooden table suddenly freezes into ice from the center outward in a spreading crystal pattern. Locked camera, fixed background and shadow, one clean physics transform that settles. No cut, no duplicate, no camera move.',
    },
  },
  {
    slug: 'demo-happyhorse-1-0-inflate-kie',
    sortOrder: 660,
    modelId: 'happyhorse-1-1',
    category: 'effect',
    mergeMode: 'replace',
    modality: 'video',
    // Legacy slug; model pointed to happyhorse-1-1 after 1.0 was delisted
    // (workbook v14 03_08, migration 0094).
    isActive: false,
    params: { duration_seconds: 3, resolution: '720p' },
    ru: {
      title: 'Надувание',
      description: 'Воздушный шар растёт и оседает',
      promptTemplate:
        'A red balloon on a table slowly inflates larger and larger, then gently rebounds and settles. Locked camera, fixed background and shadow, one clean physics transform. No cut, no duplicate, no camera move, no fire.',
    },
    en: {
      title: 'Inflate',
      description: 'A balloon inflates and settles',
      promptTemplate:
        'A red balloon on a table slowly inflates larger and larger, then gently rebounds and settles. Locked camera, fixed background and shadow, one clean physics transform. No cut, no duplicate, no camera move, no fire.',
    },
  },
  {
    slug: 'demo-happyhorse-1-1-inflate',
    previewWidth: 1400,
    previewHeight: 788,
    sortOrder: 670,
    modelId: 'happyhorse-1-1',
    category: 'effect',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 3, resolution: '1080p' },
    ru: {
      title: 'Надувание (HappyHorse 1.1)',
      description: 'Тот же трюк на новой версии модели',
      promptTemplate:
        'A red balloon on a table slowly inflates larger and larger, then gently rebounds and settles. Locked camera, fixed background and shadow, one clean physics transform. No cut, no duplicate, no camera move, no fire.',
    },
    en: {
      title: 'Inflate (HappyHorse 1.1)',
      description: 'Same trick on the newer model version',
      promptTemplate:
        'A red balloon on a table slowly inflates larger and larger, then gently rebounds and settles. Locked camera, fixed background and shadow, one clean physics transform. No cut, no duplicate, no camera move, no fire.',
    },
  },
  {
    slug: 'demo-wan-2-7-drone-pullback-kie',
    previewWidth: 1400,
    previewHeight: 788,
    sortOrder: 680,
    modelId: 'wan-2-7',
    category: 'camera',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 3, resolution: '1080p' },
    ru: {
      title: 'Дрон над крышей',
      description: 'Дрон отъезжает и раскрывает город',
      promptTemplate:
        'A slow cinematic drone pullback revealing a couple standing on a city rooftop at golden hour, the skyline opening up behind them. Smooth stabilized aerial motion, warm realistic light. No cut.',
    },
    en: {
      title: 'Rooftop Drone Pullback',
      description: 'Aerial pullback reveals the skyline',
      promptTemplate:
        'A slow cinematic drone pullback revealing a couple standing on a city rooftop at golden hour, the skyline opening up behind them. Smooth stabilized aerial motion, warm realistic light. No cut.',
    },
  },
  {
    slug: 'demo-gemini-omni-flash-jumbotron',
    previewWidth: 1400,
    previewHeight: 788,
    sortOrder: 690,
    modelId: 'gemini-omni-flash',
    category: 'camera',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 4, resolution: '1080p' },
    ru: {
      title: 'Джамботрон (Gemini Omni)',
      description: 'Та же стадионная сцена на другой модели',
      promptTemplate:
        'Ultra-realistic single continuous 4-second live TV broadcast clip of a young man seated in a packed baseball stadium crowd. He notices the camera, breaks into a wide happy smile, makes eye contact and waves enthusiastically. Background crowd cheers and waves. Telephoto broadcast zoom, subtle handheld shake, shallow depth of field, realistic stadium lighting. Pure live TV capture energy.',
    },
    en: {
      title: 'Jumbotron (Gemini Omni)',
      description: 'Same stadium scene on a different model',
      promptTemplate:
        'Ultra-realistic single continuous 4-second live TV broadcast clip of a young man seated in a packed baseball stadium crowd. He notices the camera, breaks into a wide happy smile, makes eye contact and waves enthusiastically. Background crowd cheers and waves. Telephoto broadcast zoom, subtle handheld shake, shallow depth of field, realistic stadium lighting. Pure live TV capture energy.',
    },
  },
  {
    slug: 'demo-wan-2-7-drone-pullback-atlas',
    previewWidth: 1280,
    previewHeight: 720,
    sortOrder: 700,
    modelId: 'wan-2-7',
    category: 'camera',
    mergeMode: 'replace',
    modality: 'video',
    // AtlasCloud dupe of the kie route — off the 10-tile 1080p-only wall
    // (owner, 2026-07-16).
    isActive: false,
    params: { duration_seconds: 2, resolution: '720p' },
    ru: {
      title: 'Дрон над крышей (AtlasCloud)',
      description: 'Тот же кадр через AtlasCloud',
      promptTemplate:
        'A slow cinematic drone pullback revealing a couple standing on a city rooftop at golden hour, the skyline opening up behind them. Smooth stabilized aerial motion, warm realistic light. No cut.',
    },
    en: {
      title: 'Rooftop Drone Pullback (AtlasCloud)',
      description: 'Same shot routed via AtlasCloud',
      promptTemplate:
        'A slow cinematic drone pullback revealing a couple standing on a city rooftop at golden hour, the skyline opening up behind them. Smooth stabilized aerial motion, warm realistic light. No cut.',
    },
  },
  {
    slug: 'demo-grok-imagine-video-freeze-atlas',
    sortOrder: 710,
    modelId: 'grok-imagine-video',
    category: 'effect',
    mergeMode: 'replace',
    modality: 'video',
    // AtlasCloud dupe + grok caps at 720p (owner call pending) — off the
    // 10-tile 1080p-only wall (2026-07-16).
    isActive: false,
    params: { duration_seconds: 5, resolution: '480p' },
    ru: {
      title: 'Заморозка (AtlasCloud)',
      description: 'Тот же трюк через AtlasCloud',
      promptTemplate:
        'A single glass of water on a wooden table suddenly freezes into ice from the center outward in a spreading crystal pattern. Locked camera, fixed background and shadow, one clean physics transform that settles. No cut, no duplicate, no camera move.',
    },
    en: {
      title: 'Freeze (AtlasCloud)',
      description: 'Same trick routed via AtlasCloud',
      promptTemplate:
        'A single glass of water on a wooden table suddenly freezes into ice from the center outward in a spreading crystal pattern. Locked camera, fixed background and shadow, one clean physics transform that settles. No cut, no duplicate, no camera move.',
    },
  },
  {
    slug: 'demo-happyhorse-1-0-inflate-atlas',
    sortOrder: 720,
    modelId: 'happyhorse-1-1',
    category: 'effect',
    mergeMode: 'replace',
    modality: 'video',
    // Legacy slug; model pointed to happyhorse-1-1 after 1.0 was delisted
    // (workbook v14 03_08, migration 0094).
    isActive: false,
    params: { duration_seconds: 3, resolution: '720p' },
    ru: {
      title: 'Надувание (AtlasCloud)',
      description: 'Тот же трюк через AtlasCloud',
      promptTemplate:
        'A red balloon on a table slowly inflates larger and larger, then gently rebounds and settles. Locked camera, fixed background and shadow, one clean physics transform. No cut, no duplicate, no camera move, no fire.',
    },
    en: {
      title: 'Inflate (AtlasCloud)',
      description: 'Same trick routed via AtlasCloud',
      promptTemplate:
        'A red balloon on a table slowly inflates larger and larger, then gently rebounds and settles. Locked camera, fixed background and shadow, one clean physics transform. No cut, no duplicate, no camera move, no fire.',
    },
  },

  // Owner bulk-publish (2026-07-17): «кидай ВСЁ в Витрину» — the remaining
  // live-route-test captures with no pack def yet, published isActive:true
  // for the owner to curate later. r14 completes the 1080p Food Jutsu wall
  // slot deferred above (seedance-2-0, non-fast — the kie top-up landed);
  // the rest are the probe clips from the follow-up routing pass
  // (2026-07-17). demo-*-seedance-mini (r13-seedance-mini.mp4) is EXCLUDED:
  // kie slug bytedance/seedance-2-mini has no catalog model row yet (finance
  // request pending, docs/platform/model-catalog.md)
  // — publishing it would point a pack at a model id apply can't resolve.
  {
    // Витрина showcase rows for the two legacy effect presets. The catalog rows
    // `explosion-behind` / `neon-rain` stay suffix modifiers — a phrase appended
    // to the user's own subject — which is correct for /presets and useless on a
    // wall that promises «снять так же»: landing on /generate with only a
    // modifier leaves an empty prompt box and nothing to run. These rows carry
    // the FULL text-to-video prompt that actually produced the clips on the wall
    // (generated 2026-07-27 on bytedance/seedance-2-fast, no input image), so
    // the CTA reproduces what the visitor just watched.
    slug: 'demo-seedance-2-0-fast-explosion-behind',
    previewWidth: 960,
    previewHeight: 960,
    sortOrder: 860,
    modelId: 'seedance-2-0-fast',
    category: 'effect',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 5, resolution: '720p', aspect_ratio: '1:1' },
    ru: {
      title: 'Взрыв за спиной',
      description: 'Герой идёт на камеру, за спиной разлетается взрыв',
      promptTemplate:
        'A lone operative in a dark jacket walks steadily toward camera down a ruined city street. Cinematic explosion in the background behind the subject, slow motion, flying sparks and debris, hero walks forward unfazed, action movie style',
    },
    en: {
      title: 'Explosion Behind',
      description: 'Hero walks toward camera as a blast tears up the street behind',
      promptTemplate:
        'A lone operative in a dark jacket walks steadily toward camera down a ruined city street. Cinematic explosion in the background behind the subject, slow motion, flying sparks and debris, hero walks forward unfazed, action movie style',
    },
  },
  {
    slug: 'demo-seedance-2-0-fast-neon-rain',
    previewWidth: 960,
    previewHeight: 960,
    sortOrder: 870,
    modelId: 'seedance-2-0-fast',
    category: 'effect',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 5, resolution: '720p', aspect_ratio: '1:1' },
    ru: {
      title: 'Неоновый дождь',
      description: 'Дождь начинается в неоновом переулке, отражения на мокром асфальте',
      promptTemplate:
        'A woman in a red jacket stands still in a narrow city alley at night, looking toward camera. Rain starts falling, drops glistening in neon light, reflections on wet surfaces, cyberpunk atmosphere, cinematic lighting',
    },
    en: {
      title: 'Neon Rain',
      description: 'Rain starts in a neon alley, reflections on the wet asphalt',
      promptTemplate:
        'A woman in a red jacket stands still in a narrow city alley at night, looking toward camera. Rain starts falling, drops glistening in neon light, reflections on wet surfaces, cyberpunk atmosphere, cinematic lighting',
    },
  },
  {
    slug: 'demo-seedance-2-0-food-jutsu-1080p',
    previewWidth: 1400,
    previewHeight: 788,
    sortOrder: 780,
    modelId: 'seedance-2-0',
    category: 'effect',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 4, resolution: '1080p' },
    ru: {
      title: 'Джутсу еды (1080p)',
      description: 'Продукт материализуется из частиц в высоком разрешении',
      promptTemplate:
        'Presenter behind an empty counter performs one fast three-gesture sequence without touching anything; a tight spiral of glowing particles resolves into a bottle of orange soda, landing upright with a contact shadow. Subtle dolly in, light trails fade after the reveal. No cut, no extra hands, no fire.',
    },
    en: {
      title: 'Food Jutsu (1080p)',
      description: 'Product materializes out of glowing particles in full HD',
      promptTemplate:
        'Presenter behind an empty counter performs one fast three-gesture sequence without touching anything; a tight spiral of glowing particles resolves into a bottle of orange soda, landing upright with a contact shadow. Subtle dolly in, light trails fade after the reveal. No cut, no extra hands, no fire.',
    },
  },
  {
    slug: 'demo-wan-2-7-golden-hour-recolor',
    previewWidth: 1400,
    previewHeight: 788,
    sortOrder: 790,
    modelId: 'wan-2-7',
    category: 'effect',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 2, resolution: '1080p' },
    ru: {
      title: 'Золотой час',
      description: 'Перекраска сцены в тёплую палитру заката',
      promptTemplate:
        'Recolor the scene to a warm golden-hour palette, keep motion and composition identical.',
    },
    en: {
      title: 'Golden Hour Recolor',
      description: 'The scene recolored into a warm sunset palette',
      promptTemplate:
        'Recolor the scene to a warm golden-hour palette, keep motion and composition identical.',
    },
  },
  {
    slug: 'demo-wan-2-7-reference-to-video',
    previewWidth: 1280,
    previewHeight: 720,
    sortOrder: 800,
    modelId: 'wan-2-7',
    category: 'effect',
    inputKind: 'image',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 3, resolution: '720p' },
    ru: {
      title: 'Оживление референса (Wan)',
      description: 'Референсное фото оживает с плавным приближением камеры',
      promptTemplate:
        'The reference subject turns slowly toward the camera as it gently pushes in. Cinematic realistic light. No cut.',
    },
    en: {
      title: 'Reference to Video (Wan)',
      description: 'A reference photo comes alive with a slow camera push-in',
      promptTemplate:
        'The reference subject turns slowly toward the camera as it gently pushes in. Cinematic realistic light. No cut.',
    },
  },
  {
    slug: 'demo-grok-imagine-video-paper-boat',
    sortOrder: 810,
    modelId: 'grok-imagine-video',
    category: 'scene',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 6, resolution: '480p' },
    ru: {
      title: 'Бумажный кораблик',
      description: 'Кораблик плывёт по дождевому ручью',
      promptTemplate:
        'A paper boat floats gently down a rain-filled gutter stream, small ripples trailing behind. Locked handheld shot, soft overcast light. No cut.',
    },
    en: {
      title: 'Paper Boat',
      description: 'A paper boat drifts down a rain-filled gutter stream',
      promptTemplate:
        'A paper boat floats gently down a rain-filled gutter stream, small ripples trailing behind. Locked handheld shot, soft overcast light. No cut.',
    },
  },
  {
    slug: 'demo-grok-imagine-video-paper-boat-extend',
    previewWidth: 752,
    previewHeight: 416,
    sortOrder: 820,
    modelId: 'grok-imagine-video',
    category: 'scene',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 8, resolution: '480p' },
    ru: {
      title: 'Бумажный кораблик (продление)',
      description: 'Тот же кадр, продлённый до 8 секунд',
      promptTemplate:
        'A paper boat floats gently down a rain-filled gutter stream, small ripples trailing behind. Locked handheld shot, soft overcast light. Continuous single take extended to 8 seconds. No cut.',
    },
    en: {
      title: 'Paper Boat (Extended)',
      description: 'Same shot, extended to 8 seconds',
      promptTemplate:
        'A paper boat floats gently down a rain-filled gutter stream, small ripples trailing behind. Locked handheld shot, soft overcast light. Continuous single take extended to 8 seconds. No cut.',
    },
  },
  {
    slug: 'demo-wan-2-7-mountain-pullback-atlas',
    previewWidth: 1280,
    previewHeight: 720,
    sortOrder: 830,
    modelId: 'wan-2-7',
    category: 'camera',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 2, resolution: '720p' },
    ru: {
      title: 'Дрон над долиной',
      description: 'Дрон отъезжает и раскрывает горную долину на рассвете',
      promptTemplate:
        'A slow cinematic drone pullback over a misty mountain valley at dawn, revealing a winding river below. Smooth stabilized aerial motion, soft golden light. No cut.',
    },
    en: {
      title: 'Mountain Valley Drone Pullback',
      description: 'Aerial pullback reveals a misty valley at dawn',
      promptTemplate:
        'A slow cinematic drone pullback over a misty mountain valley at dawn, revealing a winding river below. Smooth stabilized aerial motion, soft golden light. No cut.',
    },
  },

  // Model demos (image) — 4 real render captures from the same live-route-test
  // batch (2026-07-16), one per image model. Fixed canned prompt (mergeMode
  // 'replace'); modality explicit for self-documentation (matches the video
  // demos above, though 'image' is already the isMotion-derived default here).
  {
    slug: 'demo-seedream-4-0-figurine',
    previewWidth: 1050,
    previewHeight: 1400,
    sortOrder: 730,
    modelId: 'seedream-5-0-pro',
    category: 'style',
    mergeMode: 'replace',
    modality: 'image',
    // 2K, not the 4K this demo asked for as a Seedream 4.5 preset: 5.0 Pro declares
    // ['1K','2K'] and the price key reads the DECLARED list, so a 4K request has no
    // active row and the charge is refused. 2K is Pro's top rung.
    params: { resolution: '2K', aspect_ratio: '3:4' },
    ru: {
      title: 'Фигурка-коллекция',
      description: 'Коллекционная фигурка 1/7 в масштабе на подставке',
      promptTemplate:
        'A 1/7 scale collectible figurine of a young adventurer in a weatherproof jacket, standing on a round clear acrylic base, displayed on a wooden desk beside its printed toy retail box with cover artwork of the same character. Studio product photography, soft key light, ultra-detailed matte PVC texture, shallow depth of field, realistic.',
    },
    en: {
      title: 'Collectible Figurine',
      description: '1/7 scale collectible figurine on a display base',
      promptTemplate:
        'A 1/7 scale collectible figurine of a young adventurer in a weatherproof jacket, standing on a round clear acrylic base, displayed on a wooden desk beside its printed toy retail box with cover artwork of the same character. Studio product photography, soft key light, ultra-detailed matte PVC texture, shallow depth of field, realistic.',
    },
  },
  {
    slug: 'demo-gemini-3-pro-image-pet-profession',
    previewWidth: 1045,
    previewHeight: 1400,
    sortOrder: 740,
    modelId: 'gemini-3-pro-image',
    category: 'scene',
    mergeMode: 'replace',
    modality: 'image',
    params: { resolution: '2K', aspect_ratio: '3:4' },
    ru: {
      title: 'Питомец-профессионал',
      description: 'Кот-пилот в кабине авиалайнера',
      promptTemplate:
        'A ginger tabby cat as a professional airline captain, wearing a crisp navy pilot uniform with gold epaulettes and a captains hat, seated in an airliner cockpit with hands-on-controls posing, glowing instrument panels behind, warm cinematic light, hyper-realistic detailed portrait.',
    },
    en: {
      title: 'Pet in Profession',
      description: 'A cat as an airline captain in the cockpit',
      promptTemplate:
        'A ginger tabby cat as a professional airline captain, wearing a crisp navy pilot uniform with gold epaulettes and a captains hat, seated in an airliner cockpit with hands-on-controls posing, glowing instrument panels behind, warm cinematic light, hyper-realistic detailed portrait.',
    },
  },
  {
    slug: 'demo-gemini-3-1-flash-image-yearbook-90s',
    previewWidth: 1045,
    previewHeight: 1400,
    sortOrder: 750,
    modelId: 'gemini-3-1-flash-image',
    category: 'style',
    mergeMode: 'replace',
    modality: 'image',
    params: { resolution: '2K', aspect_ratio: '3:4' },
    ru: {
      title: 'Школьный альбом 90-х',
      description: 'Ретро-портрет в стиле американского yearbook',
      promptTemplate:
        'A 1990s high-school yearbook portrait of a young man with feathered hair, wearing a denim jacket over a striped collared shirt, classic mottled blue studio backdrop, soft direct flash lighting, subtle film grain, authentic retro color grade, centered head-and-shoulders.',
    },
    en: {
      title: '90s Yearbook',
      description: 'Retro American high-school yearbook portrait',
      promptTemplate:
        'A 1990s high-school yearbook portrait of a young man with feathered hair, wearing a denim jacket over a striped collared shirt, classic mottled blue studio backdrop, soft direct flash lighting, subtle film grain, authentic retro color grade, centered head-and-shoulders.',
    },
  },
  {
    slug: 'demo-gpt-image-2-film-poster',
    previewWidth: 1400,
    previewHeight: 933,
    sortOrder: 760,
    modelId: 'gpt-image-2',
    category: 'style',
    mergeMode: 'replace',
    modality: 'image',
    // 'high', not the raw pixel size: gpt-image-2 sells vendor quality TIERS
    // (low/medium/high) and the price key reads that declared list, so '1536x1024'
    // matched no active row and this demo was refused. Pre-existing, found while
    // auditing the Seedream retirement.
    params: { resolution: 'high' },
    ru: {
      title: 'Постер ромкома',
      description: 'Драматичный киноплакат с типографикой и титрами',
      promptTemplate:
        'A dramatic rom-com movie poster: two silhouetted figures sharing one umbrella on a rainy neon-lit city street at night, bold title typography reading AFTER THE RAIN across the middle, a small tagline beneath, and a studio credits block along the bottom edge, cinematic teal-and-orange color grade.',
    },
    en: {
      title: 'Rom-Com Poster',
      description: 'Dramatic movie poster with title typography and credits',
      promptTemplate:
        'A dramatic rom-com movie poster: two silhouetted figures sharing one umbrella on a rainy neon-lit city street at night, bold title typography reading AFTER THE RAIN across the middle, a small tagline beneath, and a studio credits block along the bottom edge, cinematic teal-and-orange color grade.',
    },
  },
  {
    slug: 'demo-seedream-5-0-pro-flag-banner',
    previewWidth: 778,
    previewHeight: 1400,
    sortOrder: 770,
    modelId: 'seedream-5-0-pro',
    category: 'scene',
    mergeMode: 'replace',
    modality: 'image',
    params: { resolution: '2K', aspect_ratio: '9:16' },
    ru: {
      title: 'Баннер на небоскрёбе',
      description: 'Предложение руки и сердца на крыше с плакатом «ВЕРТОВ»',
      promptTemplate:
        'A cinematic photoreal scene on a secured rooftop platform high above Manhattan at sunrise. A young couple: one partner kneels holding a ring, the other reacts with joyful surprise. Beside them a taut white banner faces the camera and reads exactly «ВЕРТОВ» in large black uppercase Cyrillic letters, no other text. Extreme aerial scale, believable wind in the clothing and banner, warm rim light, realistic faces and hands, city far below. Documentary photoreal, no CGI look, no extra people. 9:16.',
    },
    en: {
      title: 'Skyscraper Banner',
      description: 'Rooftop proposal scene with a Cyrillic banner',
      promptTemplate:
        'A cinematic photoreal scene on a secured rooftop platform high above Manhattan at sunrise. A young couple: one partner kneels holding a ring, the other reacts with joyful surprise. Beside them a taut white banner faces the camera and reads exactly «ВЕРТОВ» in large black uppercase Cyrillic letters, no other text. Extreme aerial scale, believable wind in the clothing and banner, warm rim light, realistic faces and hands, city far below. Documentary photoreal, no CGI look, no extra people. 9:16.',
    },
  },
  // --- kie smoke-run tiles (2026-07-25): paid 1080p re-renders of the wiring
  // audit's smoke prompts, wall-grade. Media: seed-preset-previews bucket. ---
  {
    slug: 'demo-gemini-omni-golden-hour-car',
    previewWidth: 1400,
    previewHeight: 788,
    sortOrder: 780,
    modelId: 'gemini-omni-flash',
    category: 'camera',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 4, resolution: '1080p', aspect_ratio: '16:9' },
    ru: {
      title: 'Золотой час в машине',
      description: 'Тёплый свет сквозь стёкла, пыль в воздухе, медленный наезд',
      promptTemplate:
        'Ultra-realistic golden hour scene inside a modern car, warm sunlight streaming through the windows, dust particles in the light, slow cinematic camera drift',
    },
    en: {
      title: 'Golden Hour Drive',
      description: 'Warm light through the glass, dust in the air, slow drift',
      promptTemplate:
        'Ultra-realistic golden hour scene inside a modern car, warm sunlight streaming through the windows, dust particles in the light, slow cinematic camera drift',
    },
  },
  {
    slug: 'demo-happyhorse-noir-portrait',
    sortOrder: 790,
    modelId: 'happyhorse-1-1',
    category: 'style',
    mergeMode: 'replace',
    modality: 'video',
    params: { duration_seconds: 4, resolution: '1080p', aspect_ratio: '16:9' },
    ru: {
      title: 'Нуар-портрет',
      description: 'Чёрно-красное кино, контровый свет, зерно 90-х',
      promptTemplate:
        'Cinematic black-and-red film noir portrait of a woman, dramatic rim lighting, subtle head turn toward camera, 90s film grain',
    },
    en: {
      title: 'Noir Portrait',
      description: 'Black-and-red cinema, rim light, 90s grain',
      promptTemplate:
        'Cinematic black-and-red film noir portrait of a woman, dramatic rim lighting, subtle head turn toward camera, 90s film grain',
    },
  },
  {
    slug: 'demo-seedream-5-lite-bubbles-editorial',
    previewWidth: 1050,
    previewHeight: 1400,
    sortOrder: 800,
    modelId: 'seedream-5-0-lite',
    category: 'scene',
    mergeMode: 'replace',
    modality: 'image',
    params: { resolution: '2K', aspect_ratio: '3:4' },
    ru: {
      title: 'Мыльные пузыри',
      description: 'Модная съёмка с сердцами-пузырями в пастельных тонах',
      promptTemplate:
        'Hyper-realistic fashion editorial portrait of a young woman surrounded by floating heart-shaped soap bubbles, glossy studio lighting, dreamy pastel tones, magazine cover quality',
    },
    en: {
      title: 'Bubble Editorial',
      description: 'Fashion shoot with heart-shaped bubbles in pastel tones',
      promptTemplate:
        'Hyper-realistic fashion editorial portrait of a young woman surrounded by floating heart-shaped soap bubbles, glossy studio lighting, dreamy pastel tones, magazine cover quality',
    },
  },

  // Model demos (image) — Y2K paparazzi, gpt-image-2, 2026-08-09. Three real
  // renders from the LaoZhang rate probe's follow-up batch, so the wall gains a
  // trend the radar rated #1 that day (Σ18) and the probe spend earns twice.
  //
  // Two things are deliberate and should survive a later edit. First, the prompts
  // carry «no text, no logos, no brand marks, plain unbranded clothing»: the
  // probe's own frames rendered a real trademark legibly on a garment, which is
  // not publishable on a public marketing wall. Second, none of the three shows a
  // usable face — sunglasses, a hand, a crop. The viral original is a face edit
  // from the user's own selfie; a wall tile is not the place to synthesize a
  // photoreal identity nobody consented to.
  {
    slug: 'demo-gpt-image-2-y2k-paparazzi-dogs',
    previewWidth: 1024,
    previewHeight: 1024,
    sortOrder: 810,
    modelId: 'gpt-image-2',
    category: 'style',
    mergeMode: 'replace',
    modality: 'image',
    params: { resolution: 'high', aspect_ratio: '1:1' },
    ru: {
      title: 'Папарацци 2003',
      description: 'Прямая вспышка, ночь у клуба, плёночное зерно',
      promptTemplate:
        'authentic early-2000s flash photograph, strong direct frontal camera flash, harsh falloff into darkness, visible film grain, slight motion blur, candid off-guard moment, no text, no logos, no brand marks, plain unbranded clothing. A man in a plain leather jacket and wraparound sunglasses walking two whippets at night outside a club, paparazzi flashes behind him, red carpet rope.',
    },
    en: {
      title: 'Paparazzi 2003',
      description: 'Direct flash, club night, film grain',
      promptTemplate:
        'authentic early-2000s flash photograph, strong direct frontal camera flash, harsh falloff into darkness, visible film grain, slight motion blur, candid off-guard moment, no text, no logos, no brand marks, plain unbranded clothing. A man in a plain leather jacket and wraparound sunglasses walking two whippets at night outside a club, paparazzi flashes behind him, red carpet rope.',
    },
  },
  {
    slug: 'demo-gpt-image-2-y2k-flip-phone',
    previewWidth: 1024,
    previewHeight: 1024,
    sortOrder: 820,
    modelId: 'gpt-image-2',
    category: 'scene',
    mergeMode: 'replace',
    modality: 'image',
    params: { resolution: 'high', aspect_ratio: '1:1' },
    ru: {
      title: 'Раскладушка',
      description: 'Макро: стразы, облупленный лак, вспышки за спиной',
      promptTemplate:
        'authentic early-2000s flash photograph, strong direct frontal camera flash, harsh falloff into darkness, visible film grain, slight motion blur, candid off-guard moment, no text, no logos, no brand marks, plain unbranded clothing. Extreme close-up of hands holding a tiny flip phone and a rhinestone-studded handbag strap, chipped frosted nail polish, blurred camera flashes behind.',
    },
    en: {
      title: 'Flip Phone',
      description: 'Macro: rhinestones, chipped polish, flashes behind',
      promptTemplate:
        'authentic early-2000s flash photograph, strong direct frontal camera flash, harsh falloff into darkness, visible film grain, slight motion blur, candid off-guard moment, no text, no logos, no brand marks, plain unbranded clothing. Extreme close-up of hands holding a tiny flip phone and a rhinestone-studded handbag strap, chipped frosted nail polish, blurred camera flashes behind.',
    },
  },
  {
    slug: 'demo-gpt-image-2-y2k-car-exit',
    previewWidth: 1024,
    previewHeight: 1024,
    sortOrder: 830,
    modelId: 'gpt-image-2',
    category: 'scene',
    mergeMode: 'replace',
    modality: 'image',
    params: { resolution: 'high', aspect_ratio: '1:1' },
    ru: {
      title: 'Выход из машины',
      description: 'Стена фотографов, ладонь на камеру, хром и ночь',
      promptTemplate:
        'authentic early-2000s flash photograph, strong direct frontal camera flash, harsh falloff into darkness, visible film grain, slight motion blur, candid off-guard moment, no text, no logos, no brand marks, plain unbranded clothing. A woman in a long plain trench coat shielding her face with one hand as she steps out of a black car at night, wall of photographers, chrome door reflection.',
    },
    en: {
      title: 'Car Exit',
      description: 'Wall of photographers, palm to camera, chrome and night',
      promptTemplate:
        'authentic early-2000s flash photograph, strong direct frontal camera flash, harsh falloff into darkness, visible film grain, slight motion blur, candid off-guard moment, no text, no logos, no brand marks, plain unbranded clothing. A woman in a long plain trench coat shielding her face with one hand as she steps out of a black car at night, wall of photographers, chrome door reflection.',
    },
  },
];

/**
 * Build seed rows (2 locales per pack def) from PACK_DEFS.
 * The id is deterministic so ON CONFLICT DO UPDATE works correctly.
 */
export function buildPresetPackRows(): PresetPackInsert[] {
  const rows: PresetPackInsert[] = [];
  for (const def of PACK_DEFS) {
    // Motion packs (camera|effect|style + a user photo) run image-to-video and append
    // their camera/effect phrase after the user's prompt. Editorial 'scene' packs are
    // still full-string image prompts. Derive the recipe fields so existing behavior is
    // preserved across a reseed (the seed — not the migration backfill — is canonical).
    const isMotion = def.inputKind === 'image' && def.category !== 'scene';
    const modality = def.modality ?? (isMotion ? 'video' : 'image');
    // Motion presets are interactive recipes, not pre-rendered demos. Their
    // curated poster PNGs are the shipped asset set; pointing every one at a
    // fictional .mp4 caused a wall of 404s when the effect picker opened.
    // Video showcase packs (which have `modality:'video'` but no image input)
    // keep their real looped MP4 previews.
    const previewUrl = `${PREVIEW_BASE}/${def.slug}.${isMotion ? 'png' : modality === 'video' ? 'mp4' : 'png'}`;
    const shared = {
      slug: def.slug,
      modelId: def.modelId,
      paramsJson: def.params ?? {},
      samplePreviewUrl: previewUrl,
      previewWidth: def.previewWidth,
      previewHeight: def.previewHeight,
      sortOrder: def.sortOrder,
      isActive: def.isActive ?? true,
      category: def.category ?? 'scene',
      inputKind: def.inputKind ?? 'none',
      mergeMode: def.mergeMode ?? (isMotion ? 'suffix' : 'replace'),
      slots: def.slots ?? [],
      negativePrompt: def.negativePrompt ?? '',
      tags: def.tags ?? [],
      badge: def.badge ?? '',
      fallbackModelIds: def.fallbackModelIds ?? [],
      previewKind: modality as 'image' | 'video',
      modality: modality as 'image' | 'video',
    };
    rows.push({
      ...shared,
      id: `pp-${def.slug}-ru`,
      title: def.ru.title,
      description: def.ru.description,
      promptTemplate: def.ru.promptTemplate,
      locale: 'ru',
    });
    rows.push({
      ...shared,
      id: `pp-${def.slug}-en`,
      title: def.en.title,
      description: def.en.description,
      promptTemplate: def.en.promptTemplate,
      locale: 'en',
    });
  }
  return rows;
}
