// Pure helpers for the authenticated home (no React/'use client') so the
// display logic is unit-testable in isolation from the client components.

/** Russian plural: forms = [one, few, many] e.g. кадр / кадра / кадров. */
export function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
}

// Витрина tile sizes — images BIG, videos always SMALL (owner-locked style,
// design/landing-mocks/slices/vitrina.html). Cycled by per-kind position so
// the marginless mosaic packs densely (grid-auto-flow: dense).
const IMG_SIZES = ['v-i-big', 'v-i-mid', 'v-i-tall', 'v-i-mid'] as const;
const VID_SIZES = ['v-v-sm', 'v-v-md', 'v-v-sm', 'v-v-sq', 'v-v-sm'] as const;

/** Assign a size class per showcase item, preserving order. */
export function assignVitrinaSizes(kinds: ReadonlyArray<'image' | 'video'>): string[] {
  let imgIdx = 0;
  let vidIdx = 0;
  return kinds.map((kind) =>
    kind === 'image'
      ? IMG_SIZES[imgIdx++ % IMG_SIZES.length]!
      : VID_SIZES[vidIdx++ % VID_SIZES.length]!,
  );
}
