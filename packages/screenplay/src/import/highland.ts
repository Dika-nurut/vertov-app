import { unzipSync } from 'fflate';
import type { ImportResult } from '../model.js';
import { importFountain } from './txt.js';

/**
 * `.highland` (Highland bundle) → Fountain.
 *
 * A Highland bundle is a zip that carries the screenplay as Fountain-class
 * text (typically `text.fountain` or a TextBundle `text.md`/`text.markdown`).
 * We unzip, take the most plausible text entry, and import it as Fountain —
 * lossless, since Highland's native format IS Fountain.
 */
const TEXT_ENTRY_RE = /\.(fountain|md|markdown|txt)$/i;

export function importHighland(data: Uint8Array): ImportResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new Error('Не удалось прочитать Highland-файл: это не zip-архив.');
  }

  const names = Object.keys(files)
    .filter((n) => TEXT_ENTRY_RE.test(n) && !n.startsWith('__MACOSX/'))
    // Prefer .fountain, then shortest path (the bundle root text file).
    .sort(
      (a, b) =>
        Number(/\.fountain$/i.test(b)) - Number(/\.fountain$/i.test(a)) || a.length - b.length,
    );
  const entry = names[0];
  if (!entry) {
    throw new Error('Не удалось прочитать Highland-файл: внутри нет текста сценария.');
  }
  return importFountain(Buffer.from(files[entry]!).toString('utf-8'));
}
