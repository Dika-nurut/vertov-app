'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FilmSlate as Film, MusicNote as Music } from '@phosphor-icons/react/dist/ssr';
import { assetSrc } from '@/lib/asset-src';
import { PIXEL_GLYPHS } from '@/lib/pixel-glyph-data';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Rich prompt editor with inline `@`-reference chips (AtlasCloud-style).
 *
 * The chips are pure UI sugar: on serialize they collapse back to plain text
 * tokens `@image1 / @video1 / @audio1` (1-based, in upload order), which is what
 * the Seedance backend resolves to the Nth reference in the ordered arrays. So
 * the editor's output is just a string — the existing /v1/jobs payload is
 * unchanged. `data-testid="prompt"` stays on the editable element so Playwright
 * `fill()` (which supports contenteditable) keeps working.
 */

export interface RefItem {
  token: string; // e.g. "@image2"
  kind: 'image' | 'video' | 'audio';
  url: string;
  label: string; // "image2"
}

const TOKEN_RE = /@(?:image|video|audio)\d+/g;

function buildRefs(images: string[], videos: string[], audios: string[]): RefItem[] {
  const out: RefItem[] = [];
  images.forEach((url, i) =>
    out.push({ token: `@image${i + 1}`, kind: 'image', url, label: `image${i + 1}` }),
  );
  videos.forEach((url, i) =>
    out.push({ token: `@video${i + 1}`, kind: 'video', url, label: `video${i + 1}` }),
  );
  audios.forEach((url, i) =>
    out.push({ token: `@audio${i + 1}`, kind: 'audio', url, label: `audio${i + 1}` }),
  );
  return out;
}

