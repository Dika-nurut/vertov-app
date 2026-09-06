/**
 * Storyboard / contact-sheet export (B-3). Builds a self-contained, printable
 * HTML document from the derived shot list — a grid of shot cards with the
 * still (image take, or a video's last frame), number, title, prompt, and
 * cast/locations. Returned as an HTML string (pure → unit-tested); the board
 * downloads it as a .html blob the director can open/print to PDF.
 *
 * HTML (not canvas) on purpose: <img> never taints anything, so cross-origin
 * asset-proxy thumbnails always render and print cleanly.
 */
import type { ShotListRow } from './shot-list';

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** The still to show for a shot: the image take, or a video take's last frame
 * (an mp4 URL is no use in an <img>, so video falls back to its last frame). */
export function shotStill(shot: ShotListRow): string | undefined {
  if (shot.resultKind === 'video') return shot.lastFrameUrl;
  return shot.resultUrl ?? shot.lastFrameUrl;
}

export function buildStoryboardHtml(shots: ShotListRow[], boardTitle = 'Раскадровка'): string {
  const title = escapeHtml(boardTitle);
  const cards = shots
    .map((s) => {
      const still = shotStill(s);
      const meta = [
        s.mode === 'video' ? 'Видео' : 'Кадр',
        ...(s.cast.length ? [s.cast.join(', ')] : []),
        ...(s.locations.length ? [s.locations.join(', ')] : []),
      ]
        .map(escapeHtml)
        .join(' · ');
      const frame = still
        ? `<img src="${escapeHtml(still)}" alt="" loading="lazy" />`
        : `<div class="ph">нет дубля</div>`;
      return `<figure class="shot">
  <div class="frame">${frame}<span class="num">${s.shotNumber}</span></div>
  <figcaption>
    <strong>${escapeHtml(s.title)}</strong>
    <span class="meta">${meta}</span>
    ${s.prompt ? `<p class="prompt">${escapeHtml(s.prompt)}</p>` : ''}
  </figcaption>
</figure>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 32px; color: #14120d; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #6b6458; margin: 0 0 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 18px; }
  .shot { margin: 0; break-inside: avoid; border: 1px solid #e6e0d4; border-radius: 10px; overflow: hidden; }
  .frame { position: relative; aspect-ratio: 16/9; background: #f3efe6; }
  .frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph { display: grid; place-items: center; height: 100%; color: #a89e8c; font-size: 12px; }
  .num { position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,.7); color: #fff; font-weight: 700; font-size: 11px; padding: 2px 7px; border-radius: 999px; }
  figcaption { padding: 10px 12px; }
  .meta { display: block; color: #6b6458; font-size: 12px; margin-top: 2px; }
  .prompt { margin: 6px 0 0; color: #3a352c; font-size: 12px; }
  @media print { body { margin: 12mm; } .shot { border-color: #ccc; } }
</style></head>
<body>
  <h1>${title}</h1>
  <p class="sub">${shots.length} ${shots.length === 1 ? 'кадр' : 'кадров'} · раскадровка Вертов</p>
  <div class="grid">
${cards}
  </div>
</body></html>`;
}
