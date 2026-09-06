import type { ScreenplayDoc } from '../model.js';
import { stripInline } from '../fountain/inline.js';

/**
 * Fountain → Final Draft `.fdx`.
 *
 * Maps the screenplay elements FD understands: Scene Heading (with scene
 * number), Action (centered via Alignment), Character, Parenthetical,
 * Dialogue, Transition. Editorial-only Fountain constructs (sections,
 * synopses, notes, boneyard, page breaks) have no FD paragraph equivalent
 * and are not emitted — they stay in the canonical Fountain.
 *
 * Consecutive dialogue lines join into one Dialogue paragraph with literal
 * newlines; the importer splits them back, so fdx→fountain→fdx holds.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Split Fountain inline emphasis into FD style runs so *italics*, **bold**
 * and _underline_ survive the trip instead of being flattened.
 * Nested emphasis is not resolved (outermost marker wins).
 */
const EMPHASIS_RE = /\*{3}([^*\n]+)\*{3}|\*{2}([^*\n]+)\*{2}|\*([^*\n]+)\*|_([^_\n]+)_/g;

function textRuns(text: string): string {
  const runs: string[] = [];
  let last = 0;
  for (const m of text.matchAll(EMPHASIS_RE)) {
    if (m.index! > last) runs.push(`<Text>${esc(stripInline(text.slice(last, m.index!)))}</Text>`);
    const [boldItalic, bold, italic, underline] = [m[1], m[2], m[3], m[4]];
    const inner = boldItalic ?? bold ?? italic ?? underline!;
    const style = boldItalic ? 'Bold+Italic' : bold ? 'Bold' : italic ? 'Italic' : 'Underline';
    runs.push(`<Text Style="${style}">${esc(inner)}</Text>`);
    last = m.index! + m[0].length;
  }
  if (last < text.length || runs.length === 0) {
    runs.push(`<Text>${esc(stripInline(text.slice(last)))}</Text>`);
  }
  return runs.join('');
}

function para(type: string, text: string, attrs = ''): string {
  return `    <Paragraph Type="${type}"${attrs}>\n      ${textRuns(text)}\n    </Paragraph>`;
}

export function exportFdx(doc: ScreenplayDoc): string {
  const body: string[] = [];
  const els = doc.elements;
  let i = 0;

  while (i < els.length) {
    const el = els[i]!;
    const text = el.text; // textRuns handles inline markup per segment
    switch (el.type) {
      case 'scene_heading':
        body.push(
          para('Scene Heading', text, el.sceneNumber ? ` Number="${esc(el.sceneNumber)}"` : ''),
        );
        break;
      case 'action':
        body.push(para('Action', text));
        break;
      case 'centered':
        body.push(para('Action', text, ' Alignment="Center"'));
        break;
      case 'lyrics':
        body.push(para('Action', text));
        break;
      case 'character':
        body.push(para('Character', text));
        break;
      case 'parenthetical':
        body.push(para('Parenthetical', text));
        break;
      case 'dialogue': {
        // Merge consecutive dialogue elements into one FD paragraph.
        const lines: string[] = [];
        let j = i;
        while (j < els.length && els[j]!.type === 'dialogue') {
          lines.push(els[j]!.text);
          j++;
        }
        body.push(para('Dialogue', lines.join('\n')));
        i = j;
        continue;
      }
      case 'transition':
        body.push(para('Transition', text));
        break;
      default:
        break; // blank, section, synopsis, note, boneyard, page_break
    }
    i++;
  }

  const titleParas = doc.titlePage.map((entry) =>
    para('General', `${entry.key}: ${entry.values.join(', ')}`),
  );
  const titlePage =
    titleParas.length > 0
      ? `\n  <TitlePage>\n    <Content>\n${titleParas.map((p) => '    ' + p.replace(/\n/g, '\n    ')).join('\n')}\n    </Content>\n  </TitlePage>`
      : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
${body.join('\n')}
  </Content>${titlePage}
</FinalDraft>
`;
}
