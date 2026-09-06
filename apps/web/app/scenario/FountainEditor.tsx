'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  classifyLines,
  fountainStyling,
  markerElement,
  nextSpElement,
  screenplayTheme,
  setSpElement,
  type SpClass,
} from './fountain-cm';

export interface EditorSelection {
  from: number;
  to: number;
  quote: string;
}

// ---- preview-in-place («К месту»): mark the anchor span with .cm-sp-suggest ----
const setPreview = StateEffect.define<{ from: number; to: number } | null>();
const previewMark = Decoration.mark({ class: 'cm-sp-suggest' });
const previewField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPreview)) {
        next =
          e.value && e.value.to > e.value.from
            ? Decoration.set([previewMark.range(e.value.from, e.value.to)])
            : Decoration.none;
      }
    }
    // Any edit dismisses a pending preview.
    if (tr.docChanged && !tr.effects.some((e) => e.is(setPreview))) next = Decoration.none;
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Classify the line the caret sits on (contextual, so classify from the top). */
function caretElement(state: EditorState): SpClass {
  const head = state.selection.main.head;
  const lineNo = state.doc.lineAt(head).number;
  return classifyLines(state.doc.toString())[lineNo - 1] ?? 'action';
}

/** Replace the caret's line text with `text`, keeping the caret at its end. */
function replaceCaretLine(view: EditorView, text: string): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (text === line.text) return;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: text },
    selection: { anchor: line.from + text.length },
    userEvent: 'input.retype',
  });
}

export interface FountainEditorHandle {
  /** Current non-empty selection as char offsets + quote, else null. */
  getSelection: () => EditorSelection | null;
  /** Replace [from,to) with text as a normal (undoable) edit; returns new end. */
  replaceRange: (from: number, to: number, text: string) => void;
  /** Replace the whole document (load / restore / import). */
  setDoc: (text: string) => void;
  /** Scroll a position into view and place the cursor there. */
  reveal: (pos: number) => void;
  /** Mark [from,to) as a preview («К месту») and scroll to it. */
  previewAt: (from: number, to: number) => void;
  focus: () => void;
}

interface Props {
  initialDoc: string;
  readOnly?: boolean;
  onChange?: (text: string) => void;
  onSelectionChange?: (sel: EditorSelection | null) => void;
  /** Fired with the element type the caret currently sits in (for the ribbon). */
  onElementChange?: (element: SpClass) => void;
  /** Fired with the caret's char offset (for СОДЕРЖАНИЕ caret tracking). */
  onCaret?: (offset: number) => void;
  /** When set, caret + scroll position persist across reopens (day-2 continuity). */
  persistKey?: string;
}

interface CaretState {
  pos: number;
  top: number;
}
const caretKey = (k: string) => `scenario-caret:${k}`;
function readCaret(k: string): CaretState | null {
  try {
    const raw = localStorage.getItem(caretKey(k));
    return raw ? (JSON.parse(raw) as CaretState) : null;
  } catch {
    return null;
  }
}
/** Persist the caret + scroll position (immediate; last-write-wins). */
function writeCaret(k: string, pos: number, top: number): void {
  try {
    localStorage.setItem(caretKey(k), JSON.stringify({ pos, top }));
  } catch {
    /* quota / private mode — non-fatal */
  }
}
// Scroll fires fast, so throttle only the scroll path; selection changes are
// user-paced and always persist immediately so the final caret is never lost.
const lastScrollSaveAt = new Map<string, number>();
function throttledScrollSave(k: string, pos: number, top: number): void {
  const now = Date.now();
  if (now - (lastScrollSaveAt.get(k) ?? 0) < 250) return;
  lastScrollSaveAt.set(k, now);
  writeCaret(k, pos, top);
}

