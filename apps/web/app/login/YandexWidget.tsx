'use client';

import { useEffect, useRef } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const YANDEX_CLIENT_ID = process.env.NEXT_PUBLIC_YANDEX_CLIENT_ID ?? '';
const SDK_SRC =
  'https://yastatic.net/s3/passport-sdk/autofill/v1/sdk-suggest-with-polyfills-latest.js';
const CONTAINER_ID = 'yandex-suggest-button';

// Yandex SUGGEST SDK is a global UMD bundle with no types.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    YaAuthSuggest?: any;
  }
}

function loadSdk(): Promise<any> {
  return new Promise((resolve, reject) => {
    if (window.YaAuthSuggest) return resolve(window.YaAuthSuggest);
    let s = document.getElementById('ya-suggest-sdk') as HTMLScriptElement | null;
    if (!s) {
      s = document.createElement('script');
      s.id = 'ya-suggest-sdk';
      s.src = SDK_SRC;
      s.async = true;
      document.head.appendChild(s);
    }
    s.addEventListener('load', () =>
      window.YaAuthSuggest
        ? resolve(window.YaAuthSuggest)
        : reject(new Error('YaAuthSuggest missing')),
    );
    s.addEventListener('error', () => reject(new Error('YaAuthSuggest failed to load')));
  });
}

/**
 * Official Yandex ID button (the `YaAuthSuggest` SDK widget — what Yandex's
 * constructor gives). `response_type=token`: it redirects through our token page
 * (/auth/yandex-token), hands back the access token client-side, and we POST it
 * to /api/auth/yandex/bridge which verifies it server-side and mints the session.
 * Styled to match the VK widget: borderRadius 12, button size m, light theme.
 */
export function YandexWidget({
  onSuccess,
  onError,
  onStart,
}: {
  onSuccess: () => void;
  onError: (msg: string) => void;
  onStart?: () => void;
}) {
  const rendered = useRef(false);
  useEffect(() => {
    if (!YANDEX_CLIENT_ID || rendered.current) return;
    let cancelled = false;
    rendered.current = true;

    loadSdk()
      .then((YaAuthSuggest) => {
        if (cancelled) return;
        return YaAuthSuggest.init(
          {
            client_id: YANDEX_CLIENT_ID,
            response_type: 'token',
            redirect_uri: `${window.location.origin}/auth/yandex-token`,
          },
          window.location.origin,
          {
            view: 'button',
            parentId: CONTAINER_ID,
            buttonSize: 'm',
            buttonView: 'main',
            buttonTheme: 'light',
            buttonBorderRadius: '12',
            buttonIcon: 'ya',
          },
        )
          .then(({ handler }: any) => handler())
          .then(async (data: any) => {
            const accessToken = data?.access_token;
            if (!accessToken) throw new Error('no token');
            const r = await fetch(`${API_URL}/api/auth/yandex/bridge`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ accessToken }),
            });
            if (!r.ok) throw new Error(`bridge ${r.status}`);
            onSuccess();
          });
      })
      .catch(() => onError('Не удалось войти через Яндекс'));

    return () => {
      cancelled = true;
    };
  }, [onSuccess, onError]);

  if (!YANDEX_CLIENT_ID) return null;
  return <div id={CONTAINER_ID} className="w-full" onClick={onStart} />;
}
