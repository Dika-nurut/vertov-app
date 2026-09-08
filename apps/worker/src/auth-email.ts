import nodemailer, { type SendMailOptions } from 'nodemailer';
import type { AuthEmailAttachment, AuthEmailJob } from '@seed/credits';
import {
  SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES,
  SUPPORT_ATTACHMENT_MAX_FILES,
  SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES,
  isSafeSupportAttachmentFilename,
  isSafeSupportAttachmentKey,
} from '@seed/shared/support-attachments';
import {
  SupportAttachmentStorage,
  type SupportAttachmentAccess,
} from './support-attachment-storage';

/**
 * SMTP is deliberately constructed in the worker, never in the API process.
 * A provider that stalls therefore cannot hold an auth HTTP request open.
 */
type MailAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};

export interface AuthEmailTransport {
  sendMail(options: SendMailOptions): Promise<unknown>;
}

export interface AuthEmailSenderOptions {
  env?: NodeJS.ProcessEnv;
  transport?: AuthEmailTransport | null;
  attachmentStorage?: SupportAttachmentAccess;
}

function createSmtpTransport(env: NodeJS.ProcessEnv): AuthEmailTransport | null {
  const smtpPort = env.SMTP_PORT ? Number(env.SMTP_PORT) : null;
  const smtpTimeoutMs = Number(env.SMTP_TIMEOUT_MS ?? 10_000);
  const validTimeoutMs =
    Number.isFinite(smtpTimeoutMs) && smtpTimeoutMs > 0 ? smtpTimeoutMs : 10_000;
  const smtpConfigured = Boolean(
    env.SMTP_HOST &&
      smtpPort &&
      Number.isInteger(smtpPort) &&
      smtpPort > 0 &&
      smtpPort <= 65_535 &&
      env.SMTP_FROM,
  );
  if (!smtpConfigured) return null;
  return nodemailer.createTransport({
    host: env.SMTP_HOST as string,
    port: smtpPort as number,
    secure: smtpPort === 465,
    auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    // Do not let a dead SMTP endpoint strand a worker forever. BullMQ retries
    // the job after this bounded attempt fails.
    connectionTimeout: validTimeoutMs,
    greetingTimeout: validTimeoutMs,
    socketTimeout: validTimeoutMs,
  });
}

function isAllowedContentType(contentType: string): boolean {
  return SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES.includes(
    contentType as (typeof SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES)[number],
  );
}

function validateAttachments(job: AuthEmailJob): AuthEmailAttachment[] {
  const raw = (job as unknown as { attachments?: unknown } | null)?.attachments;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > SUPPORT_ATTACHMENT_MAX_FILES) {
    throw new Error('invalid support attachment payload');
  }

  let totalBytes = 0;
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('invalid support attachment payload');
    }
    const attachment = candidate as Partial<AuthEmailAttachment>;
    const sizeBytes = attachment.sizeBytes;
    if (
      typeof attachment.objectKey !== 'string' ||
      !isSafeSupportAttachmentKey(attachment.objectKey) ||
      typeof attachment.filename !== 'string' ||
      !isSafeSupportAttachmentFilename(attachment.filename) ||
      typeof attachment.contentType !== 'string' ||
      !isAllowedContentType(attachment.contentType) ||
      typeof sizeBytes !== 'number' ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1
    ) {
      throw new Error('invalid support attachment payload');
    }
    totalBytes += sizeBytes;
    if (totalBytes > SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new Error('support attachment payload exceeds size limit');
    }
  }
  return raw as AuthEmailAttachment[];
}

async function loadSupportAttachments(
  attachments: AuthEmailAttachment[],
  storage: SupportAttachmentAccess,
): Promise<MailAttachment[]> {
  const loaded: MailAttachment[] = [];
  for (const attachment of attachments) {
    const content = await storage.read(attachment);
    if (content.length !== attachment.sizeBytes) {
      throw new Error('support attachment size mismatch');
    }
    loaded.push({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content,
    });
  }
  return loaded;
}

function cleanupAttachments(storage: SupportAttachmentAccess, attachments: AuthEmailAttachment[]) {
  return storage.remove(attachments.map((attachment) => attachment.objectKey)).catch(() => {});
}

/** Create a sender with dependencies fixed once for the worker process. */
export function createAuthEmailSender(options: AuthEmailSenderOptions = {}) {
  const env = options.env ?? process.env;
  const smtpTransport =
    options.transport === undefined ? createSmtpTransport(env) : options.transport;
  let attachmentStorage = options.attachmentStorage;
  const getAttachmentStorage = (): SupportAttachmentAccess =>
    (attachmentStorage ??= new SupportAttachmentStorage(env));

  return async function sendAuthEmailJob(job: AuthEmailJob): Promise<'sent' | 'skipped'> {
    const attachments = validateAttachments(job);
    if (!smtpTransport || !env.SMTP_FROM) {
      if (env.NODE_ENV === 'production') {
        throw new Error('auth mailer not configured: set SMTP_HOST+SMTP_FROM');
      }
      // Local/e2e keeps the OTP/link observable through the auth dev-capture
      // endpoint. Treat the job as complete when there is intentionally no SMTP,
      // but do not leave uploaded support files behind.
      if (attachments.length > 0) await cleanupAttachments(getAttachmentStorage(), attachments);
      return 'skipped';
    }

    try {
      const mailAttachments =
        attachments.length > 0
          ? await loadSupportAttachments(attachments, getAttachmentStorage())
          : [];
      await smtpTransport.sendMail({
        from: env.SMTP_FROM,
        to: job.to,
        subject: job.subject,
        text: job.text,
        ...(mailAttachments.length > 0 ? { attachments: mailAttachments } : {}),
      });
    } catch (error) {
      // Nodemailer's raw error can echo the recipient. Keep the retry signal but
      // do not put an address (or message body) into worker logs/Sentry.
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : null;
      throw new Error(`SMTP delivery failed${code ? ` (${code})` : ''}`);
    }
    if (attachments.length > 0) {
      // Mail is already accepted at this point. A cleanup failure must not retry
      // the message and send a duplicate; the bucket lifecycle is the fallback.
      await cleanupAttachments(getAttachmentStorage(), attachments);
    }
    return 'sent';
  };
}

/** Send one queued auth email. The destination/message are never logged. */
export async function sendAuthEmailJob(job: AuthEmailJob): Promise<'sent' | 'skipped'> {
  return createAuthEmailSender()(job);
}
