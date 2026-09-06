import './globals.css';
import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { Haptics } from './_components/Haptics';
import { AppStarfield } from './_components/AppStarfield';
import { AttributionCapture } from './_components/AttributionCapture';
import { ConsentFlush } from '@/components/consent-flush';
import { ProjectContextProvider } from './_components/ProjectContextProvider';
import { MobileRouteGate } from './_components/MobileRouteGate';
import { apiBaseUrl } from '@/lib/server-api';

// Dark neo-brutalism ("Slate Brutal"). Three self-hosted OFL faces, each with full
// Cyrillic (incl. Ukrainian Ї/Ґ/Є), so this RU-first product renders RU + EN
// identically. Vendored as bundler-safe woff2 in app/_fonts/ (see design-arsenal).
//   • Unbounded    — display voice: black headlines / wordmark.
//   • Onest        — UI + body voice: every paragraph, label, control (variable).
//   • Martian Mono — technical voice: IDs / timecodes / eyebrows (variable).
// Montserrat + JetBrains Mono retired (kept only as system fallbacks in globals.css).
// PERF (P6): only the BLACK weight ships. The brutalist headings render at 800/900
// and Unbounded has no 800 file, so 800 already maps to Black(900) — Regular /
// Medium / Bold (~394 KB) were preloaded but NEVER rendered. The weight range
// '700 900' routes every heavy display weight to this one file (no nearest-match
// guesswork), so the look is byte-identical while the font payload drops ~75%.
const displayFace = localFont({
  src: [{ path: './_fonts/Unbounded-Black.woff2', weight: '700 900', style: 'normal' }],
  variable: '--font-display-face',
  display: 'swap',
});

const uiFace = localFont({
  src: './_fonts/Onest-var.woff2',
  weight: '100 900',
  variable: '--font-ui-face',
  display: 'swap',
});

const monoFace = localFont({
  src: './_fonts/MartianMono-var.woff2',
  weight: '100 800',
  variable: '--font-mono-face',
  display: 'swap',
});

// Plausible domain — use real domain when DNS is ready; vertov.space is the
// dev placeholder so the script tag is always present in markup.
const plausibleDomain = process.env.PLAUSIBLE_DOMAIN ?? 'vertov.space';

const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? 'https://vertov.space';
const description =
  'Опиши кадр словами — получишь изображение, видео и готовый монтаж в одной студии.';

export const metadata: Metadata = {
  metadataBase: new URL(webUrl),
  title: { default: 'Vertov', template: '%s · Vertov' },
  description,
  applicationName: 'Vertov',
  // app/icon.png + app/apple-icon.png are picked up automatically by Next.
  openGraph: {
    type: 'website',
    siteName: 'Vertov',
    title: 'Vertov',
    description,
    url: webUrl,
    locale: 'ru_RU',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Vertov',
    description,
  },
};

// Without this, Next App Router emits NO <meta name="viewport">, so phones render
// the whole app at ~980px (zoomed-out) and defeat every responsive style below.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${displayFace.variable} ${uiFace.variable} ${monoFace.variable}`}>
      <head>
        {/* PWA manifest — enables Add to Home Screen on iOS Safari + Android Chrome */}
        <link rel="manifest" href="/manifest.webmanifest" />
        {/* Match the graphite canvas (--color-background) so the iOS/Android
            status-bar + PWA chrome never flash a different tint. */}
        <meta name="theme-color" content="#111317" />
        {/* Plausible analytics — proxied through /plausible/* to survive AdBlock.
            data-api MUST point at the proxied event path; without it the script
            defaults to POST /api/event on our own origin, which 404s on every
            pageview (we have no /api/event route — only the /plausible/event rewrite). */}
        {/* eslint-disable-next-line @next/next/no-before-interactive-script-outside-document */}
        <script
          async
          defer
          data-domain={plausibleDomain}
          data-api="/plausible/event"
          src="/plausible/script.js"
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        {/* Mounted once, here — NOT per-page — so client-side navigation across
            the app never repaints or reshuffles the sky (2026-07-07 follow-up:
            "it should persist until he logs in"). */}
        <AppStarfield />
        <Haptics />
        <ConsentFlush />
        <AttributionCapture apiUrl={apiBaseUrl()} />
        <ProjectContextProvider apiUrl={apiBaseUrl()}>
          <MobileRouteGate>{children}</MobileRouteGate>
        </ProjectContextProvider>
      </body>
    </html>
  );
}
