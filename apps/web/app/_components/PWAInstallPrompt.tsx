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
const PROMPT_DELAY_MS = 30_000;

export function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [promptReady, setPromptReady] = useState(false);

  useEffect(() => {
    // Delay the prompt so it cannot compete with the first useful action, and
    // never show it for an installed or previously dismissed app.
    let stopped = false;
    const timer = window.setTimeout(() => {
      if (!stopped) setPromptReady(true);
    }, PROMPT_DELAY_MS);
    try {
      if (isInStandaloneMode() || localStorage.getItem(DISMISSED_KEY) === '1') {
        setDismissed(true);
        window.clearTimeout(timer);
        return () => {
          stopped = true;
          window.clearTimeout(timer);
        };
      }
    } catch {
      // A blocked storage API must not prevent the native install prompt.
    }

    if (isIosSafari()) {
      setShowIosHint(true);
      return () => {
        stopped = true;
        window.clearTimeout(timer);
      };
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener('beforeinstallprompt', handler);
    };
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // In-memory dismissal still applies for this mounted session.
    }
    setDeferredPrompt(null);
    setShowIosHint(false);
    setDismissed(true);
  }

  async function install() {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted' || outcome === 'dismissed') dismiss();
    } catch {
      setDeferredPrompt(null);
    }
  }

  if (!promptReady || dismissed || (!deferredPrompt && !showIosHint)) return null;

  return (
    <div
      data-testid="pwa-install-prompt"
      className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] px-5 py-3 text-sm shadow-[var(--offset)] md:bottom-4"
    >
      {showIosHint ? (
        <span>
          Добавьте на главный экран: нажмите <strong>Поделиться → На экран «Домой»</strong>
        </span>
      ) : (
        <span>Установите Vertov как приложение</span>
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
