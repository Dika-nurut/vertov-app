export type JobFailureAction = 'retry' | 'settings' | 'replace_reference';

export interface JobFailureGuidance {
  message: string;
  action: JobFailureAction;
}

const REFUND_NOTE = ' Кредиты возвращены.';

/** One product-wide translation from provider/job errors to safe user guidance. */
export function jobFailureGuidance(
  code?: string | null,
  message?: string | null,
): JobFailureGuidance {
  const blob = `${code ?? ''} ${message ?? ''}`.toLowerCase();
  if (
    blob.includes('sensitive') ||
    blob.includes('privacy') ||
    blob.includes('real person') ||
    blob.includes('nsfw') ||
    blob.includes('moderat')
  ) {
    return {
      message: `Провайдер отклонил кадр: референс может содержать реального человека. Замените его изображением без реальных лиц.${REFUND_NOTE}`,
      action: 'replace_reference',
    };
  }
  if (blob.includes('402') || blob.includes('insufficient') || blob.includes('quota')) {
    return {
      message: `Сервис генерации временно перегружен. Повторите запуск чуть позже.${REFUND_NOTE}`,
      action: 'retry',
    };
  }
  if (
    blob.includes('reaped') ||
    blob.includes('queue not consumed') ||
    blob.includes('never started') ||
    blob.includes('running timeout')
  ) {
    return {
      message:
        'Генерация не завершилась вовремя и была остановлена. Кредиты возвращены — запуск можно повторить.',
      action: 'retry',
    };
  }
  const dimensionLimit = blob.match(
    /\b(width|height)\s+must\s+be\s+between\s+(\d+)\s*px\s+and\s+(\d+)\s*px\b/i,
  );
  if (dimensionLimit) {
    const axis = dimensionLimit[1] === 'height' ? 'высота' : 'ширина';
    return {
      message:
        `Размер референса не поддерживается: ${axis} должна быть от ${dimensionLimit[2]} до ${dimensionLimit[3]} px. ` +
        `Измените размер изображения и повторите запуск; соотношение сторон видео менять не нужно.${REFUND_NOTE}`,
      action: 'replace_reference',
    };
  }
  if (blob.includes('network') || blob.includes('timeout') || blob.includes('unreachable')) {
    return {
      message: `Провайдер не отвечает. Повторите запуск через минуту.${REFUND_NOTE}`,
      action: 'retry',
    };
  }
  if (blob.includes('invalid') || blob.includes('parameter') || blob.includes('size')) {
    return {
      message: `Провайдер отклонил параметры кадра. Проверьте настройки и запустите снова.${REFUND_NOTE}`,
      action: 'settings',
    };
  }
  const safeMessage = (message ?? '').trim().slice(0, 120);
  return {
    message: `${safeMessage || 'Генерация не завершилась. Повторите запуск.'}${REFUND_NOTE}`,
    action: 'retry',
  };
}
