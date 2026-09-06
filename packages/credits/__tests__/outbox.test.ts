import { describe, expect, it } from 'vitest';
import { AUTH_EMAIL_QUEUE } from '../src/queues';
import { scrubProcessedOutboxPayload } from '../src/outbox';

describe('outbox auth-email payload retention', () => {
  it('redacts single-use email contents after dispatch', () => {
    expect(
      scrubProcessedOutboxPayload(AUTH_EMAIL_QUEUE, {
        to: 'person@example.com',
        subject: 'login',
        text: 'code=123456',
      }),
    ).toEqual({ _redacted: true });
  });

  it('leaves non-auth payloads intact', () => {
    const payload = { jobId: 'job-1', amount: 1 };
    expect(scrubProcessedOutboxPayload('credits.commit', payload)).toBe(payload);
  });
});