export function PromptEditor({
  value,
  onChange,
  images,
  videos,
  audios,
  placeholder,
  maxLength = 8000,
  minHeight = 120,
  fill = false,
}: {
  value: string;
  onChange: (text: string) => void;
  images: string[];
  videos: string[];
  audios: string[];
  placeholder?: string;
  maxLength?: number;
  /** Min height of the editable area — the hero prompt passes a taller value. */
  minHeight?: number;
  /** Fill mode — the editable flex-grows to fill its parent (no min/max cap), so
   *  the prompt absorbs the dock's slack and the dock never needs to scroll. */
  fill?: boolean;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  // Last value we serialized out — guards against React re-writing the DOM
  // (and nuking the caret) on every keystroke. We only re-render the DOM from
  // `value` when it changed externally (e.g. a preset was applied).
  const lastSerialized = useRef<string>('');
  const [menuOpen, setMenuOpen] = useState(false);
  // When set (via a chip's ▾), the next picker choice REPOINTS that chip
  // instead of inserting a new one at the caret.
  const replaceChipRef = useRef<HTMLElement | null>(null);

  const refs = buildRefs(images, videos, audios);
  const refByToken = (t: string) => refs.find((r) => r.token === t) ?? null;

  /** Build a non-editable chip element for a token. */
  const makeChip = useCallback(
    (token: string): HTMLElement => {
      const ref = refByToken(token);
      const chip = document.createElement('span');
      chip.setAttribute('contenteditable', 'false');
      chip.dataset.token = token;
      chip.className =
        'mention-chip inline-flex select-none items-center gap-1 rounded-[var(--radius-xs)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-1.5 py-0.5 align-middle font-mono text-[13px] text-[color:var(--color-fg)]';
      if (ref?.kind === 'image' && ref.url) {
        const img = document.createElement('img');
        img.src = ref.url;
        img.className = 'h-4 w-4 rounded-[var(--radius-xs)] object-cover';
        chip.appendChild(img);
      }
      const label = document.createElement('span');
      label.textContent = ref ? ref.label : token.slice(1);
      chip.appendChild(label);
      // reassign affordance — the `expand` pixel glyph (SPEC 06-05), built as inline
      // SVG since this chip is imperative DOM; click opens the picker to repoint it.
      const swap = document.createElementNS(SVG_NS, 'svg');
      swap.setAttribute('data-chip-swap', '1');
      swap.setAttribute('viewBox', '0 0 7 7');
      swap.setAttribute('width', '11');
      swap.setAttribute('height', '11');
      swap.setAttribute('fill', 'currentColor');
      swap.setAttribute('shape-rendering', 'crispEdges');
      swap.setAttribute('role', 'button');
      swap.setAttribute('aria-label', 'Изменить референс');
      swap.setAttribute(
        'class',
        'ml-0.5 inline-block shrink-0 cursor-pointer align-middle text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]',
      );
      for (const [x, y] of PIXEL_GLYPHS.expand) {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', '1');
        rect.setAttribute('height', '1');
        swap.appendChild(rect);
      }
      chip.appendChild(swap);
      return chip;
    },
    // refs identity changes when media changes; rebuild closure
    [images, videos, audios], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** Render the editor DOM from a plaintext value (tokenized). */
  const renderFromValue = useCallback(
    (text: string) => {
      const el = elRef.current;
      if (!el) return;
      el.innerHTML = '';
      let last = 0;
      text.replace(TOKEN_RE, (m, idx: number) => {
        if (idx > last) el.appendChild(document.createTextNode(text.slice(last, idx)));
        el.appendChild(makeChip(m));
        last = idx + m.length;
        return m;
      });
      if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
      lastSerialized.current = text;
    },
    [makeChip],
  );

  /** Walk the DOM → plain text with `@token` for chips. */
  const serialize = useCallback((): string => {
    const el = elRef.current;
    if (!el) return '';
    let out = '';
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? '';
      else if (n.nodeName === 'BR') out += '\n';
      else {
        const e = n as HTMLElement;
        if (e.dataset?.token) out += e.dataset.token;
        else out += e.textContent ?? '';
      }
    });
    return out;
  }, []);

  // External value sync (preset applied / reset): only when truly different.
  useEffect(() => {
    if (value !== lastSerialized.current) renderFromValue(value);
  }, [value, renderFromValue]);

  function emit() {
    const text = serialize().slice(0, maxLength);
    lastSerialized.current = text;
    onChange(text);
  }

  function insertChipAtCaret(token: string) {
    const el = elRef.current;
    if (!el) return;
    const sel = window.getSelection();
    const chip = makeChip(token);
    const space = document.createTextNode(' ');
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      // Remove the trigger "@" immediately before the caret, if present.
      try {
        range.setStart(range.startContainer, Math.max(0, range.startOffset - 1));
        if (range.toString() === '@') range.deleteContents();
        else range.collapse(false);
      } catch {
        /* ignore */
      }
      range.insertNode(space);
      range.insertNode(chip);
      range.setStartAfter(space);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      el.appendChild(chip);
      el.appendChild(space);
    }
    setMenuOpen(false);
    el.focus();
    emit();
  }

  /** Insert a run of plain text at the caret, turning any `@image1 / @video1 /
   *  @audio1` tokens it contains into chips (same tokenization as
   *  renderFromValue). Used on paste so a pasted prompt that mentions
   *  `@image1` attaches the reference chip instead of dropping literal text. */
  function insertTokenizedAtCaret(text: string) {
    const el = elRef.current;
    if (!el) return;
    const frag = document.createDocumentFragment();
    let last = 0;
    text.replace(TOKEN_RE, (m, idx: number) => {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      frag.appendChild(makeChip(m));
      last = idx + m.length;
      return m;
    });
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    const lastNode = frag.lastChild;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(frag);
      if (lastNode) {
        range.setStartAfter(lastNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      el.appendChild(frag);
    }
    el.focus();
    emit();
  }

  /** Repoint an existing chip to a different reference (the ▾ action). */
  function replaceChip(token: string) {
    const chip = replaceChipRef.current;
    replaceChipRef.current = null;
    setMenuOpen(false);
    if (!chip) return;
    chip.replaceWith(makeChip(token));
    emit();
  }

  const isEmpty = value.trim().length === 0;

  return (
    <div className={'relative ' + (fill ? 'flex min-h-0 flex-1 flex-col' : '')}>
      <div
        ref={elRef}
        data-testid="prompt"
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        contentEditable
        suppressContentEditableWarning
        onPaste={(e) => {
          // Paste as PLAIN text. A contenteditable otherwise keeps the source's
          // rich markup (its font / colour / inline styles), so pasted text
          // renders in a different font+colour than the editor — and pollutes
          // serialize(). Strip it: insert only text/plain at the caret.
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          if (!text) return;
          // If the pasted prompt mentions references (`@image1` …), tokenize it
          // so each mention becomes its attached chip instead of literal text.
          TOKEN_RE.lastIndex = 0;
          if (TOKEN_RE.test(text)) {
            insertTokenizedAtCaret(text);
            return;
          }
          // Plain text (no mentions): keep native caret + undo via execCommand;
          // falls back to a manual range
          // insert if unavailable.
          const ok = document.execCommand('insertText', false, text);
          if (!ok) {
            const sel = window.getSelection();
            if (sel && sel.rangeCount) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              const node = document.createTextNode(text);
              range.insertNode(node);
              range.setStartAfter(node);
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
          emit();
        }}
        onInput={(e) => {
          if ((e.nativeEvent as InputEvent).data === '@') setMenuOpen(true);
          emit();
        }}
        onClick={(e) => {
          // ▾ on a chip → open the picker in "repoint this chip" mode.
          const swap = (e.target as HTMLElement).closest?.('[data-chip-swap]');
          if (swap) {
            const chip = (swap as HTMLElement).closest('[data-token]') as HTMLElement | null;
            if (chip) {
              replaceChipRef.current = chip;
              setMenuOpen(true);
            }
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            replaceChipRef.current = null;
            setMenuOpen(false);
          }
        }}
        style={fill ? undefined : { minHeight }}
        className={
          // Prompt is the hero input: suppress the global brutalist :focus-visible
          // accent ring here only (it reads as an unwanted violet border on the
          // big field). focus-visible variant out-specifies the global rule in
          // globals.css; a11y ring stays everywhere else.
          'seed-scroll w-full overflow-auto bg-transparent px-4 py-4 text-[15px] leading-relaxed text-[color:var(--color-fg)] outline-none focus:outline-none focus-visible:outline-none [&_*]:align-middle ' +
          (fill ? 'min-h-0 flex-1' : 'block max-h-72')
        }
      />
      {isEmpty && (
        <div className="pointer-events-none absolute left-4 top-4 text-[15px] leading-relaxed text-[color:var(--color-faint)]">
          {placeholder}
        </div>
      )}

      {menuOpen && refs.length > 0 && (
        <div className="seed-fade-up no-scrollbar absolute left-3 right-3 top-2 z-30 max-h-48 overflow-auto rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-1 shadow-[5px_5px_0_0_var(--color-shadow)]">
          <p className="eyebrow-mono px-2 py-1">
            {replaceChipRef.current ? 'Изменить референс' : 'Вставить ссылку на референс'}
          </p>
          {refs.map((r) => (
            <button
              key={r.token}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                if (replaceChipRef.current) replaceChip(r.token);
                else insertChipAtCaret(r.token);
              }}
              className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[13px] text-[color:var(--color-fg)] transition-colors hover:bg-[color:var(--color-surface2)]"
            >
              {r.kind === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={assetSrc(r.url)}
                  alt=""
                  className="h-6 w-6 rounded-[var(--radius-xs)] object-cover"
                />
              ) : (
                <span className="grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] text-[color:var(--color-faint)]">
                  {r.kind === 'video' ? <Film size={13} /> : <Music size={13} />}
                </span>
              )}
              <span className="font-medium">{r.label}</span>
            </button>
          ))}
        </div>
      )}
      {menuOpen && refs.length === 0 && (
        <div className="seed-fade-up absolute left-3 right-3 top-2 z-30 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 py-2 text-[13px] text-[color:var(--color-muted-foreground)] shadow-[5px_5px_0_0_var(--color-shadow)]">
          Сначала добавь референсы (изображения / видео / аудио) ниже.
        </div>
      )}
    </div>
  );
}
