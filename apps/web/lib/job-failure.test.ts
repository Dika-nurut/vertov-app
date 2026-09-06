import { describe, expect, it } from 'vitest';
import { jobFailureGuidance } from './job-failure';

describe('jobFailureGuidance', () => {
  it('turns privacy rejection into a reference-changing action', () => {
    expect(
      jobFailureGuidance('InputVideoSensitiveContentDetected.PrivacyInformation', 'real person'),
    ).toMatchObject({
      action: 'replace_reference',
      message: expect.stringContaining('Замените'),
    });
  });

  it('names refunded timeout recovery without claiming the job is still running', () => {
    expect(jobFailureGuidance('RUNNING_TIMEOUT', 'job reaped')).toMatchObject({
      action: 'retry',
      message: expect.stringMatching(/Кредиты возвращены.*повторить/i),
    });
  });

  it('routes invalid parameters to settings and bounds an unknown provider message', () => {
    expect(jobFailureGuidance('INVALID_PARAMETER', 'bad size')).toMatchObject({
      action: 'settings',
      message: expect.stringMatching(/Кредиты возвращены/i),
    });
    expect(jobFailureGuidance('OTHER', 'x'.repeat(500)).message).toMatch(/Кредиты возвращены/i);
  });

  it('turns provider reference-dimension limits into actionable guidance', () => {
    expect(
      jobFailureGuidance('INVALID_REQUEST', 'Width must be between 300px and 6000px'),
    ).toMatchObject({
      action: 'replace_reference',
      message: expect.stringMatching(/300.*6000.*соотношение сторон видео/i),
    });
  });

  it('confirms the refund for provider, moderation, and capacity failures', () => {
    for (const [code, message] of [
      ['NETWORK_ERROR', 'provider timeout'],
      ['MODERATION', 'sensitive content'],
      ['QUOTA', 'insufficient capacity'],
    ]) {
      expect(jobFailureGuidance(code, message).message).toMatch(/Кредиты возвращены/i);
    }
  });
});