/** CodeMirror 6 editor for the white Fountain sheet (char-offset native). */
export const FountainEditor = forwardRef<FountainEditorHandle, Props>(function FountainEditor(
  {
    initialDoc,
    readOnly = false,
    onChange,
    onSelectionChange,
    onElementChange,
    onCaret,
    persistKey,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastElement = useRef<SpClass | null>(null);
  // Keep the latest callbacks without re-creating the editor.
  const cb = useRef({ onChange, onSelectionChange, onElementChange, onCaret });
  cb.current = { onChange, onSelectionChange, onElementChange, onCaret };

  useEffect(() => {
    if (!hostRef.current) return;
    // Tab-cycle state: the element the caret's line was last cycled TO, so
    // repeated Tab advances deterministically through the soft types
    // (dialogue/action have no marker to re-derive from). Reset whenever the
    // caret leaves the line or the line is edited by anything but a retype.
    let cycle: { from: number; type: SpClass } | null = null;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          // Custom selection layer: the theme already styles .cm-selectionBackground
          // (dead without this). It keeps the highlight visible when focus moves to
          // the composer — native ::selection vanishes on blur. (Remediation R1/C2.)
          drawSelection(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': readOnly ? 'Текст сценария' : 'Редактор сценария',
          }),
          fountainStyling,
          previewField,
          screenplayTheme,
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) {
              const r = u.state.selection.main;
              if (r.empty) {
                cb.current.onSelectionChange?.(null);
              } else {
                cb.current.onSelectionChange?.({
                  from: r.from,
                  to: r.to,
                  quote: u.state.doc.sliceString(r.from, r.to),
                });
              }
              const caretLine = u.state.doc.lineAt(u.state.selection.main.head);
              const el = markerElement(caretLine.text, caretElement(u.state));
              if (el !== lastElement.current) {
                lastElement.current = el;
                cb.current.onElementChange?.(el);
              }
              if (persistKey) writeCaret(persistKey, r.head, view.scrollDOM.scrollTop);
              cb.current.onCaret?.(r.head);
            }
            // Invalidate the Tab-cycle anchor when the caret leaves its line or
            // the line changes by something other than our own retype.
            if (cycle) {
              const caretLineFrom = u.state.doc.lineAt(u.state.selection.main.head).from;
              const ownRetype = u.transactions.some((t) => t.isUserEvent('input.retype'));
              if (caretLineFrom !== cycle.from || (u.docChanged && !ownRetype)) cycle = null;
            }
          }),
          EditorView.domEventHandlers({
            scroll: (_e, view) => {
              if (persistKey)
                throttledScrollSave(
                  persistKey,
                  view.state.selection.main.head,
                  view.scrollDOM.scrollTop,
                );
            },
          }),
        ],
      }),
    });
    viewRef.current = view;

    // Screenplay Tab cycling — retype the caret's element instead of inserting
    // whitespace; ⌘/Ctrl+1 jumps to a scene heading. A raw capture-phase
    // listener on contentDOM (CM's own keymap/domEventHandlers did not win over
    // the browser's default Tab focus traversal in this setup) so it reliably
    // fires before both the browser default and CM.
    const onEditorKey = (e: KeyboardEvent) => {
      if (readOnly) return;
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const base =
          cycle && cycle.from === line.from
            ? cycle.type
            : markerElement(line.text, caretElement(view.state));
        const target = nextSpElement(base);
        replaceCaretLine(view, setSpElement(line.text, target));
        cycle = { from: line.from, type: target };
        notifyElement(target);
      } else if (e.key === '1' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        replaceCaretLine(view, setSpElement(line.text, 'scene'));
        cycle = { from: line.from, type: 'scene' };
        notifyElement('scene');
      }
    };
    // After an explicit cycle, the ribbon shows what you chose — even for the
    // soft types (a bare «реплика» line is contextually action until a cue
    // precedes it); the contextual class takes back over on the next caret move.
    const notifyElement = (el: SpClass) => {
      lastElement.current = el;
      cb.current.onElementChange?.(el);
    };
    view.contentDOM.addEventListener('keydown', onEditorKey, true);

    // Day-2 continuity: restore the caret + scroll position from last visit.
    if (persistKey && !readOnly) {
      const saved = readCaret(persistKey);
      if (saved && saved.pos <= view.state.doc.length) {
        view.dispatch({ selection: { anchor: saved.pos }, scrollIntoView: true });
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = saved.top;
        });
      }
    }

    return () => {
      view.contentDOM.removeEventListener('keydown', onEditorKey, true);
      view.destroy();
      viewRef.current = null;
    };
    // Editor is created once; external doc changes go through the imperative
    // handle (setDoc/replaceRange) so undo history and cursor stay coherent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    (): FountainEditorHandle => ({
      getSelection: () => {
        const view = viewRef.current;
        if (!view) return null;
        const r = view.state.selection.main;
        if (r.empty) return null;
        return { from: r.from, to: r.to, quote: view.state.doc.sliceString(r.from, r.to) };
      },
      replaceRange: (from, to, text) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        view.focus();
      },
      setDoc: (text) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      },
      reveal: (pos) => {
        const view = viewRef.current;
        if (!view) return;
        const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
        view.dispatch({ selection: { anchor: clamped }, scrollIntoView: true });
        view.focus();
      },
      previewAt: (from, to) => {
        const view = viewRef.current;
        if (!view) return;
        const lo = Math.max(0, Math.min(from, view.state.doc.length));
        const hi = Math.max(lo, Math.min(to, view.state.doc.length));
        view.dispatch({ effects: setPreview.of({ from: lo, to: hi }), scrollIntoView: true });
      },
      focus: () => viewRef.current?.focus(),
    }),
    [],
  );

  return <div ref={hostRef} className="h-full overflow-auto" data-testid="scenario-editor" />;
});
