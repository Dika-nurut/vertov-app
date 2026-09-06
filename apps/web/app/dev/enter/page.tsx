'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Dev-only interstitial reached after the god-mode magic-link verify. Tops up a
 * fat credit balance + skips onboarding, then drops the tester in /generate.
 * Stripped from production bundles; the endpoint it calls is dev-gated too.
 */
export default function DevEnterPage() {
  const [msg, setMsg] = useState('Входим в god-режим…');

  useEffect(() => {
    (async () => {
      try {
        // Self-sufficient one-click entry: mint an anonymous session if there
        // isn't one, so visiting /dev/enter from a fresh browser just works.
        let me = await fetch(`${API_URL}/v1/me`, { credentials: 'include' });
        if (me.status === 401) {
          setMsg('Создаём сессию…');
          const signin = await fetch(`${API_URL}/api/auth/sign-in/anonymous`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          if (!signin.ok) throw new Error(`signin HTTP ${signin.status}`);
          // Re-materialize users_app/users_pii rows (godmode's grant FK needs them).
          me = await fetch(`${API_URL}/v1/me`, { credentials: 'include' });
        }
        if (!me.ok) throw new Error(`me HTTP ${me.status}`);
        setMsg('Включаем god-режим…');
        const res = await fetch(`${API_URL}/v1/dev/godmode`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        window.location.replace('/generate');
      } catch (err) {
        setMsg(
          'Не удалось войти в god-режим: ' +
            (err instanceof Error ? err.message : 'ошибка') +
            '. Вернитесь на /login.',
        );
      }
    })();
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <p className="text-sm text-[color:var(--color-muted-foreground)]">{msg}</p>
    </main>
  );
}
