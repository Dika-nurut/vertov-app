/**
 * CLI proof / dev utility for the screenplay format layer.
 *
 *   pnpm --filter @seed/screenplay exec tsx scripts/convert.ts <in> <out>
 *
 * Formats are inferred from extensions:
 *   in:  .fountain .spmd .txt .fdx .pdf .docx
 *   out: .pdf .fdx .fountain .txt
 * Prints the fidelity report for lossy imports to stderr.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import {
  exportFdx,
  exportPdf,
  exportFountain,
  importDocx,
  importFdx,
  importFountain,
  importPdf,
  parseFountain,
  type ImportResult,
} from '../src/index.js';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error(
    'usage: tsx scripts/convert.ts <in.(fountain|spmd|txt|md|fdx|pdf|docx)> <out.(pdf|fdx|fountain|txt)>',
  );
  process.exit(2);
}

const imported: ImportResult = await (async () => {
  switch (extname(inPath).toLowerCase()) {
    case '.fountain':
    case '.spmd':
    case '.txt':
    case '.md':
    case '.markdown':
      return importFountain(readFileSync(inPath, 'utf-8'));
    case '.fdx':
      return importFdx(readFileSync(inPath, 'utf-8'));
    case '.pdf':
      return importPdf(new Uint8Array(readFileSync(inPath)));
    case '.docx':
      return importDocx(new Uint8Array(readFileSync(inPath)));
    default:
      throw new Error(`unsupported input format: ${inPath}`);
  }
})();

if (!imported.report.lossless) {
  console.error('fidelity report (lossy import):');
  for (const issue of imported.report.issues) {
    console.error(`  [${issue.code}] ${issue.message}${issue.detail ? ` — ${issue.detail}` : ''}`);
  }
}

const doc = parseFountain(imported.fountain);
switch (extname(outPath).toLowerCase()) {
  case '.pdf':
    writeFileSync(outPath, await exportPdf(doc));
    break;
  case '.fdx':
    writeFileSync(outPath, exportFdx(doc));
    break;
  case '.fountain':
  case '.txt':
    writeFileSync(outPath, exportFountain(doc));
    break;
  default:
    throw new Error(`unsupported output format: ${outPath}`);
}
console.error(`wrote ${outPath}`);
