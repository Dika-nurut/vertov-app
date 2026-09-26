'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const VK_APP_ID = Number(process.env.NEXT_PUBLIC_VK_APP_ID ?? 0);
const SDK_SRC = 'https://unpkg.com/@vkid/sdk@<3.0.0/dist-sdk/umd/index.js';

// The VK ID SDK is a global UMD bundle with no types.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    VKIDSDK?: any;
  }
}

function loadSdk(): Promise<any> {
  return new Promise((resolve, reject) => {
    if (window.VKIDSDK) return resolve(window.VKIDSDK);
    let s = document.getElementById('vkid-sdk') as HTMLScriptElement | null;
    if (!s) {
      s = document.createElement('script');
      s.id = 'vkid-sdk';
      s.src = SDK_SRC;
      s.async = true;
      document.head.appendChild(s);
    }
    s.addEventListener('load', () =>
      window.VKIDSDK ? resolve(window.VKIDSDK) : reject(new Error('VKIDSDK missing')),
    );
    s.addEventListener('error', () => reject(new Error('VKIDSDK failed to load')));
  });
}

/**
 * VK ID OneTap — the OFFICIAL VK widget (VK's rules require it). VK only —
 * Odnoklassniki / Mail.ru are intentionally not offered. Styled to the canon:
 * borderRadius 4 (radius-md max), dark scheme. On success the SDK
 * exchanges the code; the browser POSTs the VK token to our bridge
 * (`/api/auth/vkid/bridge`), which verifies it server-side and mints the session.
 *
 * When the SDK script is blocked the widget leaves nothing keyboard-reachable
 * behind, so `onFallback` (the plain OAuth redirect in the login page)
 * renders as a real button instead. The container is a labelled region,
 * not a bare clickable div.
 */
export function VkIdWidget({
  onSuccess,
  onError,
  onStart,
  onFallback,
}: {
  onSuccess: () => void;
  onError: (msg: string) => void;
  onStart?: () => void;
  onFallback: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rendered = useRef(false);
  const [sdkFailed, setSdkFailed] = useState(false);

  useEffect(() => {
    if (!VK_APP_ID || rendered.current) return;
    let cancelled = false;
    rendered.current = true;

    loadSdk()
      .then((VKID) => {
        if (cancelled || !ref.current) return;
        VKID.Config.init({
          app: VK_APP_ID,
          redirectUrl: `${window.location.origin}/api/auth/callback/vk`,
          responseMode: VKID.ConfigResponseMode.Callback,
          source: VKID.ConfigSource.LOWCODE,
          scope: 'email',
        });
        const width = ref.current.clientWidth || 320;
        const oneTap = new VKID.OneTap();
        oneTap
          .render({
            container: ref.current,
            scheme: 'dark',
            // VK only — Odnoklassniki / Mail.ru intentionally NOT offered.
            // height matched to the Yandex 'm' button (~44px) so the two line up.
            styles: { borderRadius: 4, width, height: 44 },
          })
          .on(VKID.WidgetEvents.ERROR, () => onError('Ошибка VK ID'))
          .on(VKID.OneTapInternalEvents.LOGIN_SUCCESS, async (payload: any) => {
            try {
              const data = await VKID.Auth.exchangeCode(payload.code, payload.device_id);
              const accessToken = data?.access_token;
              if (!accessToken) throw new Error('no token');
              const r = await fetch(`${API_URL}/api/auth/vkid/bridge`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ accessToken }),
              });
              if (!r.ok) throw new Error(`bridge ${r.status}`);
              onSuccess();
            } catch {
              onError('Не удалось войти через VK');
            }
          });
      })
      .catch(() => {
        if (!cancelled) setSdkFailed(true);
        onError('Не удалось загрузить VK ID');
      });

    return () => {
      cancelled = true;
    };
  }, [onSuccess, onError]);

  if (!VK_APP_ID) return null;
  return (
    <section aria-label="Вход через VK" className="w-full">
      {/*
        The VK SDK sizes its button from a JS-measured integer (clientWidth),
        while the Yandex iframe fills via CSS width:100%. On a fractional-width
        container they round differently → a few-px width mismatch. Force the
        whole VK subtree to width:100% (border-box) so it fills the container
        EXACTLY like Yandex. The VkIdWebSdk__button class suffix is random per
        render, so match on the stable prefix; !important beats the SDK's inline
        width.
      */}
      <style>{`
        [data-testid='vkid-widget'] > div,
        [data-testid='vkid-widget'] > div > div { width: 100% !important; }
        [data-testid='vkid-widget'] button[class*='VkIdWebSdk__button'] {
          width: 100% !important;
          box-sizing: border-box !important;
        }
      `}</style>
      <div ref={ref} data-testid="vkid-widget" className="w-full" onClick={onStart} />
      {sdkFailed && (
        <button
          type="button"
          onClick={() => {
            onStart?.();
            onFallback();
          }}
          data-testid="vk-oauth-fallback"
          className="press mt-2 flex h-11 w-full items-center justify-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-card px-4 text-[13px] font-medium shadow-[3px_3px_0_0_var(--color-shadow)] transition-transform hover:-translate-y-px"
        >
          Войти через VK
        </button>
      )}
    </section>
  );
}
