'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Activity,
  Archive,
  ChevronDown,
  ChevronUp,
  Settings,
  Volume2,
  VolumeX,
} from '@/components/ui/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TokenStar } from '@/components/ui/token-star';
import { PixelGlyph } from '@/components/ui/pixel-glyph';
import { useBalance } from './BalanceWidget';
import { useJobsTray, JobsTrayPanel } from './JobsTray';
import { isSoundMuted, toggleSoundMuted, onSoundMuteChange } from '@/lib/sound';

export interface ProfilePlan {
  tier: string;
  title: string | null;
}

function initials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const letters = local.replace(/[^a-zA-Zа-яА-Я]/g, '');
  return (letters.slice(0, 1) || email.slice(0, 1) || '?').toUpperCase();
}

const cellBase =
  'flex h-10 items-center gap-2 px-4 font-mono text-[12px] font-bold uppercase tracking-wide transition-colors';
const rowBase =
  'flex w-full items-center gap-3 border-t-[1.5px] border-[color:var(--color-line)]/16 px-4 py-2.5 text-left text-[13.5px] font-medium text-[color:var(--color-fg)] transition-colors hover:bg-[color:var(--color-surface2)]';

/**
 * The header's account segment — last cell of the fused action bar (2026-07-07
 * header redesign). Replaces the old JobsTray icon + LanguageToggle +
 * SoundToggle + ProfileButton + email link + logout button cluster with ONE
 * dropdown: plan/credits + top-up, generations-in-progress, settings, sound,
 * archive, presets, logout. Language is deliberately NOT here — it lives only
 * in /settings (owner decision 2026-07-07).
 *
 * The trigger cell fills solid accent while open, mirroring NavLinks' active-
 * tab treatment — "this segment is expanded" reads the same way "you are
 * here" does on the left.
 */
export function ProfileMenu({
  email,
  balance,
  apiUrl,
  plan,
  isAnonymous = false,
}: {
  email: string;
  balance: number;
  apiUrl: string;
  plan: ProfilePlan | null;
  /** Pre-paywall anonymous browsing (2026-07-07 follow-up): a "Гость" session
   * never signed up for a real account — showing it the full account menu
   * (settings/billing/logout under a fake initial) reads as "you're logged
   * in" when you're not. Render a plain sign-in CTA instead, same cell shape. */
  isAnonymous?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const liveBalance = useBalance(balance, apiUrl);
  const { jobs, activeCount } = useJobsTray(apiUrl);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setMuted(isSoundMuted());
    return onSoundMuteChange(setMuted);
  }, []);

  const close = () => setOpen(false);

  if (isAnonymous) {
    return (
      <Link
        href="/login"
        data-testid="profile-menu-trigger"
        className={
          cellBase +
          ' -ml-[2.5px] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)] hover:brightness-110'
        }
      >
        Войти
      </Link>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="profile-menu-trigger"
          aria-label="Аккаунт"
          aria-expanded={open}
          className={
            cellBase +
            ' -ml-[2.5px] border-[2.5px] border-[color:var(--color-line)] ' +
            (open
              ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
              : 'bg-[color:var(--color-bg)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
          }
        >
          <span
            className={
              'grid h-6 w-6 shrink-0 place-items-center font-display text-[11px] font-black ' +
              (open
                ? 'bg-[color:var(--color-surface)] text-[color:var(--color-fg)]'
                : 'bg-[color:var(--color-primary-foreground)] text-[color:var(--color-fg)]')
            }
          >
            {activeCount > 0 ? (
              <PixelGlyph
                name="create"
                size={16}
                className="seed-pulse-dot"
                aria-label="Идёт генерация"
              />
            ) : (
              initials(email)
            )}
          </span>
          {open ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
        </button>
      </PopoverTrigger>

      <PopoverContent
        data-testid="profile-menu-panel"
        align="end"
        className="w-[300px] overflow-hidden p-0"
      >
        <div className="flex items-center gap-3 border-b-[2.5px] border-[color:var(--color-line)] px-4 py-3.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center bg-[color:var(--color-accent)] font-display text-[13px] font-black text-[color:var(--color-primary-foreground)]">
            {initials(email)}
          </span>
          <span
            data-testid="profile-menu-email"
            className="truncate font-mono text-[12px] text-[color:var(--color-muted-foreground)]"
          >
            {email}
          </span>
        </div>

        <div className="m-3.5 border-[2.5px] border-[color:var(--color-line)]/16 bg-[color:var(--color-surface2)] p-3">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-accent)]">
            {plan?.title ?? plan?.tier ?? 'Free'}
          </p>
          <p className="font-display mt-1 flex items-center gap-1.5 text-[20px] font-black leading-none text-[color:var(--color-fg)]">
            <TokenStar size={15} className="text-[color:var(--color-accent)]" />
            {liveBalance.toLocaleString('ru-RU')}
          </p>
          <div className="mt-2.5 flex">
            <Link
              href="/pricing"
              onClick={close}
              className="flex h-8 flex-1 items-center justify-center border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] font-mono text-[11px] font-bold uppercase text-[color:var(--color-primary-foreground)]"
            >
              Апгрейд
            </Link>
            <Link
              href="/pricing"
              onClick={close}
              className="flex h-8 flex-1 items-center justify-center border-2 border-l-0 border-[color:var(--color-line)] font-mono text-[11px] font-bold uppercase text-[color:var(--color-fg)]"
            >
              Пополнить
            </Link>
          </div>
        </div>

        <div
          className={rowBase.replace(
            'border-t-[1.5px] border-[color:var(--color-line)]/16',
            'border-t-0',
          )}
        >
          <Activity size={15} className="shrink-0 text-[color:var(--color-faint)]" aria-hidden />
          <span className="flex-1">Генерации в работе</span>
          {activeCount > 0 && (
            <span
              className="seed-pulse-dot h-2 w-2 shrink-0 bg-[color:var(--color-accent)]"
              aria-hidden
            />
          )}
        </div>
        {(jobs.length > 0 || activeCount > 0) && (
          <div className="border-t-[1.5px] border-[color:var(--color-line)]/16">
            <JobsTrayPanel jobs={jobs.slice(0, 4)} onNavigate={close} />
          </div>
        )}

        <Link href="/settings" onClick={close} className={rowBase}>
          <Settings size={15} className="shrink-0 text-[color:var(--color-faint)]" aria-hidden />
          Настройки аккаунта
        </Link>

        <button type="button" onClick={() => setMuted(toggleSoundMuted())} className={rowBase}>
          {muted ? (
            <VolumeX size={15} className="shrink-0 text-[color:var(--color-faint)]" aria-hidden />
          ) : (
            <Volume2 size={15} className="shrink-0 text-[color:var(--color-faint)]" aria-hidden />
          )}
          <span className="flex-1">Звук</span>
          <span className="font-mono text-[10.5px] text-[color:var(--color-faint)]">
            {muted ? 'Выкл' : 'Вкл'}
          </span>
        </button>

        <Link href="/gallery" onClick={close} className={rowBase}>
          <Archive size={15} className="shrink-0 text-[color:var(--color-faint)]" aria-hidden />
          Архив
        </Link>
        <form
          action="/api/logout"
          method="post"
          className="border-t-[2.5px] border-[color:var(--color-line)]"
        >
          <button
            type="submit"
            className="w-full px-4 py-2.5 text-left text-[13.5px] font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            Выйти
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
