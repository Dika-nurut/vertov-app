import type { Locale } from './locale';

export type FeatureHintSurface = 'boards' | 'scenario-list' | 'studio';
export type TourStepKey = 'model' | 'prompt' | 'submit' | 'done';

export interface OnboardingCopy {
  card: {
    lead: string;
    gift: string;
    tail: string;
    confirm: string;
    skip: string;
    saving: string;
    retryError: string;
  };
  tour: Record<TourStepKey, { title: string; body: string }> & {
    next: string;
    finish: string;
    skip: string;
    dismissBackdrop: string;
  };
  featureHints: Record<FeatureHintSurface, string>;
  featureHintDismiss: string;
  mobile: {
    title: string;
    body: string;
    link: string;
  };
}

const COPY: Record<Locale, OnboardingCopy> = {
  ru: {
    card: {
      lead: 'У тебя ',
      gift: '210 токенов в подарок',
      tail: ' — без карты. Начни с генерации — пресеты можно выбрать прямо внутри неё.',
      confirm: 'Понятно',
      skip: 'Пропустить',
      saving: 'Сохраняем…',
      retryError: 'Не удалось сохранить. Проверь соединение и попробуй ещё раз.',
    },
    tour: {
      model: {
        title: 'Выберите модель',
        body: 'Выберите модель для первого кадра.',
      },
      prompt: {
        title: 'Напишите промт',
        body: 'Опишите, что хотите получить — русский промт работает.',
      },
      submit: {
        title: 'Нажмите «Создать»',
        body: 'Нажмите «Создать» — мы начнём генерацию.',
      },
      done: {
        title: 'Готово',
        body: 'Всё! Результат появится здесь.',
      },
      next: 'Далее',
      finish: 'Готово',
      skip: 'Пропустить',
      dismissBackdrop: 'Закрыть обучение',
    },
    featureHints: {
      boards:
        'Борд — это раскадровка: добавляй кадры, пиши промт к каждому, запускай генерацию пачкой. Начни с «Новый борд».',
      'scenario-list':
        'Сценарий — опиши идею в двух словах, Вёртов соберёт структуру и биты. Дальше правь как обычный сценарий.',
      studio:
        'Студия — это монтаж: собери готовые кадры в ролик, добавь музыку и субтитры, экспортируй в MP4.',
    },
    featureHintDismiss: 'Закрыть подсказку',
    mobile: {
      title: 'Полная версия — на десктопе',
      body: 'Эта часть Vertov рассчитана на большой экран. Открой генерацию на телефоне, чтобы создать кадр.',
      link: 'Открыть генерацию',
    },
  },
  en: {
    card: {
      lead: 'You have ',
      gift: '210 bonus tokens',
      tail: ' — no card required. Start with a generation; presets are available inside it.',
      confirm: 'Got it',
      skip: 'Skip',
      saving: 'Saving…',
      retryError: 'Could not save this yet. Check your connection and try again.',
    },
    tour: {
      model: {
        title: 'Choose a model',
        body: 'Choose a model for your first shot.',
      },
      prompt: {
        title: 'Write a prompt',
        body: 'Describe what you want to make — Russian prompts work too.',
      },
      submit: {
        title: 'Click Create',
        body: 'Click Create and we will start the generation.',
      },
      done: {
        title: 'Done',
        body: 'That’s it. Your result will appear here.',
      },
      next: 'Next',
      finish: 'Done',
      skip: 'Skip',
      dismissBackdrop: 'Close onboarding',
    },
    featureHints: {
      boards:
        'A board is your storyboard: add shots, write a prompt for each, and generate them as a batch. Start with “New board”.',
      'scenario-list':
        'Describe an idea in a few words and Vertov will build the structure and beats. Then edit it like a regular script.',
      studio:
        'Studio is your editor: assemble shots into a video, add music and captions, and export an MP4.',
    },
    featureHintDismiss: 'Close hint',
    mobile: {
      title: 'Full version available on desktop',
      body: 'This part of Vertov is built for a large screen. Open Generate on your phone to create a shot.',
      link: 'Open Generate',
    },
  },
};

export function getOnboardingCopy(locale: Locale): OnboardingCopy {
  return COPY[locale];
}
