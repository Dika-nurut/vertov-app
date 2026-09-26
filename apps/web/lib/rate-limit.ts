/**
 * 429 helpers shared by the login OTP sends and the anonymous bootstrap.
 * RU-first copy; a server Retry-After (delay seconds or an HTTP date) becomes
 * the "try again in …" tail, so the user gets a concrete wait, not a dead end.
 */

/** Parses a Retry-After header value into delay seconds, or null when absent/garbled. */
export function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  // Numeric-looking but not pure delay-seconds ('-3', '+5', '3.5'): V8's
  // Date.parse accepts some of these as ancient years, so reject before
  // the HTTP-date branch. Real HTTP dates never start with digit/sign/dot.
  if (/^[+-]?[\d.]/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return null;
}

/** RU 429 copy: concrete wait when the server sent Retry-After, else a plain nudge. */
export function rateLimitMessage(retryAfter: string | null): string {
  const secs = retryAfterSeconds(retryAfter);
  if (secs === null) return 'Слишком много попыток, попробуйте позже';
  if (secs < 60) return `Слишком много попыток, попробуйте через ${secs} с`;
  const mins = Math.ceil(secs / 60);
  return mins === 1
    ? 'Слишком много попыток, попробуйте через минуту'
    : `Слишком много попыток, попробуйте через ${mins} мин`;
}
