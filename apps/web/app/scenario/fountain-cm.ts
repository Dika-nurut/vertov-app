import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { classifyLines, type SpClass } from './fountain-classify';

// CodeMirror styling for the white screenplay sheet. The pure classifier and
// Tab-cycle transforms live in ./fountain-classify (no CM dependency, so they
// are unit-testable and importable from plain modules); re-exported here so
// existing importers keep working.

export type { SpClass } from './fountain-classify';
export {
  classifyLines,
  characterCues,
  isUpperCue,
  SCENE_RE,
  SP_CYCLE,
  SP_LABEL_RU,
  nextSpElement,
  bareLineText,
  setSpElement,
  markerElement,
} from './fountain-classify';

const lineDeco: Record<SpClass, Decoration> = {
  scene: Decoration.line({ class: 'cm-sp-scene' }),
  character: Decoration.line({ class: 'cm-sp-character' }),
  paren: Decoration.line({ class: 'cm-sp-paren' }),
  dialogue: Decoration.line({ class: 'cm-sp-dialogue' }),
  transition: Decoration.line({ class: 'cm-sp-transition' }),
  section: Decoration.line({ class: 'cm-sp-section' }),
  synopsis: Decoration.line({ class: 'cm-sp-synopsis' }),
  action: Decoration.line({ class: 'cm-sp-action' }),
};

/** ViewPlugin that decorates each visible line by its Fountain class. */
export const fountainStyling = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    classes: SpClass[];

    constructor(view: EditorView) {
      this.classes = classifyLines(view.state.doc.toString());
      this.decorations = this.build(view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged) {
        this.classes = classifyLines(u.state.doc.toString());
      }
      if (u.docChanged || u.viewportChanged) {
        this.decorations = this.build(u.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos);
          const cls = this.classes[line.number - 1] ?? 'action';
          builder.add(line.from, line.from, lineDeco[cls]);
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

/** The white typeset sheet + per-class screenplay styling.
 *  Exact-value hits are mapped to theme tokens (--color-paper / -ink / -accent /
 *  -positive and the --accent-rgb / --positive-rgb channels). The two paper-sheet
 *  grays (#444, #777) have NO dark-surface token equivalent (muted-foreground is
 *  a bone tint — illegible on paper), so they stay literal: vendor-required
 *  CodeMirror sheet values, not design tokens. */
export const screenplayTheme = EditorView.theme({
  '&': {
    color: 'var(--color-paper-ink)',
    backgroundColor: 'var(--color-paper)',
    fontFamily: "'Courier New', Courier, monospace",
    fontSize: '15px',
  },
  '.cm-scroller': { lineHeight: '1.5', fontFamily: "'Courier New', Courier, monospace" },
  '.cm-content': {
    caretColor: 'var(--color-paper-ink)',
    padding: '48px 0 64px',
    maxWidth: '620px',
    margin: '0 auto',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0 8px' },
  // Vertical rhythm uses paddingTop, NOT marginTop: CM6's height map measures
  // line boxes without vertical margins, so a margin here desyncs every
  // coordinate below it (click-to-caret, drag-selection, coordsAtPos). Padding
  // IS measured — same visual gap, coordinates stay honest. (Remediation R1/C1.)
  '.cm-sp-scene': { fontWeight: '700', textTransform: 'uppercase', paddingTop: '1.1em' },
  '.cm-sp-action': { paddingTop: '0.2em' },
  '.cm-sp-character': { paddingLeft: '38%', textTransform: 'uppercase', paddingTop: '0.9em' },
  '.cm-sp-paren': { paddingLeft: '30%', color: '#444' },
  '.cm-sp-dialogue': { paddingLeft: '20%', paddingRight: '18%' },
  '.cm-sp-transition': { textAlign: 'right', textTransform: 'uppercase', paddingTop: '0.9em' },
  '.cm-sp-section': { fontWeight: '700', color: 'var(--color-accent)' },
  '.cm-sp-synopsis': { fontStyle: 'italic', color: '#777' },
  '.cm-sp-suggest': {
    backgroundColor: 'rgba(var(--positive-rgb),0.20)',
    borderLeft: '3px solid var(--color-positive)',
  },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(var(--accent-rgb),0.30)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(var(--accent-rgb),0.30)' },
});
