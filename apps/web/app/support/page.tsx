import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '@/components/ui/wordmark';
import { Suspense } from 'react';
import { LanguageToggle } from '../_components/LanguageToggle';
import { LandingFooter } from '../_components/landing/LandingFooter';
import { apiBaseUrl, apiGet } from '../../lib/server-api';
import { SupportForm } from './SupportForm';

export const metadata: Metadata = {
  title: 'Поддержка — Vertov',
  description:
    'Поддержка Vertov: общие вопросы, возвраты, технические сбои, персональные данные и юридические обращения.',
  alternates: { canonical: '/support' },
};
export const dynamic = 'force-dynamic';

interface MeResponse {
  user: { email: string; isAnonymous?: boolean };
}

export default async function SupportPage() {
  const me = await apiGet<MeResponse>('/v1/me');
  const initialEmail = me.data?.user.isAnonymous ? '' : (me.data?.user.email ?? '');

  return (
    <div className="min-h-screen">
      <header className="bg-transparent">
        <nav className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
          <Link href="/" className="press inline-flex items-center">
            <Wordmark size={28} />
          </Link>
          <Suspense>
            <LanguageToggle />
          </Suspense>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* Macro panel grammar (bible §3): surface + bone 2.5px + 6px periwinkle
            offset — the editorial content reads as one slab, like pricing plates. */}
        <div
          className="brutal-card px-6 py-7 sm:px-8"
          style={{ boxShadow: '6px 6px 0 0 var(--color-shadow)' }}
        >
          <h1 className="text-h1 text-[color:var(--color-fg)]">Поддержка</h1>
          <p className="mt-4 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Опишите вопрос в форме ниже. Обращение попадёт в очередь поддержки, а ответ придёт на
            указанный email.
          </p>

          <SupportForm apiUrl={apiBaseUrl()} initialEmail={initialEmail} />

          <h2 className="mt-8 text-h2 text-[color:var(--color-fg)]">Что приложить</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Для оплаты и возврата откройте «Настройки → Биллинг → История платежей» и скопируйте
            номер из строки нужной покупки. Если покупок несколько, сверяйте дату и сумму. Для
            технической проблемы добавьте шаги, которые привели к ошибке. Данные карты и CVC не
            нужны.
          </p>

          <h2 className="mt-8 text-h2 text-[color:var(--color-fg)]">Срок ответа</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Ответим в течение 5 рабочих дней. Если вопрос связан с возвратом, сначала проверим
            статус операции в платёжной системе.
          </p>

          <h2 className="mt-8 text-h2 text-[color:var(--color-fg)]">Полезные ссылки</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            <li>
              <Link href="/faq" className="underline">
                Частые вопросы
              </Link>
            </li>
            <li>
              <Link href="/legal/requisites" className="underline">
                Реквизиты и контакты
              </Link>
            </li>
            <li>
              <Link href="/legal/refund" className="underline">
                Политика возврата
              </Link>
            </li>
            <li>
              <Link href="/legal/offer" className="underline">
                Публичная оферта
              </Link>
            </li>
          </ul>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
