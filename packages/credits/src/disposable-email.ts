/** Maintained high-volume disposable-mail domains; extend from abuse reports. */
export const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  'dispostable.com',
  'emailondeck.com',
  'guerrillamail.com',
  'maildrop.cc',
  'mailinator.com',
  'mintemail.com',
  'sharklasers.com',
  'tempmail.com',
  'temp-mail.org',
  'trashmail.com',
  'yopmail.com',
]);

export function isDisposableEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}
