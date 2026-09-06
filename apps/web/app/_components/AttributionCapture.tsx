'use client';

import { useEffect } from 'react';
import { captureAttribution, sendAttribution } from './PlausibleEvents';

export function AttributionCapture({ apiUrl }: { apiUrl: string }) {
  useEffect(() => {
    // First-touch: persist UTM to localStorage on any page load.
    captureAttribution();
    // Then, if the session belongs to a real account, try to POST it once.
    // Anonymous Better Auth sessions are deliberately skipped; the client
    // retains the payload until the eventual signup. The server is idempotent
    // (ON CONFLICT DO NOTHING), and the client clears localStorage after a 2xx.
    void sendAttribution(apiUrl);
  }, [apiUrl]);
  return null;
}
