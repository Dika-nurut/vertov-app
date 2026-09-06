import { defineConfig, devices } from '@playwright/test';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv({ path: resolve(__dirname, '../../.env') });
const baseURL = process.env.WEB_PUBLIC_URL;
if (!baseURL) throw new Error('WEB_PUBLIC_URL must be set');

export default defineConfig({
  testDir: './e2e',
  testMatch: /studio-readiness\.spec\.ts/,
  timeout: 120_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'chromium-android', use: { ...devices['Pixel 7'] } },
    { name: 'webkit-ipad', use: { ...devices['iPad Pro 11'] } },
  ],
});
