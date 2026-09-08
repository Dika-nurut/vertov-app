/** Public contract for support uploads. Keep this list deliberately narrow. */
export const SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export type SupportAttachmentContentType =
  (typeof SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES)[number];

export const SUPPORT_ATTACHMENT_MAX_FILES = 3;
export const SUPPORT_ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES =
  SUPPORT_ATTACHMENT_MAX_FILES * SUPPORT_ATTACHMENT_MAX_FILE_BYTES;
export const SUPPORT_ATTACHMENT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_MAX_TEXT_BYTES = 64 * 1024;
export const SUPPORT_ATTACHMENT_MAX_PARTS = SUPPORT_ATTACHMENT_MAX_FILES + 5;

/** Separate from the public asset bucket; no edge route exposes this bucket. */
export const SUPPORT_ATTACHMENT_BUCKET = 'seed-support-attachments';
export const SUPPORT_ATTACHMENT_PREFIX = 'support/';
export const SUPPORT_ATTACHMENT_RETENTION_DAYS = 1;

/**
 * Queue payloads are untrusted at the worker boundary. Keep the key grammar
 * shared so request ids accepted by the API remain readable by the worker.
 */
export function isSafeSupportAttachmentKey(objectKey: string): boolean {
  if (!objectKey.startsWith(SUPPORT_ATTACHMENT_PREFIX) || objectKey.includes('..')) return false;
  const parts = objectKey.slice(SUPPORT_ATTACHMENT_PREFIX.length).split('/');
  return (
    parts.length === 2 &&
    /^[A-Za-z0-9._-]{1,128}$/.test(parts[0] ?? '') &&
    /^[A-Za-z0-9_-]{1,64}$/.test(parts[1] ?? '')
  );
}

export function isSafeSupportAttachmentFilename(filename: string): boolean {
  return (
    filename.length > 0 && filename.length <= 120 && !/[\u0000-\u001f\u007f/\\]/.test(filename)
  );
}

export interface SupportAttachmentRef {
  objectKey: string;
  filename: string;
  contentType: SupportAttachmentContentType;
  sizeBytes: number;
}
