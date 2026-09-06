'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Link2Off,
  LogOut,
  Monitor,
  ShieldCheck,
  Smartphone,
} from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { TokenStar } from '@/components/ui/token-star';
import { TIER_LABEL, type Tier } from '@/lib/tier-label';

interface LinkedAccount {
  id: string;
  provider: string;
  label: string;
  accountId: string;
}
interface ActiveSession {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** Coarse, dependency-free UA → device label (display only, never trusted). */
function deviceLabel(ua: string | null): { name: string; mobile: boolean } {
  const s = ua ?? '';
  const mobile = /Mobile|iPhone|Android|iPad/i.test(s);
  const os = /iPhone|iPad/i.test(s)
    ? 'iOS'
    : /Android/i.test(s)
      ? 'Android'
      : /Windows/i.test(s)
        ? 'Windows'
        : /Mac OS X|Macintosh/i.test(s)
          ? 'macOS'
          : /Linux/i.test(s)
            ? 'Linux'
            : '';
  const browser = /Edg\//i.test(s)
    ? 'Edge'
    : /Chrome\//i.test(s)
      ? 'Chrome'
      : /Firefox\//i.test(s)
        ? 'Firefox'
        : /Safari\//i.test(s)
          ? 'Safari'
          : 'Браузер';
  return { name: [browser, os].filter(Boolean).join(' · ') || 'Сессия', mobile };
}

interface InitialProfile {
  displayName: string;
  locale: 'ru' | 'en';
  email: string;
  tier: Tier | null;
  balance: number;
  version: string;
  // Free-token Phase 1: phone-binding block. Gated OFF by default (SMSC
  // operators unpaid) — the whole «Телефон» card is hidden when disabled.
  phoneBindingEnabled: boolean;
  phone: string | null;
  phoneVerified: boolean;
}

// Help + legal/about — the links that live in the desktop footer. The full-page
// profile gathers them in one «Помощь и документы» block (the standard mobile
// pattern: legal/about as a scannable settings section, not a footer).
const DOC_LINKS: { href: string; label: string }[] = [
  { href: '/faq', label: 'Вопросы и ответы' },
  { href: '/legal/offer', label: 'Оферта' },
  { href: '/legal/tos', label: 'Условия' },
  { href: '/legal/aup', label: 'Правила' },
  { href: '/legal/privacy', label: 'Конфиденциальность' },
  { href: '/legal/refund', label: 'Возврат' },
  { href: '/legal/requisites', label: 'Реквизиты' },
];

function initials(name: string, email: string): string {
  const base = name.trim() || email.split('@')[0] || '';
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
  return (letters || base.slice(0, 2)).toUpperCase();
}

export function SettingsClient({ apiUrl, initial }: { apiUrl: string; initial: InitialProfile }) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [locale, setLocale] = useState<'ru' | 'en'>(initial.locale);
  const [profileMsg, setProfileMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null);
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [secMsg, setSecMsg] = useState<string | null>(null);

