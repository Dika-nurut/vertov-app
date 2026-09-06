'use client';

import { useEffect, useMemo, useState } from 'react';
import { OnboardingCard } from './OnboardingCard';
import { trackEvent, PlausibleEvent } from './PlausibleEvents';
import type { Locale } from '@/lib/locale';

interface OnboardingWrapperProps {
  /** True only when the server returned a definitive onboardedAt === null. */
  showOnboarding: boolean;
  apiUrl: string;
  locale: Locale;
  userKey: string;
}

export function OnboardingWrapper({
  showOnboarding,
  apiUrl,
  locale,
  userKey,
}: OnboardingWrapperProps) {
  const [dismissed, setDismissed] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const skipKey = useMemo(
    () => 'seed:onboarding-skipped:' + encodeURIComponent(userKey),
    [userKey],
  );

  // Skip is deliberately session-only. The account flag remains null, so a new
  // browser session can offer onboarding again without silently changing server truth.
  useEffect(() => {
    setStorageReady(false);
    if (!showOnboarding) {
      setStorageReady(true);
      return;
    }
    try {
      setDismissed(window.sessionStorage.getItem(skipKey) === '1');
    } catch {
      setDismissed(false);
    }
    setStorageReady(true);
  }, [showOnboarding, skipKey]);

  useEffect(() => {
    if (!showOnboarding || !storageReady || dismissed) return;
    const key = 'seed:signup-tracked';
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, '1');
    } catch {
      // Analytics is optional when storage is unavailable.
    }
    trackEvent(PlausibleEvent.signupCompleted);
  }, [dismissed, showOnboarding, storageReady]);

  if (!showOnboarding || !storageReady || dismissed) return null;

  return (
    <OnboardingCard
      apiUrl={apiUrl}
      locale={locale}
      onDone={() => setDismissed(true)}
      onSkip={() => {
        try {
          window.sessionStorage.setItem(skipKey, '1');
        } catch {
          // The in-memory dismissal still applies for this mounted session.
        }
        setDismissed(true);
      }}
    />
  );
}
