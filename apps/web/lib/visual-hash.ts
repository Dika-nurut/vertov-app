/**
 * Deterministic visual identity for media-less cards (preset tiles, gallery
 * fallbacks). 26 cards rendering one identical gradient reads as 26 clones —
 * the definition of slop. Hashing the slug into a duotone gradient keeps every
 * card distinguishable with zero asset production.
 *
 * NEUTRAL-dark system (redesign): the base is near-neutral graphite (very low
 * saturation, hue drifts only within a tight cool band so tiles never read as
 * the dead "warm-paper/sepia" of the old skin). The single warm note is one
 * faint amber bloom whose POSITION varies per slug — so cards stay on the
 * one-amber-accent system yet each gets a distinct fingerprint (bloom placement
 * + a subtle base-tone shift), not a candy colour.
 *
 * Pure string → style math; no I/O, stable across renders and sessions.
 */

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface CardVisual {
  /** CSS background shorthand: accent radial over a duotone linear. */
  background: string;
  /** Primary hue — reusable for borders/glyph tints if needed. */
  hue: number;
}

export function cardVisual(seed: string): CardVisual {
  const h = hash32(seed);
  // Near-neutral graphite duotone — a tight cool band (218..236) at very low
  // saturation (6..12%) and low lightness, so each tile reads as on-palette
  // graphite, never sepia. The base tone shifts subtly per slug for identity.
  const hue1 = 218 + (h % 18); // 218..235 cool graphite
  const hue2 = 224 + ((h >>> 8) % 14); // 224..237
  const sat = 6 + ((h >>> 20) % 7); // 6..12% — barely tinted
  const angle = 150 + ((h >>> 16) % 60); // 150°–210°, always top-lit
  const spotX = 20 + ((h >>> 4) % 60); // amber-bloom position (the one accent)
  const spotY = 6 + ((h >>> 12) % 30);
  const background =
    `radial-gradient(115% 90% at ${spotX}% ${spotY}%, hsl(36 92% 58% / 0.1), transparent 58%), ` +
    `linear-gradient(${angle}deg, hsl(${hue1} ${sat}% 11%) 0%, hsl(${hue2} ${sat}% 14%) 52%, hsl(${hue1} ${sat}% 7%) 100%)`;
  return { background, hue: hue1 };
}
