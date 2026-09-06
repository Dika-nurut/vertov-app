const ESC_STAR = '\u0000';
const ESC_UNDER = '\u0001';

/**
 * Strip Fountain inline markup for plain-text surfaces (FDX text runs,
 * PDF typesetting, previews): notes, boneyard spans, emphasis markers.
 * Escaped markers (`\*`, `\_`) become the literal character.
 */
export function stripInline(text: string): string {
  let s = text;
  // Inline notes and boneyard never render.
  s = s.replace(/\[\[[\s\S]*?\]\]/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  // Protect escaped markers.
  s = s.replace(/\\\*/g, ESC_STAR).replace(/\\_/g, ESC_UNDER);
  // Emphasis: ***bold italic***, **bold**, *italic*, _underline_.
  s = s.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1');
  s = s.replace(/_([^_\n]+)_/g, '$1');
  return s.replace(new RegExp(ESC_STAR, 'g'), '*').replace(new RegExp(ESC_UNDER, 'g'), '_');
}
