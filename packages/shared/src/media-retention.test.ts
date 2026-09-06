import { describe, expect, it } from 'vitest';
import { FREE_MEDIA_RETENTION_COPY } from './media-retention';

describe('free media retention copy', () => {
  it('keeps the product contract byte-exact in a browser-safe module', () => {
    expect(FREE_MEDIA_RETENTION_COPY).toBe(
      'Хранится 30 дней · Скачать · Оставить навсегда → тариф',
    );
  });
});
