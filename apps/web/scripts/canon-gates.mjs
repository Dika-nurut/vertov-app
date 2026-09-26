/**
 * Slate-Brutal canon grep gates (WS6).
 *
 * Mechanical guards for the five-second gut check in docs/design/design-bible.md:
 *   1. hex-in-tsx          — no raw #hex literals in .tsx (tokens only)
 *   2. rounded-full-pill   — no rounded-full + padding/font-size (text-label pill buttons)
 *   3. backdrop-blur       — blur is banned, zero exceptions
 *   4. lucide-imports      — lucide is banned (Phosphor bold / PixelGlyph only)
 *
 * Run: `node scripts/canon-gates.mjs` (wired as `pnpm lint:canon`).
 * Exits non-zero listing every violation. Deliberately NOT CI config — a script
 * plus a lint entry, so it runs wherever `lint:canon` runs.
 *
 * Allowlist entries are load-bearing documentation: each names WHY the hit is
 * legitimate (bible exception or out-of-WS6-scope pre-existing). Do not extend
 * the list without the same one-line reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['app', 'components', 'lib'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** { gate, file (repo-relative substring), match (line substring), reason } */
const ALLOW = [
  {
    gate: 'hex-in-tsx',
    file: 'app/layout.tsx',
    match: 'theme-color',
    reason: 'bible exception: browser-chrome meta tag',
  },
  {
    gate: 'hex-in-tsx',
    file: 'app/_components/landing/HeroSky.tsx',
    match: '#',
    reason: 'bible exception: canvas paint calls mirror tokens per-pixel + comment',
  },
  {
    gate: 'hex-in-tsx',
    file: 'app/styleguide/page.tsx',
    match: "'#",
    reason: 'token reference table — the hex IS the documented content',
  },
  {
    gate: 'hex-in-tsx',
    file: 'app/studio/_preview/PreviewStage.tsx',
    match: '#000000',
    reason: 'pre-existing, out of WS6 scope (studio untouched)',
  },
  {
    gate: 'hex-in-tsx',
    file: 'app/studio/_inspector/TextInspector.tsx',
    match: '#101014',
    reason: 'pre-existing, out of WS6 scope (studio untouched)',
  },
  {
    gate: 'hex-in-tsx',
    file: 'app/studio/_inspector/BackgroundPanel.tsx',
    match: '#000000',
    reason: 'pre-existing null-mapping sentinel, marked bible-ok in code',
  },
  {
    gate: 'rounded-full-pill',
    file: 'app/boards/[id]/BoardNodes.tsx',
    match: 'h-6 w-6',
    reason: 'pre-existing 24px icon chip — bible-allowed circular affordance (≤40px)',
  },
];

const GATES = [
  {
    name: 'hex-in-tsx',
    // Hex literal, 3–8 digits. (Short-circuit: url(#…) SVG fragment refs are
    // not colors — excluded via the negative lookbehind for `(`.)
    re: /(?<!\()#[0-9a-fA-F]{3,8}\b/,
  },
  {
    name: 'rounded-full-pill',
    // rounded-full together with horizontal padding or an explicit font SIZE
    // reads as a text-label pill button (violation); bare dots, drag-handles,
    // and ≤40px icon chips (which may carry text-[color:…] tints) never match.
    re: /rounded-full.*(px-|text-\[\d)|(px-|text-\[\d).*rounded-full/,
  },
  {
    name: 'backdrop-blur',
    re: /backdrop-blur|backdropBlur/,
  },
  {
    name: 'lucide-imports',
    re: /from\s+['"]lucide-react['"]|require\(\s*['"]lucide/,
  },
];

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
let failures = 0;

for (const gate of GATES) {
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!gate.re.test(line)) return;
      const excused = ALLOW.some(
        (a) => a.gate === gate.name && rel.includes(a.file) && line.includes(a.match),
      );
      if (excused) return;
      failures += 1;
      console.error(`[${gate.name}] ${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
}

if (failures > 0) {
  console.error(`\ncanon-gates: ${failures} violation(s). See docs/design/design-bible.md.`);
  process.exit(1);
}
console.log('canon-gates: clean.');
