/**
 * Deterministic, prompt-derived SVG preview for STUB mode.
 *
 * This is NOT real generation. Every image is clearly labelled «превью · стаб» so
 * nobody mistakes it for live Seedream output. It exists so the product *feels*
 * responsive while BYTEPLUS_MODE=stub — each distinct prompt yields a distinct,
 * attractive placeholder (seeded by the prompt), instead of the single frozen
 * fixture image that made every generation look identical. The moment a real
 * BYTEPLUS_API_KEY lands and BYTEPLUS_MODE=live, this code path is bypassed
 * entirely and real model output replaces it.
 */

/** FNV-1a 32-bit — small, dependency-free, stable across runs. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
}

/** Greedy word-wrap into at most `maxLines` lines of ~`max` chars, eliding overflow. */
function wrap(text: string, max: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return ['—'];
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > max && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const consumed = lines.join(' ').split(/\s+/).filter(Boolean).length;
  if (consumed < words.length && lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = `${lines[last]!.replace(/\s*\S{0,2}$/, '')}…`;
  }
  return lines;
}

export interface StubPreviewOpts {
  prompt: string;
  /** Human label e.g. "seedream 4.0" shown in the footer. */
  modelLabel: string;
  /** Square side in px (parsed from params.size, default 1024). */
  size: number;
  /** Extra entropy (batch index, seed) so n>1 results differ visibly. */
  variant?: string;
}

/** Build a deterministic SVG preview string for the given prompt + model. */
export function renderStubPreviewSvg(opts: StubPreviewOpts): string {
  const size = Number.isFinite(opts.size) && opts.size > 0 ? Math.round(opts.size) : 1024;
  const seed = `${opts.prompt}|${opts.modelLabel}|${opts.variant ?? ''}`;
  const h = hash32(seed);
  const hue1 = h % 360;
  const hue2 = (hue1 + 50 + (h % 90)) % 360;
  const bgTop = `hsl(${hue1} 65% 12%)`;
  const bgBot = `hsl(${hue2} 70% 22%)`;
  const blob = `hsl(${hue2} 80% 55%)`;
  const blob2 = `hsl(${(hue1 + 200) % 360} 75% 50%)`;

  // Two decorative blobs positioned + sized from the hash, for visual variety.
  const bx1 = 15 + (h % 55);
  const by1 = 18 + ((h >> 4) % 40);
  const br1 = 22 + ((h >> 8) % 26);
  const bx2 = 50 + ((h >> 12) % 45);
  const by2 = 55 + ((h >> 16) % 35);
  const br2 = 14 + ((h >> 20) % 20);

  const lines = wrap((opts.prompt ?? '').trim() || 'пустой промпт', 24, 4);
  const titlePx = Math.round(size * 0.052);
  const lineGap = size * 0.072;
  const startY = size * 0.46 - ((lines.length - 1) * lineGap) / 2;
  const textEls = lines
    .map(
      (ln, i) =>
        `<text x="50%" y="${(startY + i * lineGap).toFixed(1)}" text-anchor="middle" ` +
        `font-family="Inter, system-ui, sans-serif" font-size="${titlePx}" font-weight="600" ` +
        `fill="#ffffff" opacity="0.96">${escapeXml(ln)}</text>`,
    )
    .join('');

  const footerPx = Math.round(size * 0.026);
  const footer = escapeXml(`Seed · превью (стаб) · ${opts.modelLabel}`);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}">` +
    `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${bgTop}"/><stop offset="1" stop-color="${bgBot}"/>` +
    `</linearGradient>` +
    `<filter id="soft"><feGaussianBlur stdDeviation="${(size * 0.04).toFixed(1)}"/></filter>` +
    `</defs>` +
    `<rect width="${size}" height="${size}" fill="url(#bg)"/>` +
    `<g filter="url(#soft)" opacity="0.55">` +
    `<circle cx="${(bx1 * size) / 100}" cy="${(by1 * size) / 100}" r="${(br1 * size) / 100}" fill="${blob}"/>` +
    `<circle cx="${(bx2 * size) / 100}" cy="${(by2 * size) / 100}" r="${(br2 * size) / 100}" fill="${blob2}"/>` +
    `</g>` +
    textEls +
    `<text x="50%" y="${(size * 0.94).toFixed(1)}" text-anchor="middle" ` +
    `font-family="Inter, system-ui, sans-serif" font-size="${footerPx}" fill="#ffffff" opacity="0.62">` +
    `${footer}</text>` +
    `</svg>`
  );
}

/** Parse a "1024x1024"-style size string to a square side; default 1024. */
export function squareSizeFromParams(params: Record<string, unknown> | undefined): number {
  const raw = params?.['size'];
  if (typeof raw === 'string') {
    const m = /^(\d+)\s*x\s*(\d+)$/i.exec(raw.trim());
    if (m) return Math.min(Number(m[1]), Number(m[2]));
  }
  return 1024;
}
