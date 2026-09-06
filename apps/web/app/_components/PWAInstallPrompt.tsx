'use client';

import { useEffect, useState } from 'react';
import { X } from '@/components/ui/icons';

// BeforeInstallPromptEvent is non-standard — declare it locally.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  // Safari on iOS does NOT have "Chrome" or "CriOS" in the UA
  const isSafari = isIos && !/CriOS|FxiOS|OPiOS|mercury/i.test(ua);
  return isSafari;
}

function isInStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari specific
    ('standalone' in window.navigator &&
      (window.navigator as { standalone?: boolean }).standalone === true)
  );
}

const DISMISSED_KEY = 'seed:pwa-prompt-dismissed';

export function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Never show once the user has dismissed or the app is already installed.
    if (isInStandaloneMode() || localStorage.getItem(DISMISSED_KEY) === '1') {
      setDismissed(true);
      return;
    }

    if (isIosSafari()) {
      setShowIosHint(true);
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, '1');
    setDeferredPrompt(null);
    setShowIosHint(false);
    setDismissed(true);
  }

  async function install() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') dismiss();
    else setDeferredPrompt(null);
  }

  if (dismissed || (!deferredPrompt && !showIosHint)) return null;

  return (
    <div
      data-testid="pwa-install-prompt"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] px-5 py-3 text-sm shadow-[var(--offset)]"
    >
      {showIosHint ? (
        <span>
          Добавь на главный экран: нажми <strong>Поделиться → На экран «Домой»</strong>
        </span>
      ) : (
        <span>Установи Vertov как приложение</span>
      )}
      {!showIosHint && deferredPrompt && (
        <button
          type="button"
          onClick={() => void install()}
          className="btn btn-primary text-[13px]"
        >
          Установить Vertov
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        className="btn btn-ghost ml-1 text-[13px]"
        aria-label="Закрыть"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
