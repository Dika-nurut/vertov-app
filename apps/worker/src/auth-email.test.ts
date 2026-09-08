import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthEmailAttachment, AuthEmailJob } from '@seed/credits';
import { createAuthEmailSender, type AuthEmailTransport } from './auth-email';
import type { SupportAttachmentAccess } from './support-attachment-storage';

const job: AuthEmailJob = {
  to: 'otp-test@example.test',
  subject: 'test',
  text: 'test',
};

const attachment: AuthEmailAttachment = {
  objectKey: 'support/request.id/file_1',
  filename: 'error.png',
  contentType: 'image/png',
  sizeBytes: 5,
};

describe('auth.email delivery boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not fail local/e2e flows when SMTP is intentionally absent', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const sender = createAuthEmailSender({ env: { NODE_ENV: 'test' }, transport: null });
    await expect(sender(job)).resolves.toBe('skipped');
  });

  it('fails the worker job in production when SMTP is absent', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const sender = createAuthEmailSender({ env: { NODE_ENV: 'production' }, transport: null });
    await expect(sender(job)).rejects.toThrow('auth mailer not configured');
  });

  it('loads support attachments, sends them, and removes them after delivery', async () => {
    const content = Buffer.from('image');
    const read = vi.fn(async () => content);
    const remove = vi.fn(async () => {});
    const storage: SupportAttachmentAccess = { read, remove };
    const sendMail = vi.fn<AuthEmailTransport['sendMail']>(async () => ({}));
    const transport: AuthEmailTransport = { sendMail };
    const sender = createAuthEmailSender({
      env: { NODE_ENV: 'production', SMTP_FROM: 'support@example.test' },
      transport,
      attachmentStorage: storage,
    });

    await expect(sender({ ...job, attachments: [attachment] })).resolves.toBe('sent');
    expect(read).toHaveBeenCalledWith(attachment);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'support@example.test',
        attachments: [
          expect.objectContaining({
            filename: 'error.png',
            contentType: 'image/png',
            content,
          }),
        ],
      }),
    );
    expect(remove).toHaveBeenCalledWith([attachment.objectKey]);
  });

  it('keeps attachments for a retry when SMTP delivery fails', async () => {
    const remove = vi.fn(async () => {});
    const storage: SupportAttachmentAccess = {
      read: vi.fn(async () => Buffer.from('image')),
      remove,
    };
    const error = Object.assign(new Error('connection failed'), { code: 'ECONNRESET' });
    const sendMail = vi.fn<AuthEmailTransport['sendMail']>(async () => {
      throw error;
    });
    const transport: AuthEmailTransport = { sendMail };
    const sender = createAuthEmailSender({
      env: { NODE_ENV: 'production', SMTP_FROM: 'support@example.test' },
      transport,
      attachmentStorage: storage,
    });

    await expect(sender({ ...job, attachments: [attachment] })).rejects.toThrow(
      'SMTP delivery failed (ECONNRESET)',
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('cleans attachments when local SMTP is intentionally skipped', async () => {
    const remove = vi.fn(async () => {});
    const storage: SupportAttachmentAccess = {
      read: vi.fn(),
      remove,
    };
    const sender = createAuthEmailSender({
      env: { NODE_ENV: 'test' },
      transport: null,
      attachmentStorage: storage,
    });

    await expect(sender({ ...job, attachments: [attachment] })).resolves.toBe('skipped');
    expect(storage.read).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith([attachment.objectKey]);
  });

  it('rejects malformed or oversized queue attachment payloads before reading storage', async () => {
    const storage: SupportAttachmentAccess = {
      read: vi.fn(),
      remove: vi.fn(async () => {}),
    };
    const sender = createAuthEmailSender({
      env: { NODE_ENV: 'production', SMTP_FROM: 'support@example.test' },
      transport: { sendMail: vi.fn<AuthEmailTransport['sendMail']>(async () => ({})) },
      attachmentStorage: storage,
    });

    await expect(
      sender({
        ...job,
        attachments: [attachment, attachment, attachment, attachment],
      }),
    ).rejects.toThrow('invalid support attachment payload');
    await expect(
      sender({
        ...job,
        attachments: [{ ...attachment, objectKey: 'support/../escape' }],
      }),
    ).rejects.toThrow('invalid support attachment payload');
    expect(storage.read).not.toHaveBeenCalled();
  });
});
