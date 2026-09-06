import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendAuthEmailJob } from './auth-email';

const job = {
  to: 'otp-test@example.test',
  subject: 'test',
  text: 'test',
};

describe('auth.email delivery boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not fail local/e2e flows when SMTP is intentionally absent', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    await expect(sendAuthEmailJob(job)).resolves.toBe('skipped');
  });

  it('fails the worker job in production when SMTP is absent', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(sendAuthEmailJob(job)).rejects.toThrow('auth mailer not configured');
  });
});
