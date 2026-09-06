'use client';

import Link from 'next/link';
import { User } from '@/components/ui/icons';

/**
 * Mobile profile/account affordance — a brutalist avatar chip in the header
 * (md:hidden) that goes straight to /settings, which is the account hub on
 * phones (profile · language · help · legal/about · logout). Replaces the old
 * burger «more» sheet: on mobile the only secondary surface is the account
 * screen, reached from here. Shows the user's initials, falling back to a
 * person glyph.
 */
function initials(email?: string): string | null {
  if (!email) return null;
  const local = email.split('@')[0] ?? '';
  const letters = local.replace(/[^a-zA-Zа-яА-Я]/g, '');
  if (!letters) return null;
  return letters.slice(0, 2).toUpperCase();
}

export function ProfileButton({ email }: { email?: string }) {
  const ini = initials(email);
  return (
    <Link
      href="/settings"
      aria-label="Аккаунт"
      title="Аккаунт"
      data-testid="profile-button"
      className="press grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] font-display text-[12px] font-black text-[color:var(--color-accent)] shadow-[3px_3px_0_0_var(--color-shadow)] md:hidden"
    >
      {ini ?? <User size={16} className="text-[color:var(--color-accent)]" aria-hidden />}
    </Link>
  );
}
