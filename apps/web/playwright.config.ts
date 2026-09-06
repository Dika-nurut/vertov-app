import { defineConfig, devices } from '@playwright/test';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

// Shared god storageState produced by the `setup` project (auth.setup.ts). The
// studio floor reuses it so it never pays a per-test magic-link round-trip.
const STUDIO_STORAGE_STATE = resolve(__dirname, 'e2e/.auth/studio.json');
// The studio floor runs as its OWN project (storageState'd). Keep it out of the
// generic chromium/yandex projects so it isn't double-run with the wrong fixtures.
const STUDIO_FLOOR = /studio-editor\.spec\.ts/;
const SETUP_FILE = /auth\.setup\.ts/;

// Load repo-root .env so WEB_PUBLIC_URL / NEXT_PUBLIC_API_URL match the
// running services (web + api are bound to the same host so cookies cross
// ports). Without this, Playwright would silently fall back to localhost
// and BetterAuth would reject the callback as an untrusted origin.
loadDotenv({ path: resolve(__dirname, '../../.env') });

const baseURL = process.env.WEB_PUBLIC_URL;
if (!baseURL) {
  throw new Error('WEB_PUBLIC_URL must be set (loaded from repo-root .env).');
}

// Yandex Browser 26.x stable UA — taken from whatismybrowser.com, verified
// against the "Yandex Browser 26.1" release listed at browser.yandex.com.
// UA source: https://www.whatismybrowser.com/guides/the-latest-user-agent/yandex-browser
// Format: YaBrowser/<version>.<build> Yowser/<compat-ver> <platform tokens>
const YANDEX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 YaBrowser/26.1.4.963 Yowser/2.5 Safari/537.36';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  retries: 0,
  // Magic-link capture WAS a shared last-writer-wins slot on the API; it is now
  // keyed by email (packages/auth getDevLastMagicLink(email) + ?email lookup),
  // so parallel workers no longer clobber each other's link. Kept at workers:1
  // until the running API is redeployed with that change; then raise workers and
  // flip fullyParallel to parallelize (the per-worker isolation is in place).
  workers: 1,
  fullyParallel: false,
  projects: [
    {
      name: 'setup',
      testMatch: SETUP_FILE,
      use: { ...devices['Desktop Chrome'], baseURL },
    },
    {
      // Studio floor: pre-authenticated via the shared god storageState so each
      // test skips the magic-link round-trip (kills the per-test login flake).
      name: 'studio',
      testMatch: STUDIO_FLOOR,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL,
        trace: 'retain-on-failure',
        storageState: STUDIO_STORAGE_STATE,
      },
    },
    {
      name: 'chromium',
      testIgnore: [STUDIO_FLOOR, SETUP_FILE],
      use: {
        ...devices['Desktop Chrome'],
        baseURL,
        trace: 'retain-on-failure',
      },
    },
    {
      name: 'yandex',
      testIgnore: [STUDIO_FLOOR, SETUP_FILE],
      use: {
        ...devices['Desktop Chrome'],
        baseURL,
        trace: 'retain-on-failure',
        // Spoof Yandex Browser UA so any UA-sniffing code (e.g. PWAInstallPrompt
        // iOS hint) is exercised. The rendering engine is still Chromium,
        // which matches real Yandex Browser behaviour (it ships Blink).
        userAgent: YANDEX_UA,
      },
    },
  ],
});
