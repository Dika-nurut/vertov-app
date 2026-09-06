import { test, expect } from './fixtures';

/** A tiny PCM-16 mono WAV sine tone — decodable by Web Audio for the waveform. */
function makeWavTone(seconds = 0.5, freq = 440, rate = 8000): Buffer {
  const samples = Math.floor(seconds * rate);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.6 * 32767);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

/**
 * B-2a studio completion (unblocked half): a render shows up in durable history
 * that survives a refresh (it's fetched from the backend), and a social export
 * preset applies to the export settings in one click.
 */
test('studio: render history persists across refresh + export preset applies', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  // Create a render so history is non-empty. The row persists regardless of the
  // render's outcome, which is exactly what "survives refresh" needs to prove.
  const r = await context.request.post(`${apiUrl}/v1/studio/render`, {
    data: { clips: [{ url: 'https://example.com/clip.mp4' }], width: 640, height: 360, fps: 24 },
    headers: { cookie: cookieHeader },
  });
  expect([200, 201]).toContain(r.status());

  // Fresh load → the history panel is populated from the backend (survives refresh).
  await page.goto('/studio');
  await expect(page.getByTestId('render-history')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('history-item').first()).toBeVisible({ timeout: 30_000 });

  // A social preset applies to the export settings: YouTube → 16:9 aspect.
  await page.getByTestId('export-settings').click();
  await page.getByTestId('preset-youtube').click();
  await expect(page.getByTestId('format-16:9')).toHaveClass(/selected-neutral/);
});

test('studio: a waveform renders for an uploaded audio track', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  // Upload a synthetic WAV tone → proxy URL.
  const up = await context.request.post(`${apiUrl}/v1/studio/upload-audio?ext=wav`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/octet-stream' },
    data: makeWavTone(),
  });
  expect(up.ok(), `upload-audio should succeed (got ${up.status()})`).toBeTruthy();
  const { url } = (await up.json()) as { url: string };

  // Seed it as the project's music track so Studio loads it on mount.
  const put = await context.request.put(`${apiUrl}/v1/studio/project`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: {
      timeline: {
        timeline: [],
        texts: [],
        overlays: [],
        music: { url, name: 'tone.wav', gainDb: 0, fromSec: 0, fadeIn: false, fadeOut: false },
        voiceover: null,
        formatId: '9:16',
      },
    },
  });
  expect(put.ok(), `project PUT should succeed (got ${put.status()})`).toBeTruthy();

  // The music line decodes the audio and renders its waveform.
  await page.goto('/studio');
  await expect(page.getByTestId('waveform').first()).toBeVisible({ timeout: 30_000 });
});

test('studio: auto-captions add timed caption clips to the timeline (B-2b)', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  // Seed a project with one clip on the timeline (so there is audio to caption).
  const put = await context.request.put(`${apiUrl}/v1/studio/project`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: {
      timeline: {
        timeline: [
          { uid: 'c1', url: 'http://127.0.0.1:4100/x/clip.mp4', dur: 5, inSec: 0, outSec: 5 },
        ],
        texts: [],
        overlays: [],
        music: null,
        voiceover: null,
        formatId: '9:16',
      },
    },
  });
  expect(put.ok()).toBeTruthy();

  await page.goto('/studio');
  // Auto-caption (Deepgram-gated; zero-spend stub returns 2 segments here).
  await page.getByTestId('auto-caption').click();
  await expect
    .poll(() => page.getByTestId('text-block').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
});
