export type DeskBatchStatus = 'running' | 'done' | 'failed' | 'rejected' | 'cancelled';

const STATUS_COPY: Record<DeskBatchStatus, string> = {
  running: 'Загрузка',
  done: 'Готово',
  failed: 'Ошибка загрузки',
  rejected: 'Отклонено',
  cancelled: 'Загрузка отменена',
};

export function deskBatchStatusCopy(status: DeskBatchStatus): string {
  return STATUS_COPY[status];
}

export function deskUploadErrorCopy(error: unknown): string {
  const candidate = error as { status?: number; message?: string } | null;
  if (candidate?.status === 413 || candidate?.message === 'upload_http_413') {
    return 'Ошибка · файл больше 64 МБ';
  }
  return 'Ошибка загрузки';
}
