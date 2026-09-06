/**
 * Pure helpers that turn the raw `{family, variant}` we store in the
 * `models` table — or the slug-style id — into a human label for the UI.
 * No I/O, no DB lookup: the catalog is small and stable.
 */
export interface ModelLike {
  family: string;
  variant: string;
  displayName?: string | null;
}

const FAMILY_LABEL: Record<string, string> = {
  seedream: 'Seedream',
  seedance: 'Seedance',
  seedtts: 'Seed-TTS',
  doubao: 'Doubao',
};

export function modelDisplayName(input: ModelLike): string {
  if (input.displayName?.trim()) return input.displayName.trim();
  const family = familyLabel(input.family);
  const variant = formatVariantTokens(splitDashes(input.variant));
  if (!family && !variant) return '—';
  if (!variant) return family;
  if (!family) return variant;
  return `${family} ${variant}`;
}

/**
 * Convenience for callers that only have a slug-style id like
 * `seedream-4-5` or `seedance-1-0-pro-fast`. The first dash separates the
 * family from the variant; numeric tokens join with `.`, alpha tokens are
 * capitalised and space-separated.
 */
export function modelDisplayNameFromId(modelId: string): string {
  const id = (modelId ?? '').trim();
  if (!id) return '—';
  const dash = id.indexOf('-');
  if (dash <= 0) return familyLabel(id) || id;
  const family = id.slice(0, dash);
  const rest = id.slice(dash + 1);
  return modelDisplayName({ family, variant: rest });
}

function familyLabel(family: string): string {
  const f = (family ?? '').trim();
  if (!f) return '';
  return FAMILY_LABEL[f.toLowerCase()] ?? capitalize(f);
}

function splitDashes(s: string): string[] {
  return (s ?? '').split('-').filter(Boolean);
}

function formatVariantTokens(tokens: string[]): string {
  if (tokens.length === 0) return '';
  const out: string[] = [];
  let numericRun: string[] = [];
  const flush = () => {
    if (numericRun.length) {
      out.push(numericRun.join('.'));
      numericRun = [];
    }
  };
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      numericRun.push(t);
    } else if (/^\d/.test(t)) {
      // Tokens that already contain a dot like "4.0" go through as-is.
      flush();
      out.push(t);
    } else {
      flush();
      out.push(capitalize(t));
    }
  }
  flush();
  return out.join(' ');
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
