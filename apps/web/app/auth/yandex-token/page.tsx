'use client';

import { useEffect } from 'react';

/**
 * Yandex ID SUGGEST token page.
 *
 * `YaAuthSuggest` (response_type=token) redirects here with the access token in
 * the URL fragment; Yandex's token SDK reads it and postMessages it back to the
 * opener (our login page). This is the helper page Yandex requires — its URL must
 * be in the app's Redirect URI list. Renders nothing visible.
 */
export default function YandexTokenPage() {
  useEffect(() => {
    const s = document.createElement('script');
    s.src =
      'https://yastatic.net/s3/passport-sdk/autofill/v1/sdk-suggest-token-with-polyfills-latest.js';
    s.async = true;
    s.onload = () => {
      const send = (window as unknown as { YaSendSuggestToken?: (origin: string) => void })
        .YaSendSuggestToken;
      if (send) send(window.location.origin);
    };
    document.head.appendChild(s);
  }, []);
  return null;
}
