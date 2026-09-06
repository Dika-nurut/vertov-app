import nodemailer from 'nodemailer';
import type { AuthEmailJob } from '@seed/credits';

/**
 * SMTP is deliberately constructed in the worker, never in the API process.
 * A provider that stalls therefore cannot hold an auth HTTP request open.
 */
const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null;
const smtpTimeoutMs = Number(process.env.SMTP_TIMEOUT_MS ?? 10_000);
const validTimeoutMs = Number.isFinite(smtpTimeoutMs) && smtpTimeoutMs > 0 ? smtpTimeoutMs : 10_000;
const smtpConfigured = Boolean(
  process.env.SMTP_HOST &&
    smtpPort &&
    Number.isInteger(smtpPort) &&
    smtpPort > 0 &&
    smtpPort <= 65_535 &&
    process.env.SMTP_FROM,
);

const smtpTransport = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST as string,
      port: smtpPort as number,
      secure: smtpPort === 465,
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      // Do not let a dead SMTP endpoint strand a worker forever. BullMQ retries
      // the job after this bounded attempt fails.
      connectionTimeout: validTimeoutMs,
      greetingTimeout: validTimeoutMs,
      socketTimeout: validTimeoutMs,
    })
  : null;

/** Send one queued auth email. The destination/message are never logged. */
export async function sendAuthEmailJob(job: AuthEmailJob): Promise<'sent' | 'skipped'> {
  if (!smtpTransport || !process.env.SMTP_FROM) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('auth mailer not configured: set SMTP_HOST+SMTP_FROM');
    }
    // Local/e2e keeps the OTP/link observable through the auth dev-capture
    // endpoint. Treat the job as complete when there is intentionally no SMTP.
    return 'skipped';
  }

  try {
    await smtpTransport.sendMail({
      from: process.env.SMTP_FROM,
      to: job.to,
      subject: job.subject,
      text: job.text,
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
  return 'sent';
}
