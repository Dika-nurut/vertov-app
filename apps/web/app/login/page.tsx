'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Send, Zap } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Mark } from '@/components/ui/mark';
import { rateLimitMessage } from '@/lib/rate-limit';
import { trackSignupStarted } from '../_components/PlausibleEvents';
import { VkIdWidget } from './VkIdWidget';
import { YandexWidget } from './YandexWidget';
import { loginNextTarget } from '@/lib/login-next';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// Cooldown between code sends so "Получить код" cannot be hammered (and the
// resend button has something truthful to count down).
const RESEND_COOLDOWN_S = 60;

/** Where to land after auth: a sanitized same-origin ?next= deep link (prompt /
 *  preset prefills carried through login), else /generate. Read lazily from
 *  window so the client page needs no useSearchParams Suspense boundary. */
function loginTarget(): string {
  return loginNextTarget(window.location.search);
}

function FlashBanner() {
  const params = useSearchParams();
  const flash = params.get('flash');
  if (flash === 'account_deleted') {
    return (
      <p
        data-testid="login-flash"
        className="mt-4 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-positive)] bg-[rgba(var(--positive-rgb),0.16)] px-3 py-2 text-[13px] font-bold text-positive"
      >
        Аккаунт удалён.
      </p>
    );
  }
  return null;
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [emailOtp, setEmailOtp] = useState('');
  const [emailOtpSent, setEmailOtpSent] = useState(false);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [emailResendIn, setEmailResendIn] = useState(0);
  const [phoneResendIn, setPhoneResendIn] = useState(0);
  const emailCodeRef = useRef<HTMLInputElement>(null);
  const phoneCodeRef = useRef<HTMLInputElement>(null);
  const isDev = process.env.NODE_ENV !== 'production';

  // Providers render only where the deployment wired them (creds API-side + this
  // build flag), so we never show a dead button.
  const vkEnabled = process.env.NEXT_PUBLIC_VK_ENABLED === '1';
  const yandexEnabled = process.env.NEXT_PUBLIC_YANDEX_ENABLED === '1';
  const mailruEnabled = process.env.NEXT_PUBLIC_MAILRU_ENABLED === '1';
  const okEnabled = process.env.NEXT_PUBLIC_OK_ENABLED === '1';
  const phoneEnabled = process.env.NEXT_PUBLIC_PHONE_ENABLED === '1';
  // OK + Mail.ru are federated through the VK ID widget, so only Yandex + VK
  // are top-level toggles here.
  const anyOAuth = yandexEnabled || vkEnabled;

  // Phone is the first-class method when SMS delivery is wired; email remains
  // available through the same, deliberately mechanical segmented switcher.
  const [mode, setMode] = useState<'email' | 'phone'>(phoneEnabled ? 'phone' : 'email');

  // a11y: move focus into the code field as soon as it appears, so keyboard
  // and screen-reader users land where the next action is.
  useEffect(() => {
    if (emailOtpSent) emailCodeRef.current?.focus();
  }, [emailOtpSent]);
  useEffect(() => {
    if (otpSent) phoneCodeRef.current?.focus();
  }, [otpSent]);

  // Resend cooldowns tick down once a second while a code is outstanding.
  useEffect(() => {
    if (!emailOtpSent || emailResendIn <= 0) return;
    const t = window.setTimeout(() => setEmailResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [emailOtpSent, emailResendIn]);
  useEffect(() => {
    if (!otpSent || phoneResendIn <= 0) return;
    const t = window.setTimeout(() => setPhoneResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [otpSent, phoneResendIn]);

  // 152-ФЗ: consent is given by the affirmative act of signing in (the fine print
  // below states it). We persist server-side proof once a session exists. Inline
  // paths call recordConsent; redirect paths (OAuth) stash intent for <ConsentFlush>.
  async function recordConsent(): Promise<void> {
    try {
      localStorage.removeItem('vertov_consent_pending');
      await fetch(`${API_URL}/v1/consent`, { method: 'POST', credentials: 'include' });
    } catch {
      /* non-blocking */
    }
  }
  function markConsentPending(): void {
    try {
      localStorage.setItem('vertov_consent_pending', '1');
    } catch {
      /* non-blocking */
    }
  }

  // OAuth: the sign-in endpoint replies with the provider consent URL in JSON, so
  // we read it and redirect. Consent intent is stashed for the authenticated landing.
  async function startOAuth(endpoint: string, body: Record<string, unknown>, failMsg: string) {
    markConsentPending();
    setState('sending');
    setErrorMsg(null);
    try {
      const r = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, callbackURL: `${window.location.origin}${loginTarget()}` }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { url } = (await r.json()) as { url?: string };
      if (!url) throw new Error('нет ссылки авторизации');
      window.location.href = url;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : failMsg);
      setState('error');
    }
  }

  const handleYandex = () =>
    startOAuth(
      '/api/auth/sign-in/oauth2',
      { providerId: 'yandex' },
      'Не удалось войти через Яндекс',
    );
  const handleVk = () =>
    startOAuth('/api/auth/sign-in/social', { provider: 'vk' }, 'Не удалось войти через VK');

  // VK ID widget bridge: the SDK verified+exchanged and our server bridge set the
  // session cookie, so just materialize the user, record consent, go in.
  async function handleVkIdSuccess() {
    await fetch(`${API_URL}/v1/me`, { credentials: 'include' });
    await recordConsent();
    window.location.href = loginTarget();
  }
  function handleVkIdError(msg: string) {
    setErrorMsg(msg);
    setState('error');
  }

  // Email login by CODE (6-digit, not a link): request → verify → session.
  // Send/verify are event-free so the submit button, the resend button, and
  // the paste-to-verify hook all share one path.
  async function sendEmailOtp() {
    if (!emailOtpSent) trackSignupStarted('email');
    setState('sending');
    setErrorMsg(null);
    try {
      const res = await fetch(`${API_URL}/api/auth/email-otp/send-verification-otp`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, type: 'sign-in' }),
      });
      if (!res.ok) {
        if (res.status === 429) throw new Error(rateLimitMessage(res.headers.get('retry-after')));
        throw new Error((await res.text()) || `HTTP ${res.status}`);
      }
      setEmailOtpSent(true);
      setEmailResendIn(RESEND_COOLDOWN_S);
      setState('idle');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Не удалось отправить код');
      setState('error');
    }
  }
  async function verifyEmailOtpCode(code: string) {
    setState('sending');
    setErrorMsg(null);
    try {
      const res = await fetch(`${API_URL}/api/auth/sign-in/email-otp`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, otp: code }),
      });
      if (!res.ok) {
        if (res.status === 429) throw new Error(rateLimitMessage(res.headers.get('retry-after')));
        throw new Error('Неверный код');
      }
      await fetch(`${API_URL}/v1/me`, { credentials: 'include' });
      await recordConsent();
      window.location.href = loginTarget();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Неверный код');
      setState('error');
    }
  }

  // Phone OTP (flash-call / SMS): request → verify → session.
  async function sendPhoneOtp() {
    if (!otpSent) trackSignupStarted('phone');
    setState('sending');
    setErrorMsg(null);
    try {
      const r = await fetch(`${API_URL}/api/auth/phone-number/send-otp`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      if (!r.ok) {
        if (r.status === 429) throw new Error(rateLimitMessage(r.headers.get('retry-after')));
        throw new Error(`HTTP ${r.status}`);
      }
      setOtpSent(true);
      setPhoneResendIn(RESEND_COOLDOWN_S);
      setState('idle');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Не удалось отправить код');
      setState('error');
    }
  }
  async function verifyPhoneOtpCode(code: string) {
    setState('sending');
    setErrorMsg(null);
    try {
      const r = await fetch(`${API_URL}/api/auth/phone-number/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone, code }),
      });
      if (!r.ok) {
        if (r.status === 429) throw new Error(rateLimitMessage(r.headers.get('retry-after')));
        throw new Error('Неверный код');
      }
      await fetch(`${API_URL}/v1/me`, { credentials: 'include' });
      await recordConsent();
      window.location.href = loginTarget();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Неверный код');
      setState('error');
    }
  }

  // Paste-to-verify: authenticator apps and SMS autofill hand over a 6-digit
  // code on the clipboard; a full code verifies immediately, a partial one
  // just lands in the field for manual completion.
  function handleOtpPaste(e: React.ClipboardEvent<HTMLInputElement>, kind: 'email' | 'phone') {
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (digits.length !== 6) return;
    e.preventDefault();
    if (kind === 'email') {
      setEmailOtp(digits);
      void verifyEmailOtpCode(digits);
    } else {
      setOtp(digits);
      void verifyPhoneOtpCode(digits);
    }
  }

  // Dev-only god mode (stripped from prod bundles; endpoints are dev-gated too).
  async function handleGod() {
    setState('sending');
    setErrorMsg(null);
    try {
      const signIn = await fetch(`${API_URL}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'god@seed.local',
          callbackURL: `${window.location.origin}/dev/enter`,
        }),
      });
      if (!signIn.ok) throw new Error(`sign-in HTTP ${signIn.status}`);
      const linkRes = await fetch(`${API_URL}/v1/dev/last-magic-link`, { credentials: 'include' });
      const { url } = (await linkRes.json()) as { url: string | null };
      if (!url) throw new Error('магическая ссылка не захвачена (dev)');
      window.location.href = url;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'God mode не сработал');
      setState('error');
    }
  }

  const busy = state === 'sending';
  const tab = (active: boolean) =>
    `press-inset flex h-10 flex-1 items-center justify-center gap-1.5 text-[13px] font-semibold transition-colors ${
      active
        ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
        : 'bg-[color:var(--color-surface2)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]'
    }`;

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm rounded-[var(--radius-lg)] border-[2.5px] border-[color:var(--color-line)] bg-card p-8 shadow-[var(--shadow-card)]">
        <span className="mb-5 flex items-center gap-2">
          <Mark variant="plate" size={30} aria-hidden />
          <span className="font-display text-[19px] font-black tracking-[0.05em] text-transparent [-webkit-text-stroke:1.4px_var(--color-line)] md:[-webkit-text-stroke:1.6px_var(--color-line)]">
            ВЕРТОВ
          </span>
        </span>
        <h1 className="mt-1 font-display text-[30px] font-black uppercase leading-[0.98] tracking-[-0.02em] text-[color:var(--color-fg)]">
          Вход в студию
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          ИИ-генерация картинок и видео на русском.
        </p>

        <Suspense fallback={null}>
          <FlashBanner />
        </Suspense>

        {/* --- OAuth (official SDK widgets; each carries its own keyboard
            fallback button in case the SDK script is blocked) --- */}
        {anyOAuth && (
          <div className="mt-6 space-y-2.5">
            {/* Yandex ID — the OFFICIAL YaAuthSuggest SDK widget. */}
            {yandexEnabled && (
              <YandexWidget
                onSuccess={handleVkIdSuccess}
                onError={handleVkIdError}
                onStart={() => trackSignupStarted('yandex')}
                onFallback={handleYandex}
              />
            )}
            {/* VK ID — official SDK widget (VK's rules require it); it also renders
                the official Odnoklassniki + Mail.ru, federated through one VK app. */}
            {vkEnabled && (
              <VkIdWidget
                onSuccess={handleVkIdSuccess}
                onError={handleVkIdError}
                onStart={() => trackSignupStarted('vk')}
                onFallback={handleVk}
              />
            )}
          </div>
        )}

        {/* --- divider --- */}
        {anyOAuth && (
          <div className="my-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-[color:var(--color-line)]/40" />
            <span className="text-[11px] uppercase tracking-[0.1em] text-[color:var(--color-muted-foreground)]">
              или
            </span>
            <span className="h-px flex-1 bg-[color:var(--color-line)]/40" />
          </div>
        )}

        {/* --- phone / email switch (only when phone OTP is enabled) --- */}
        {phoneEnabled && (
          <div className="mb-3">
            <p
              id="login-method-label"
              className="mb-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.13em] text-[color:var(--color-muted-foreground)]"
            >
              Способ входа
            </p>
            <div
              role="radiogroup"
              aria-labelledby="login-method-label"
              onKeyDown={(e) => {
                // Roving radio behaviour: arrows flip the method, Tab leaves.
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                setMode((m) => (m === 'phone' ? 'email' : 'phone'));
              }}
              className="flex overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] shadow-[var(--offset-sm)]"
            >
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'phone'}
                tabIndex={mode === 'phone' ? 0 : -1}
                onClick={() => setMode('phone')}
                data-testid="login-tab-phone"
                className={`${tab(mode === 'phone')} border-r-[2.5px] border-[color:var(--color-line)]`}
              >
                Телефон
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'email'}
                tabIndex={mode === 'email' ? 0 : -1}
                onClick={() => setMode('email')}
                data-testid="login-tab-email"
                className={tab(mode === 'email')}
              >
                Email
              </button>
            </div>
          </div>
        )}

        {/* --- email code form --- */}
        {mode === 'email' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (emailOtpSent) void verifyEmailOtpCode(emailOtp);
              else void sendEmailOtp();
            }}
            className="space-y-2.5"
          >
            <div>
              <label
                htmlFor="login-email"
                className="mb-1.5 block font-mono text-[11px] font-bold uppercase tracking-[0.13em] text-[color:var(--color-muted-foreground)]"
              >
                Ваш email
              </label>
              <Input
                id="login-email"
                type="email"
                name="email"
                autoComplete="email"
                required
                placeholder="Введите ваш email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={emailOtpSent}
                data-testid="login-email-input"
                className="h-11"
              />
            </div>
            {emailOtpSent && (
              <div>
                <label
                  htmlFor="login-email-code"
                  className="mb-1.5 block font-mono text-[11px] font-bold uppercase tracking-[0.13em] text-[color:var(--color-muted-foreground)]"
                >
                  Код из письма
                </label>
                <Input
                  id="login-email-code"
                  ref={emailCodeRef}
                  type="text"
                  name="email-otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  required
                  placeholder="Введите 6 цифр из письма"
                  value={emailOtp}
                  onChange={(e) => setEmailOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onPaste={(e) => handleOtpPaste(e, 'email')}
                  data-testid="login-email-code"
                  className="h-11"
                />
              </div>
            )}
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              data-testid="login-email-submit"
              className="w-full gap-2"
            >
              <Send size={15} />{' '}
              {busy
                ? emailOtpSent
                  ? 'Проверяем…'
                  : 'Отправка…'
                : emailOtpSent
                  ? 'Войти'
                  : 'Получить код'}
            </Button>
            {emailOtpSent && (
              <div className="space-y-1.5 text-center">
                <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
                  Код отправлен на почту — действует 10 минут.
                </p>
                <button
                  type="button"
                  onClick={() => void sendEmailOtp()}
                  disabled={busy || emailResendIn > 0}
                  data-testid="login-email-resend"
                  className="font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-fg)] underline decoration-[color:var(--color-line)] underline-offset-2 hover:text-[color:var(--color-accent)] disabled:no-underline disabled:opacity-50"
                >
                  {emailResendIn > 0
                    ? `Отправить снова через ${emailResendIn} с`
                    : 'Отправить код снова'}
                </button>
              </div>
            )}
          </form>
        )}

        {/* --- phone code form --- */}
        {phoneEnabled && mode === 'phone' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (otpSent) void verifyPhoneOtpCode(otp);
              else void sendPhoneOtp();
            }}
            className="space-y-2.5"
          >
            <div>
              <label
                htmlFor="login-phone"
                className="mb-1.5 block font-mono text-[11px] font-bold uppercase tracking-[0.13em] text-[color:var(--color-muted-foreground)]"
              >
                Ваш телефон
              </label>
              <Input
                id="login-phone"
                type="tel"
                name="phone"
                autoComplete="tel"
                required
                placeholder="Введите ваш телефон"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={otpSent}
                data-testid="login-phone-input"
                className="h-11"
              />
            </div>
            {otpSent && (
              <div>
                <label
                  htmlFor="login-phone-code"
                  className="mb-1.5 block font-mono text-[11px] font-bold uppercase tracking-[0.13em] text-[color:var(--color-muted-foreground)]"
                >
                  Код из звонка / SMS
                </label>
                <Input
                  id="login-phone-code"
                  ref={phoneCodeRef}
                  type="text"
                  name="phone-otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  required
                  placeholder="Введите 6 цифр из SMS"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onPaste={(e) => handleOtpPaste(e, 'phone')}
                  data-testid="login-phone-code"
                  className="h-11"
                />
              </div>
            )}
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              data-testid="login-phone-submit"
              className="w-full gap-2"
            >
              {busy ? 'Проверяем…' : otpSent ? 'Войти' : 'Получить код'}
            </Button>
            {otpSent && (
              <div className="space-y-1.5 text-center">
                <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
                  Код отправлен на телефон.
                </p>
                <button
                  type="button"
                  onClick={() => void sendPhoneOtp()}
                  disabled={busy || phoneResendIn > 0}
                  data-testid="login-phone-resend"
                  className="font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-fg)] underline decoration-[color:var(--color-line)] underline-offset-2 hover:text-[color:var(--color-accent)] disabled:no-underline disabled:opacity-50"
                >
                  {phoneResendIn > 0
                    ? `Отправить снова через ${phoneResendIn} с`
                    : 'Отправить код снова'}
                </button>
              </div>
            )}
          </form>
        )}

        {state === 'error' && (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {errorMsg ?? 'Ошибка'}
          </p>
        )}

        {/* --- fine-print consent (152-ФЗ): the act of continuing is the consent --- */}
        <p
          data-testid="login-consent-note"
          className="mt-5 text-center text-[11px] leading-[1.5] text-[color:var(--color-muted-foreground)]"
        >
          Продолжая, вы соглашаетесь с{' '}
          <a
            href="/legal/offer"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[color:var(--color-fg)] underline decoration-[color:var(--color-line)] underline-offset-2 hover:text-[color:var(--color-accent)]"
          >
            офертой
          </a>
          ,{' '}
          <a
            href="/legal/aup"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[color:var(--color-fg)] underline decoration-[color:var(--color-line)] underline-offset-2 hover:text-[color:var(--color-accent)]"
          >
            правилами
          </a>{' '}
          и{' '}
          <a
            href="/legal/consent"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[color:var(--color-fg)] underline decoration-[color:var(--color-line)] underline-offset-2 hover:text-[color:var(--color-accent)]"
          >
            обработкой персональных данных
          </a>
          .
        </p>

        {isDev && (
          <div className="mt-6 border-t-[1.5px] border-border pt-5">
            <p className="label-eyebrow mb-2 not-italic text-[11px] uppercase tracking-[0.08em]">
              только для разработки
            </p>
            <Button
              type="button"
              onClick={handleGod}
              data-testid="dev-god-login"
              variant="outline"
              className="w-full gap-2 border-[color:var(--color-primary)]/40 text-[color:var(--color-fg)] hover:bg-[color:var(--color-primary)]/15"
            >
              <Zap size={15} className="text-[color:var(--color-accent)]" /> God-режим (100 000
              токенов)
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
