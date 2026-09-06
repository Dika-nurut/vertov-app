import { describe, expect, it } from 'vitest';
import { deskBatchStatusCopy, deskUploadErrorCopy } from './desk-upload-copy';

describe('desk upload copy', () => {
  it('never exposes internal status codes', () => {
    expect(deskBatchStatusCopy('done')).toBe('Готово');
    expect(deskBatchStatusCopy('failed')).toBe('Ошибка загрузки');
    expect(deskBatchStatusCopy('cancelled')).toBe('Загрузка отменена');
  });

  it('maps parser 413s and unknown failures to Russian product copy', () => {
    expect(deskUploadErrorCopy(Object.assign(new Error('upload_http_413'), { status: 413 }))).toBe(
      'Ошибка · файл больше 64 МБ',
    );
    expect(deskUploadErrorCopy(new Error('socket_reset'))).toBe('Ошибка загрузки');
  });
});
