/** Browser-safe copy contract for every completed free-media save. */
export const FREE_MEDIA_RETENTION_COPY_PARTS = {
  storage: 'Хранится 30 дней',
  download: 'Скачать',
  permanent: 'Оставить навсегда → тариф',
} as const;

export const FREE_MEDIA_RETENTION_COPY =
  `${FREE_MEDIA_RETENTION_COPY_PARTS.storage} · ${FREE_MEDIA_RETENTION_COPY_PARTS.download} · ${FREE_MEDIA_RETENTION_COPY_PARTS.permanent}` as const;