  // Phone binding (free-token L2). Two-step OTP via the same Better Auth
  // endpoints the login screen uses. On verify we re-hit /v1/me so the server
  // fires the L2 grant, then refresh the page to reflect the new state.
  const [phoneVal, setPhoneVal] = useState('');
  const [phoneOtp, setPhoneOtp] = useState('');
  const [phoneStep, setPhoneStep] = useState<'idle' | 'code'>('idle');
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);

  async function onSendPhoneOtp() {
    setPhoneBusy(true);
    setPhoneErr(null);
    try {
      const r = await fetch(`${apiUrl}/api/auth/phone-number/send-otp`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phoneVal.trim() }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPhoneStep('code');
    } catch {
      setPhoneErr('Не удалось отправить код. Попробуйте ещё раз.');
    } finally {
      setPhoneBusy(false);
    }
  }

  async function onVerifyPhoneOtp() {
    setPhoneBusy(true);
    setPhoneErr(null);
    try {
      const r = await fetch(`${apiUrl}/api/auth/phone-number/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: phoneVal.trim(),
          code: phoneOtp.trim(),
          updatePhoneNumber: true,
        }),
      });
      if (!r.ok) throw new Error('bad-code');
      // Re-run /v1/me so the server applies the L2 welcome grant, then refresh.
      await fetch(`${apiUrl}/v1/me`, { credentials: 'include' });
      router.refresh();
    } catch {
      setPhoneErr('Неверный код.');
    } finally {
      setPhoneBusy(false);
    }
  }

  // Load the account-security surface (linked identities + active sessions) on
  // mount. Soft-fail to an empty list so a transient error never blocks the page.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [a, s] = await Promise.all([
          fetch(`${apiUrl}/v1/me/accounts`, { credentials: 'include' }),
          fetch(`${apiUrl}/v1/me/sessions`, { credentials: 'include' }),
        ]);
        if (!alive) return;
        if (a.ok) setAccounts(((await a.json()).items ?? []) as LinkedAccount[]);
        else setAccounts([]);
        if (s.ok) setSessions(((await s.json()).items ?? []) as ActiveSession[]);
        else setSessions([]);
      } catch {
        if (alive) {
          setAccounts([]);
          setSessions([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [apiUrl]);

  async function onUnlink(a: LinkedAccount) {
    setSecMsg(null);
    try {
      const res = await fetch(`${apiUrl}/v1/me/accounts/unlink`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: a.provider, accountId: a.accountId }),
      });
      if (res.ok) {
        setAccounts((prev) => (prev ? prev.filter((x) => x.id !== a.id) : prev));
        return;
      }
      const body = await res.json().catch(() => ({}));
      setSecMsg(
        body?.error === 'last_login_method'
          ? 'Нельзя отвязать последний способ входа.'
          : 'Не удалось отвязать.',
      );
    } catch {
      setSecMsg('Сетевая ошибка');
    }
  }

  async function onRevoke(id: string) {
    setSecMsg(null);
    try {
      const res = await fetch(`${apiUrl}/v1/me/sessions/revoke`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        setSessions((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
      } else {
        setSecMsg('Не удалось завершить сессию.');
      }
    } catch {
      setSecMsg('Сетевая ошибка');
    }
  }

  async function onRevokeOthers() {
    setSecMsg(null);
    try {
      const res = await fetch(`${apiUrl}/v1/me/sessions/revoke-others`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        setSessions((prev) => (prev ? prev.filter((x) => x.current) : prev));
      } else {
        setSecMsg('Не удалось завершить сессии.');
      }
    } catch {
      setSecMsg('Сетевая ошибка');
    }
  }

  // Email change (two-step: request a code to the new address, then confirm).
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailStep, setEmailStep] = useState<'request' | 'code'>('request');
  const [newEmail, setNewEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailMsg, setEmailMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);

  function resetEmail() {
    setEmailOpen(false);
    setEmailStep('request');
    setNewEmail('');
    setEmailCode('');
    setEmailMsg(null);
  }

  async function onRequestEmail() {
    const v = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      setEmailMsg({ kind: 'err', text: 'Введи корректный email.' });
      return;
    }
    setEmailBusy(true);
    setEmailMsg(null);
    try {
      const res = await fetch(`${apiUrl}/v1/me/email/request`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newEmail: v }),
      });
      if (res.ok) {
        setEmailStep('code');
        setEmailMsg({ kind: 'ok', text: `Код отправлен на ${v}.` });
        return;
      }
      const b = await res.json().catch(() => ({}));
      setEmailMsg({
        kind: 'err',
        text:
          b?.error === 'email_taken'
            ? 'Этот email уже занят.'
            : b?.error === 'same_email'
              ? 'Это твой текущий email.'
              : 'Не удалось отправить код.',
      });
    } catch {
      setEmailMsg({ kind: 'err', text: 'Сетевая ошибка' });
    } finally {
      setEmailBusy(false);
    }
  }

  async function onConfirmEmail() {
    const c = emailCode.trim();
    if (!/^\d{6}$/.test(c)) {
      setEmailMsg({ kind: 'err', text: 'Код — 6 цифр.' });
      return;
    }
    setEmailBusy(true);
    setEmailMsg(null);
    try {
      const res = await fetch(`${apiUrl}/v1/me/email/confirm`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: c }),
      });
      if (res.ok) {
        resetEmail();
        router.refresh();
        return;
      }
      const b = await res.json().catch(() => ({}));
      setEmailMsg({
        kind: 'err',
        text:
          b?.error === 'code_mismatch'
            ? 'Неверный код.'
            : b?.error === 'expired'
              ? 'Код истёк — запроси новый.'
              : b?.error === 'email_taken'
                ? 'Этот email уже занят.'
                : 'Не удалось подтвердить.',
      });
    } catch {
      setEmailMsg({ kind: 'err', text: 'Сетевая ошибка' });
    } finally {
      setEmailBusy(false);
    }
  }

  const nameDirty = displayName.trim() !== initial.displayName.trim();
  // Billing page hosts both subscription management and pack history; route the
  // primary CTA there for every tier (the page itself upsells plans to free
  // users). e2e (billing.spec) relies on this link going to /settings/billing.
  const billingHref = '/settings/billing';
  const planCta =
    initial.tier === null || initial.tier === 'free' ? 'Тариф и оплата →' : 'Управлять подпиской →';

  async function onSaveName() {
    if (!nameDirty || displayName.trim().length === 0) return;
    setSaving(true);
    setProfileMsg(null);
    try {
      const res = await fetch(`${apiUrl}/v1/me/profile`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: displayName.trim(), locale }),
      });
      if (!res.ok) {
        setProfileMsg({ kind: 'err', text: `Ошибка (HTTP ${res.status})` });
        return;
      }
      setProfileMsg({ kind: 'ok', text: 'Сохранено.' });
      router.refresh();
    } catch {
      setProfileMsg({ kind: 'err', text: 'Сетевая ошибка' });
    } finally {
      setSaving(false);
    }
  }

  async function onLocale(next: 'ru' | 'en') {
    if (next === locale) return;
    setLocale(next);
    try {
      await fetch(`${apiUrl}/v1/me/locale`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      });
      router.refresh();
    } catch {
      // Soft-fail: the toggle still reflects intent; a refresh will reconcile.
    }
  }

  async function onExport() {
    setExporting(true);
    setExportErr(null);
    try {
      const res = await fetch(`${apiUrl}/v1/me/export`, { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vertov-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportErr('Не удалось выгрузить данные.');
    } finally {
      setExporting(false);
    }
  }

  async function onDelete() {
    setDeleteErr(null);
    setDeleting(true);
    try {
      const res = await fetch(`${apiUrl}/v1/me`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmEmail: deleteConfirm }),
      });
      if (res.ok) {
        router.push('/login?flash=account_deleted');
        return;
      }
      const body = await res.json().catch(() => ({}));
      setDeleteErr(
        body?.error === 'email_mismatch'
          ? 'Email не совпадает.'
          : `Не удалось удалить (HTTP ${res.status}).`,
      );
    } catch {
      setDeleteErr('Сетевая ошибка');
    } finally {
      setDeleting(false);
    }
  }

  /* ---- shared section blocks (rendered in both mobile + desktop layouts) ---- */

  const accountHeader = (
    <div className="flex items-center gap-3.5">
      <span className="grid h-14 w-14 shrink-0 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] font-mono text-[15px] font-extrabold text-[color:var(--color-primary-foreground)]">
        {initials(initial.displayName, initial.email)}
      </span>
      <div className="min-w-0">
        <p className="font-display truncate text-[18px] font-black tracking-tight text-[color:var(--color-fg)]">
          {initial.displayName || initial.email.split('@')[0]}
        </p>
        <p className="truncate font-mono text-[11px] text-[color:var(--color-faint)]">
          {initial.email}
        </p>
        {initial.tier && (
          <span className="mt-1.5 inline-block rounded-[var(--radius-xs)] border-2 border-[color:var(--color-accent)] px-1.5 py-0.5 font-mono text-[9px] font-extrabold uppercase tracking-wide text-[color:var(--color-accent)]">
            {TIER_LABEL[initial.tier]}
          </span>
        )}
      </div>
    </div>
  );

  const balanceCard = (
    <section>
      <SecLabel>Тариф и баланс</SecLabel>
      <div className="overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-4 shadow-[4px_4px_0_0_var(--color-shadow)]">
        <div className="flex items-center gap-2">
          <TokenStar size={14} className="text-[color:var(--color-accent)]" />
          <span className="font-display text-[26px] font-black leading-none text-[color:var(--color-fg)]">
            {initial.balance}
          </span>
        </div>
        <p className="mt-1.5 font-mono text-[10px] font-bold uppercase text-[color:var(--color-muted-foreground)]">
          {initial.tier ? `Тариф · ${TIER_LABEL[initial.tier]}` : 'Не удалось проверить тариф'}
        </p>
        <Link
          href={billingHref}
          data-testid="settings-billing-link"
          className="press-inset mt-3 flex h-11 items-center justify-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-accent)] bg-[color:var(--color-accent)] font-mono text-[10.5px] font-extrabold uppercase tracking-wide text-[color:var(--color-primary-foreground)]"
        >
          {planCta}
        </Link>
      </div>
    </section>
  );

  const accountCard = (
    <section>
      <SecLabel>Аккаунт</SecLabel>
      <div className="overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)]">
        {/* Name */}
        <div className="flex items-center gap-3 px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="display-name"
              className="block font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-faint)]"
            >
              Имя
            </label>
            <input
              id="display-name"
              data-testid="display-name"
              value={displayName}
              maxLength={64}
              onChange={(e) => setDisplayName(e.target.value.slice(0, 64))}
              className="mt-0.5 w-full bg-transparent text-[14px] font-semibold text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-faint)]"
              placeholder="Твоё имя"
            />
          </div>
          {nameDirty && (
            <button
              type="button"
              data-testid="save-profile"
              onClick={onSaveName}
              disabled={saving || displayName.trim().length === 0}
              className="press-inset shrink-0 rounded-[var(--radius-xs)] border-2 border-[color:var(--color-accent)] px-3 py-1.5 font-mono text-[9px] font-extrabold uppercase tracking-wide text-[color:var(--color-accent)] disabled:opacity-50"
            >
              {saving ? '…' : 'Сохранить'}
            </button>
          )}
        </div>
        {/* Language */}
        <div className="flex items-center justify-between gap-3 border-t-2 border-[color:var(--color-line)] px-3.5 py-3.5">
          <span className="text-[14px] font-semibold text-[color:var(--color-fg)]">Язык</span>
          <div
            data-testid="locale"
            className="flex overflow-hidden rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)]"
          >
            {(['ru', 'en'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => onLocale(l)}
                aria-pressed={locale === l}
                className={
                  'px-3 py-1 font-mono text-[10px] font-extrabold uppercase ' +
                  (locale === l
                    ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                    : 'text-[color:var(--color-faint)]')
                }
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        {/* Email — display + two-step verified change. */}
        <div className="border-t-2 border-[color:var(--color-line)] px-3.5 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-faint)]">
                Email
              </span>
              <span className="mt-0.5 block truncate text-[14px] font-semibold text-[color:var(--color-fg)]">
                {initial.email}
              </span>
            </div>
            {!emailOpen && (
              <button
                type="button"
                data-testid="email-change-open"
                onClick={() => {
                  setEmailOpen(true);
                  setEmailMsg(null);
                }}
                className="press-inset shrink-0 rounded-[var(--radius-xs)] border-2 border-[color:var(--color-accent)] px-3 py-1.5 font-mono text-[9px] font-extrabold uppercase tracking-wide text-[color:var(--color-accent)]"
              >
                Изменить
              </button>
            )}
          </div>

          {emailOpen && (
            <div className="mt-3 space-y-2.5">
              {emailStep === 'request' ? (
                <>
                  <input
                    type="email"
                    autoFocus
                    data-testid="email-new"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="новый@email.ru"
                    className="w-full rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 py-2 text-[14px] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      data-testid="email-request"
                      disabled={emailBusy}
                      onClick={onRequestEmail}
                      className="press-inset flex-1 rounded-[var(--radius-xs)] border-2 border-[color:var(--color-accent)] bg-[color:var(--color-accent)] py-2 font-mono text-[9.5px] font-extrabold uppercase tracking-wide text-[color:var(--color-primary-foreground)] disabled:opacity-50"
                    >
                      {emailBusy ? '…' : 'Отправить код'}
                    </button>
                    <button
                      type="button"
                      onClick={resetEmail}
                      className="press-inset rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] px-3 py-2 font-mono text-[9.5px] font-extrabold uppercase tracking-wide text-[color:var(--color-fg)]"
                    >
                      Отмена
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <input
                    inputMode="numeric"
                    autoFocus
                    data-testid="email-code"
                    value={emailCode}
                    onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="6-значный код"
                    className="w-full rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 py-2 text-center font-mono text-[16px] tracking-[0.3em] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      data-testid="email-confirm"
                      disabled={emailBusy}
                      onClick={onConfirmEmail}
                      className="press-inset flex-1 rounded-[var(--radius-xs)] border-2 border-[color:var(--color-accent)] bg-[color:var(--color-accent)] py-2 font-mono text-[9.5px] font-extrabold uppercase tracking-wide text-[color:var(--color-primary-foreground)] disabled:opacity-50"
                    >
                      {emailBusy ? '…' : 'Подтвердить'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEmailStep('request');
                        setEmailCode('');
                        setEmailMsg(null);
                      }}
                      className="press-inset rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] px-3 py-2 font-mono text-[9.5px] font-extrabold uppercase tracking-wide text-[color:var(--color-fg)]"
                    >
                      Назад
                    </button>
                  </div>
                </>
              )}
              {emailMsg && (
                <p
                  className={
                    'text-[11.5px] ' +
                    (emailMsg.kind === 'ok'
                      ? 'text-[color:var(--color-accent2)]'
                      : 'text-[color:var(--color-destructive)]')
                  }
                >
                  {emailMsg.text}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      {profileMsg && (
        <p
          data-testid="profile-message"
          className={
            'mt-2 text-[12px] ' +
            (profileMsg.kind === 'ok'
              ? 'text-[color:var(--color-accent2)]'
              : 'text-[color:var(--color-destructive)]')
          }
        >
          {profileMsg.text}
        </p>
      )}
    </section>
  );

  const dataCard = (
    <section>
      <SecLabel>Данные</SecLabel>
      <button
        type="button"
        data-testid="export-data"
        onClick={onExport}
        disabled={exporting}
        className="press-inset flex w-full items-center gap-3 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3.5 py-3.5 text-left disabled:opacity-60"
      >
        <Download size={18} className="shrink-0 text-[color:var(--color-accent)]" />
        <span className="flex-1">
          <span className="block text-[14px] font-semibold text-[color:var(--color-fg)]">
            {exporting ? 'Готовим выгрузку…' : 'Скачать мои данные'}
          </span>
          <span className="block font-mono text-[9px] font-bold uppercase tracking-wide text-[color:var(--color-faint)]">
            экспорт в JSON · 152-ФЗ
          </span>
        </span>
        <ChevronRight size={17} className="text-[color:var(--color-faint)]" />
      </button>
      {exportErr && (
        <p className="mt-2 text-[12px] text-[color:var(--color-destructive)]">{exportErr}</p>
      )}
    </section>
  );

  const linkedCard =
    accounts && accounts.length > 0 ? (
      <section>
        <SecLabel>Привязанные аккаунты</SecLabel>
        <div className="overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)]">
          {accounts.map((a, i) => (
            <div
              key={a.id}
              className={
                'flex items-center gap-3 px-3.5 py-3 ' +
                (i > 0 ? 'border-t-2 border-[color:var(--color-line)]' : '')
              }
            >
              <span className="flex-1 text-[14px] font-semibold text-[color:var(--color-fg)]">
                {a.label}
              </span>
              {accounts.length > 1 ? (
                <button
                  type="button"
                  data-testid={`unlink-${a.provider}`}
                  onClick={() => onUnlink(a)}
                  className="press-inset inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] border-2 border-[color:var(--color-destructive)] px-2.5 py-1 font-mono text-[9px] font-extrabold uppercase tracking-wide text-[color:var(--color-destructive)]"
                >
                  <Link2Off size={12} /> Отвязать
                </button>
              ) : (
                <span className="font-mono text-[9px] font-bold uppercase tracking-wide text-[color:var(--color-faint)]">
                  Основной
                </span>
              )}
            </div>
          ))}
        </div>
      </section>
    ) : null;

  const sessionsCard =
    sessions && sessions.length > 0 ? (
      <section>
        <SecLabel>Безопасность · сессии</SecLabel>
        <div className="overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)]">
          {sessions.map((s, i) => {
            const d = deviceLabel(s.userAgent);
            return (
              <div
                key={s.id}
                className={
                  'flex items-center gap-3 px-3.5 py-3 ' +
                  (i > 0 ? 'border-t-2 border-[color:var(--color-line)]' : '')
                }
              >
                <span className="shrink-0 text-[color:var(--color-accent)]">
                  {d.mobile ? <Smartphone size={17} /> : <Monitor size={17} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-[color:var(--color-fg)]">
                    {d.name}
                  </span>
                  <span className="block font-mono text-[9px] font-bold uppercase tracking-wide text-[color:var(--color-faint)]">
                    {s.ip ?? '—'}
                  </span>
                </span>
                {s.current ? (
                  <span className="shrink-0 rounded-[var(--radius-xs)] border-2 border-[color:var(--color-accent2)] px-2 py-0.5 font-mono text-[8.5px] font-extrabold uppercase tracking-wide text-[color:var(--color-accent2)]">
                    Это устройство
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onRevoke(s.id)}
                    className="press-inset shrink-0 rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] px-2.5 py-1 font-mono text-[9px] font-extrabold uppercase tracking-wide text-[color:var(--color-muted-foreground)]"
                  >
                    Выйти
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {sessions.length > 1 && (
          <button
            type="button"
            onClick={onRevokeOthers}
            className="press-inset mt-2 flex w-full items-center justify-center gap-2 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] py-2.5 font-mono text-[10px] font-extrabold uppercase tracking-wide text-[color:var(--color-fg)]"
          >
            <ShieldCheck size={14} /> Выйти на всех устройствах
          </button>
        )}
        {secMsg && (
          <p className="mt-2 text-[12px] text-[color:var(--color-destructive)]">{secMsg}</p>
        )}
      </section>
    ) : null;

  // Phone-binding block — dark-launched behind the phone_binding_enabled flag.
  const phoneCard = initial.phoneBindingEnabled ? (
    <section>
      <SecLabel>Телефон</SecLabel>
      <div className="rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3.5 py-3.5">
        {initial.phoneVerified ? (
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-[color:var(--color-accent2)]">
              <ShieldCheck size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-[color:var(--color-fg)]">
                {initial.phone ?? 'Номер подтверждён'}
              </span>
              <span className="block font-mono text-[9px] font-bold uppercase tracking-wide text-[color:var(--color-faint)]">
                Подтверждён · бонус начислен
              </span>
            </span>
          </div>
        ) : phoneStep === 'idle' ? (
          <div className="space-y-2.5">
            <p className="flex items-center gap-2 text-[13px] text-[color:var(--color-muted-foreground)]">
              <Smartphone size={15} className="shrink-0 text-[color:var(--color-accent)]" />
              Подтвердите номер — начислим <b className="text-[color:var(--color-fg)]">+100</b>{' '}
              бонусных токенов.
            </p>
            <input
              type="tel"
              inputMode="tel"
              data-testid="phone-bind-number"
              placeholder="+7 900 000-00-00"
              value={phoneVal}
              onChange={(e) => setPhoneVal(e.target.value)}
              className="w-full rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 py-2 text-[14px] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
            />
            <button
              type="button"
              data-testid="phone-bind-send"
              disabled={phoneBusy || phoneVal.trim().length < 6}
              onClick={onSendPhoneOtp}
              className="press-inset w-full rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] py-2.5 font-mono text-[10.5px] font-extrabold uppercase tracking-wide text-[color:var(--color-fg)] disabled:opacity-50"
            >
              {phoneBusy ? 'Отправляем…' : 'Прислать код'}
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
              Код отправлен на <b className="text-[color:var(--color-fg)]">{phoneVal}</b>.
            </p>
            <input
              inputMode="numeric"
              data-testid="phone-bind-code"
              placeholder="Код из SMS"
              value={phoneOtp}
              onChange={(e) => setPhoneOtp(e.target.value)}
              className="w-full rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 py-2 text-[14px] tracking-[0.3em] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
            />
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="phone-bind-verify"
                disabled={phoneBusy || phoneOtp.trim().length < 3}
                onClick={onVerifyPhoneOtp}
                className="press-inset flex-1 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-accent)] bg-[color:var(--color-accent)] py-2.5 font-mono text-[10.5px] font-extrabold uppercase tracking-wide text-white disabled:opacity-50"
              >
                {phoneBusy ? 'Проверяем…' : 'Подтвердить'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPhoneStep('idle');
                  setPhoneOtp('');
                  setPhoneErr(null);
                }}
                className="press-inset rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-4 py-2.5 font-mono text-[10.5px] font-extrabold uppercase tracking-wide text-[color:var(--color-fg)]"
              >
                Изменить
              </button>
            </div>
          </div>
        )}
        {phoneErr && (
          <p className="mt-2 text-[12px] text-[color:var(--color-destructive)]">{phoneErr}</p>
        )}
      </div>
    </section>
  ) : null;

  const docsCard = (
    <section>
      <SecLabel>Помощь и документы</SecLabel>
      <div className="flex flex-wrap gap-2">
        {DOC_LINKS.map((l) => (
          <a
            key={l.href}
            href={`${l.href}?lang=${locale}`}
            className="press-inset rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-2.5 py-1.5 font-mono text-[9.5px] font-bold uppercase tracking-wide text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-fg)]"
          >
            {l.label}
          </a>
        ))}
      </div>
    </section>
  );

  const logoutBtn = (
    <form action="/api/logout" method="post">
      <Button type="submit" variant="outline" className="h-12 w-full text-[14px] font-bold">
        <LogOut size={16} /> Выйти
      </Button>
    </form>
  );

  const dangerCard = (
    <section>
      <div className="overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-destructive)] bg-[color:var(--color-surface)] shadow-[4px_4px_0_0_var(--color-destructive)]">
        <h2 className="font-display px-4 pt-3.5 text-[14px] font-black uppercase tracking-tight text-[color:var(--color-destructive)]">
          Опасная зона
        </h2>
        <p className="px-4 pb-3 pt-1.5 text-[11.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          Удаление аккаунта = отзыв согласия на обработку данных и расторжение договора.
          Безвозвратно удаляет персональные данные; история расчётов хранится обезличенно (54-ФЗ).
        </p>
        <div className="px-4 pb-4">
          {!deleteOpen ? (
            <button
              type="button"
              data-testid="delete-open"
              onClick={() => setDeleteOpen(true)}
              className="press-inset w-full rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-destructive)] py-2.5 font-mono text-[10.5px] font-extrabold uppercase tracking-wide text-[color:var(--color-destructive)]"
            >
              Удалить аккаунт
            </button>
          ) : (
            <div className="space-y-3">
              <label
                htmlFor="delete-confirm-email"
                className="block font-mono text-[10px] font-bold uppercase tracking-wide text-[color:var(--color-muted-foreground)]"
              >
                Введи email для подтверждения:{' '}
                <b className="text-[color:var(--color-fg)]">{initial.email}</b>
              </label>
              <input
                id="delete-confirm-email"
                data-testid="delete-confirm-email"
                type="email"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                className="w-full rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 py-2 text-[14px] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-destructive)]"
              />
              {deleteErr && (
                <p
                  className="text-[12px] text-[color:var(--color-destructive)]"
                  data-testid="delete-error"
                >
                  {deleteErr}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="delete-confirm"
                  disabled={deleting || deleteConfirm.trim().length === 0}
                  onClick={onDelete}
                  className="press-inset flex-1 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-destructive)] bg-[color:var(--color-destructive)] py-2.5 font-mono text-[10.5px] font-extrabold uppercase tracking-wide text-white disabled:opacity-50"
                >
                  {deleting ? 'Удаляем…' : 'Подтвердить'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDeleteOpen(false);
                    setDeleteConfirm('');
                    setDeleteErr(null);
                  }}
                  className="press-inset rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] px-4 py-2.5 font-mono text-[10.5px] font-extrabold uppercase tracking-wide text-[color:var(--color-fg)]"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );

  const versionLine = (
    <p className="text-center font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-[color:var(--color-faint)]">
      Vertov · {initial.version}
    </p>
  );

  // ONE DOM tree, responsive via CSS (no duplicate ids/testids): a full-page
  // fixed overlay above the mobile tab bar (own back header) collapses to a
  // normal in-flow, two-column page inside AppShell from md up.
  return (
    <div
      data-testid="settings-page"
      className="fixed inset-0 z-40 overflow-y-auto bg-[color:var(--color-bg)] md:static md:z-auto md:overflow-visible md:bg-transparent"
    >
      {/* Mobile-only back header (the full-page chrome). */}
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 py-2.5 md:hidden">
        <button
          type="button"
          aria-label="Назад"
          onClick={() => router.back()}
          className="press-inset grid h-8 w-8 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] text-[color:var(--color-fg)]"
        >
          <ChevronLeft size={16} />
        </button>
        <h1 className="font-display text-[16px] font-black tracking-tight text-[color:var(--color-fg)]">
          Профиль
        </h1>
      </header>

      <div className="mx-auto w-full max-w-5xl px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-4 md:px-6 md:py-10 md:pb-10">
        {/* Desktop-only page heading. */}
        <div className="hidden md:block">
          <h1 className="font-display text-[26px] font-black tracking-tight text-[color:var(--color-fg)]">
            Настройки
          </h1>
          <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
            Профиль, тариф, данные и безопасность аккаунта.
          </p>
        </div>

        <div className="md:mt-6">{accountHeader}</div>

        <div className="mt-4 space-y-4 md:mt-6 md:grid md:grid-cols-2 md:items-start md:gap-5 md:space-y-0">
          {balanceCard}
          {accountCard}
          {phoneCard}
          {linkedCard}
          {sessionsCard}
          {dataCard}
          {docsCard}
          {logoutBtn}
          {dangerCard}
        </div>

        <div className="mt-5">{versionLine}</div>
      </div>
    </div>
  );
}

function SecLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 px-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-faint)]">
      {children}
    </p>
  );
}
