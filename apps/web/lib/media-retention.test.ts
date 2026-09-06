import { describe, expect, it } from 'vitest';
import { FREE_MEDIA_RETENTION_COPY } from '@seed/shared';

describe('@seed/shared media retention browser contract', () => {
  it('exports the shared reminder through the package entrypoint', () => {
    expect(FREE_MEDIA_RETENTION_COPY.split(' · ')).toEqual([
      'Хранится 30 дней',
      'Скачать',
      'Оставить навсегда → тариф',
    ]);
  });
});
