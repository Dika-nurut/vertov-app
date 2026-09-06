'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Pencil, TriangleAlert, X } from '@/components/ui/icons';
import Link from 'next/link';
import { FountainEditor, type EditorSelection, type FountainEditorHandle } from '../FountainEditor';
import { classifyLines, SP_LABEL_RU, type SpClass } from '../fountain-cm';
import { buildSceneNav, moveScene, sceneAtOffset, type SceneNavItem } from '../scenario-nav';
import { useScript } from '../useScript';
import { useAssist } from '../useAssist';
import { useProjectPanel } from '../useProjectPanel';
import { RightRail } from './RightRail';
import { LeftPanel } from './LeftPanel';
import { Soderjanie } from './Soderjanie';
import { MirProekta } from './MirProekta';
import { ScenarioMobileDock } from './ScenarioMobileDock';
import { VersionsSheet } from './VersionsSheet';
import { ScenarioBoardHandoff } from './ScenarioBoardHandoff';
import { ScenarioStructurePanel } from './ScenarioStructurePanel';
import { ScenarioTimingPanel } from './ScenarioTimingPanel';
import { CANON_ACCRETION_ENABLED } from '../canon-flags';
import {
  canonCount,
  displayTitle,
  type Anchor,
  type AssistScope,
  type Script,
  type Thread,
} from '../_lib';
import { trackEvent, PlausibleEvent } from '../../_components/PlausibleEvents';

/** First scene heading in the text (drives the auto-title), or null. */
function firstSceneHeading(text: string): string | null {
  const lines = text.split('\n');
  const classes = classifyLines(text);
  for (let i = 0; i < lines.length; i++) {
    if (classes[i] === 'scene') {
      const raw = lines[i]!.trim();
      // Strip a forced-scene leading dot; keep RU/EN heading text otherwise.
      return (raw.startsWith('.') && !raw.startsWith('..') ? raw.slice(1) : raw).trim();
    }
  }
  return null;
}

function conflictExcerpt(local: string, server: string): [string, string] {
  const a = local.split('\n');
  const b = server.split('\n');
  let start = 0;
  while (start < a.length && a[start] === b[start]) start++;
  return [
    a.slice(Math.max(0, start - 2), start + 6).join('\n'),
    b.slice(Math.max(0, start - 2), start + 6).join('\n'),
  ];
}

export function ScenarioCanvas({
  initial,
  apiUrl,
  workspaceProjectId,
  isAnonymous = false,
}: {
  initial: Script;
  apiUrl: string;
  workspaceProjectId: string | null;
  isAnonymous?: boolean;
}) {
  const editorRef = useRef<FountainEditorHandle>(null);
  const autoTitledRef = useRef(false);
  const script = useScript(apiUrl, initial);
  const assist = useAssist(apiUrl, initial.id);
  const panel = useProjectPanel(apiUrl, initial.id, initial.bible);
  const projectCanonCount = canonCount(panel.notes, panel.materials);

  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [applyErrors, setApplyErrors] = useState<
    Record<string, 'rev_conflict' | 'anchor_detached'>
  >({});
  // Empty legacy scripts remain directly editable; new work enters through
  // /scenario/new so no four-button start menu or onboarding modal is needed.
  const [nonEmpty, setNonEmpty] = useState(initial.fountain.trim().length > 0);
  // Element under the caret, for the ribbon chip. Empty paper reads «СЦЕНА»
  // (a screenplay opens on a scene heading); real classification once typing.
  const [currentElement, setCurrentElement] = useState<SpClass>('scene');
  const ribbonElement: SpClass = nonEmpty ? currentElement : 'scene';
  // Live text + caret drive the СОДЕРЖАНИЕ navigator.
  const [docText, setDocText] = useState(initial.fountain);
  const [caret, setCaret] = useState(0);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const scenes = useMemo(() => buildSceneNav(docText), [docText]);
  const currentSceneIndex = sceneAtOffset(scenes, caret);

  useEffect(() => {
    trackEvent(PlausibleEvent.scenarioStartOpened, {
      format: initial.format,
      size_bucket: initial.fountain.trim() ? 'short' : 'empty',
    });
  }, [initial.format, initial.fountain]);

  useEffect(() => {
    if (!nonEmpty) editorRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the editor with crash-recovered text, if any.
  useEffect(() => {
    if (script.recovered) editorRef.current?.setDoc(script.recovered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script.recovered]);

  /** Editor change: persist and auto-title from scene 1. */
  const onEditorChange = useCallback(
    (text: string) => {
      script.onEditorChange(text);
      setDocText(text);
      setNonEmpty(text.trim().length > 0);
      // Auto-title: first scene heading becomes the working title until the
      // writer renames (§1). Fires once (ref-guarded), folded into the next
      // autosave — no separate metadata PUT racing the fountain save.
      if (!autoTitledRef.current && displayTitle(script.title, null) === '') {
        const heading = firstSceneHeading(text);
        if (heading) {
          autoTitledRef.current = true;
          script.setAutoTitle(heading);
        }
      }
    },
    [script],
  );

  const anchorFromSelection = useCallback(
    (sel: EditorSelection): Anchor => {
      return { from: sel.from, to: sel.to, rev: script.rev, quote: sel.quote.slice(0, 4_000) };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [script.rev],
  );

  /** Ask about the current selection (anchored note). */
  const askAnchored = useCallback(
    (question: string) => {
      if (!selection) return;
      void assist.ask({ question, anchor: anchorFromSelection(selection), scope: 'span' });
    },
    [selection, assist.ask, anchorFromSelection],
  );

  /** Ordinary chat is project scope; whole-script is an explicit composer choice. */
  const askChat = useCallback(
    (question: string, scope: AssistScope = 'project') => {
      void assist.ask({
        question,
        scope,
        ...(scope === 'scene' ? { sceneOrdinal: currentSceneIndex } : {}),
        ...(scope === 'script' ? { confirmFullScript: true } : {}),
        ...(assist.chatThread ? { threadId: assist.chatThread.id } : {}),
      });
    },
    [assist.ask, assist.chatThread, currentSceneIndex],
  );

  const quoteAsk = useCallback(
    (question: string, scope: AssistScope = selection ? 'span' : 'project') => {
      void assist.requestQuote({
        question,
        ...(selection ? { anchor: anchorFromSelection(selection) } : {}),
        scope,
        ...(scope === 'scene' ? { sceneOrdinal: currentSceneIndex } : {}),
        ...(scope === 'script' ? { confirmFullScript: true } : {}),
        ...(assist.chatThread && !selection ? { threadId: assist.chatThread.id } : {}),
      });
    },
    [assist.chatThread, assist.requestQuote, anchorFromSelection, currentSceneIndex, selection],
  );

  /** «Обсудить» a note (R4): a follow-up ask on the note's own thread. The API
   *  reuses + relocates the thread's anchor and re-reads мир проекта, so the
   *  reply refines the SAME fragment. Reply streams into the card (routed by
   *  stream.threadId in RightRail); lastProposal picks the newest → «Станет»
   *  updates in place and [Применить] applies the refined version. */
  const discussThread = useCallback(
    (threadId: string, question: string) => {
      assist.ask({ question, threadId });
    },
    [assist.ask],
  );

  /** Apply a thread's latest proposal as a local, undoable edit synced to the server rev. */
  const applyThread = useCallback(
    async (thread: Thread) => {
      const found = assist.lastProposal(thread);
      if (!found) return;
      const res = await assist.applyProposal(thread.id, script.rev);
      if (res.ok && res.rev !== undefined) {
        const before = found.proposal.before;
        const idx = script.fountainRef.current.indexOf(before);
        script.markSuppressNext(res.rev);
        if (idx !== -1) {
          editorRef.current?.replaceRange(idx, idx + before.length, found.proposal.after);
        } else {
          // The server applied it, but we can't locate the span locally — pull
          // the saved version instead of silently diverging (spec §6).
          const fresh = await script.reload();
          if (fresh) editorRef.current?.setDoc(fresh.fountain);
          setToast('Правка применена — фрагмент обновлён из сохранённой версии.');
        }
        trackEvent(PlausibleEvent.scenarioProposalApplied, { format: initial.format });
        setApplyErrors((e) => {
          const { [thread.id]: _drop, ...rest } = e;
          return rest;
        });
      } else if (res.error === 'rev_conflict' || res.error === 'anchor_detached') {
        setApplyErrors((e) => ({ ...e, [thread.id]: res.error as (typeof e)[string] }));
      }
    },
    [assist, script],
  );

  const revealAnchor = useCallback((thread: Thread) => {
    if (thread.anchor) editorRef.current?.reveal(thread.anchor.from);
  }, []);

  /** Quote-strip click (R4): show the fragment on the sheet and ghost-preview the
   *  proposed rewrite at its anchor. Falls back to a plain reveal when there's no
   *  locatable proposal, so the strip is never a dead click. */
  const previewInPlace = useCallback(
    (thread: Thread) => {
      if (!thread.anchor) return;
      const found = assist.lastProposal(thread);
      if (found) {
        const idx = script.fountainRef.current.indexOf(found.proposal.before);
        if (idx !== -1) {
          editorRef.current?.previewAt(idx, idx + found.proposal.before.length);
          return;
        }
      }
      editorRef.current?.reveal(thread.anchor.from);
    },
    [assist, script],
  );

  const onDetachSelection = useCallback(() => setSelection(null), []);

  // ---- СОДЕРЖАНИЕ navigator handlers ----
  const onJump = useCallback((offset: number) => editorRef.current?.reveal(offset), []);

  const onAddScene = useCallback(
    (after: SceneNavItem | null) => {
      const at = after ? after.to : docText.length;
      const before = docText.slice(0, at);
      const lead =
        before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const insert = `${lead}ИНТ. МЕСТО — ВРЕМЯ\n\n`;
      editorRef.current?.replaceRange(at, at, insert);
      editorRef.current?.reveal(at + lead.length);
    },
    [docText],
  );

  const onAddSynopsis = useCallback((scene: SceneNavItem) => {
    editorRef.current?.replaceRange(scene.headingEnd, scene.headingEnd, '\n= ');
    editorRef.current?.reveal(scene.headingEnd + 3);
  }, []);

  const onReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      const next = moveScene(docText, fromIndex, toIndex);
      if (next !== docText) editorRef.current?.replaceRange(0, docText.length, next);
    },
    [docText],
  );

  const dragProps = useCallback(
    (scene: SceneNavItem) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        setDragFrom(scene.index);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        if (dropIndex !== scene.index) setDropIndex(scene.index);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (dragFrom !== null && dragFrom !== scene.index) onReorder(dragFrom, scene.index);
        setDragFrom(null);
        setDropIndex(null);
      },
      isDropTarget: dropIndex === scene.index && dragFrom !== null && dragFrom !== scene.index,
    }),
    [dragFrom, dropIndex, onReorder],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-[color:var(--color-bg)] text-[color:var(--color-fg)]"
      data-testid="scenario-canvas"
    >
      <h1 className="sr-only">
        Редактор сценария: {displayTitle(script.title, null) || 'без названия'}
      </h1>
      {/* ---- in-canvas top bar ---- */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b-[2.5px] border-[color:var(--color-line)] px-4">
        {/* Owner ruling 2026-07-27: one back arrow per screen. Inside a project
            the OS bar already carries one, 46px above this — two arrows stacked
            is the defect this programme exists to remove. Standalone keeps it:
            there is no bar there and it is the only way back.
            Guests have no project list — back exits to the landing instead
            (guest-CJM decision, 2026-07-09). */}
        {!workspaceProjectId && (
          <Link
            href={isAnonymous ? '/' : '/scenario'}
            className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-2 py-1 text-[13px] text-[color:var(--color-muted-foreground)]"
            data-testid="scenario-back"
            aria-label={isAnonymous ? 'На главную' : 'Ко всем сценариям'}
          >
            ←
          </Link>
        )}
        <label className="group flex min-w-0 flex-1 items-center gap-1.5">
          <input
            value={displayTitle(script.title, null)}
            onChange={(e) => script.setTitle(e.target.value)}
            placeholder="Без названия"
            className="min-w-0 flex-1 bg-transparent font-semibold outline-none placeholder:text-[color:var(--color-muted-foreground)]"
            data-testid="scenario-title"
            aria-label="Название сценария"
          />
          <span
            aria-hidden
            className="shrink-0 text-[13px] text-[color:var(--color-muted-foreground)] opacity-40 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <Pencil size={12} aria-hidden />
          </span>
        </label>
        <ExportMenu
          exportUrl={(f) => `${apiUrl}/v1/scripts/${initial.id}/export?format=${f}`}
          onExport={() => trackEvent(PlausibleEvent.scenarioExported, { format: initial.format })}
        />
        <ScenarioBoardHandoff
          apiUrl={apiUrl}
          scriptId={initial.id}
          workspaceProjectId={workspaceProjectId}
          saveNow={script.saveNow}
        />
      </header>

      {/* ---- conflict banner (multi-tab 409) ---- */}
      {script.status === 'conflict' && (
        <div
          className="border-b-[2.5px] border-[color:var(--color-destructive)] bg-[color:var(--color-surface)] px-4 py-3 text-[13px]"
          data-testid="scenario-conflict"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>Другая вкладка сохранила новую версию. Автослияние текста отключено.</strong>
            <div className="flex gap-2">
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(
                    script.conflictLocalText ?? script.fountainRef.current,
                  )
                }
                className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-2 py-1"
                data-testid="scenario-conflict-copy-local"
              >
                Скопировать мой текст
              </button>
              <button
                onClick={async () => {
                  const fresh = await script.reload();
                  if (fresh) editorRef.current?.setDoc(fresh.fountain);
                }}
                className="sp-btn border-[2px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-2 py-1 font-semibold"
                data-testid="scenario-reload"
              >
                Открыть серверную версию
              </button>
            </div>
          </div>
          <div className="mt-2 grid max-h-36 grid-cols-1 gap-2 overflow-auto md:grid-cols-2">
            {conflictExcerpt(
              script.conflictLocalText ?? script.fountainRef.current,
              script.conflictServerText ?? '',
            ).map((text, index) => (
              <div
                key={index}
                className="border-[2px] border-[color:var(--color-line-soft)] bg-[color:var(--color-paper)] p-2"
              >
                <span className="font-mono text-[11px] font-bold uppercase">
                  {index === 0 ? 'Несохранённый текст' : 'Серверная версия'}
                </span>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{text || '—'}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- three columns ---- */}
      <div className="flex min-h-0 flex-1">
        <LeftPanel
          scenes={scenes}
          currentIndex={currentSceneIndex}
          notes={panel.notes}
          materials={panel.materials}
          canonCount={projectCanonCount}
          onJump={onJump}
          onAddScene={onAddScene}
          onAddSynopsis={onAddSynopsis}
          onReorder={onReorder}
          onAddNote={panel.addNote}
          onRemoveNote={panel.removeNote}
          onToggleNoteContext={panel.toggleNoteContext}
          onUploadFile={panel.uploadFile}
          onRemoveMaterial={panel.removeMaterial}
          onToggleMaterialContext={panel.toggleMaterialContext}
          persistenceError={panel.persistenceError}
          onRetryPersistence={panel.retryPersistence}
          dragProps={dragProps}
        />

        {/* screenplay sheet — reserve bottom room for the mobile dock (lg:0) */}
        <main className="relative flex min-w-0 flex-1 flex-col bg-[color:var(--color-bg)] pb-[72px] lg:pb-0">
          <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 px-4">
            <div className="relative flex h-full flex-col overflow-hidden border-x-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-paper)]">
              {initial.outline.beats.length > 0 && (
                <ScenarioStructurePanel
                  initialFormat={initial.format}
                  initialBrief={initial.brief}
                  initialOutline={initial.outline}
                  onSave={script.updateStructure}
                />
              )}
              {scenes.length > 0 && (
                <ScenarioTimingPanel
                  apiUrl={apiUrl}
                  scriptId={initial.id}
                  saveNow={script.saveNow}
                />
              )}
              <div className="min-h-0 flex-1">
                <FountainEditor
                  ref={editorRef}
                  initialDoc={initial.fountain}
                  onChange={onEditorChange}
                  onSelectionChange={setSelection}
                  onElementChange={setCurrentElement}
                  onCaret={setCaret}
                  persistKey={initial.id}
                />
              </div>
            </div>
          </div>

          {/* ---- element ribbon (chrome strip under the paper) ---- */}
          <ElementRibbon element={ribbonElement} status={script.status} />
        </main>

        <RightRail
          tiers={assist.tiers}
          tier={assist.tier}
          onTier={assist.setTier}
          threads={assist.threads}
          chatThread={assist.chatThread}
          stream={assist.stream}
          hasScenes={scenes.length > 0}
          selectionQuote={selection?.quote ?? null}
          onDetachSelection={onDetachSelection}
          onAskAnchored={askAnchored}
          onAskChat={askChat}
          onQuote={quoteAsk}
          onQuoteInvalidated={assist.invalidateQuote}
          quote={assist.quote}
          quoteLoading={assist.quoteLoading}
          currentSceneOrdinal={currentSceneIndex}
          onStop={assist.stop}
          onDiscuss={discussThread}
          onApply={applyThread}
          onDismiss={assist.dismissThread}
          onReveal={revealAnchor}
          onPreview={previewInPlace}
          onAddNote={panel.addNote}
          onOpenVersions={() => setVersionsOpen(true)}
          applyErrors={applyErrors}
          lastProposal={assist.lastProposal}
        />
      </div>

      {/* mobile-only access layer: dock → Содержание / Мир проекта / Редактор
          (the desktop LeftPanel/RightRail are `hidden lg:flex`). */}
      <ScenarioMobileDock
        scenesCount={scenes.length}
        canonCount={projectCanonCount}
        soderjanie={
          <Soderjanie
            scenes={scenes}
            currentIndex={currentSceneIndex}
            onJump={onJump}
            onAddScene={onAddScene}
            onAddSynopsis={onAddSynopsis}
            onReorder={onReorder}
            dragProps={dragProps}
          />
        }
        mir={
          <MirProekta
            notes={panel.notes}
            materials={panel.materials}
            canonCount={projectCanonCount}
            onAddNote={panel.addNote}
            onRemoveNote={panel.removeNote}
            onToggleNoteContext={panel.toggleNoteContext}
            onUploadFile={panel.uploadFile}
            onRemoveMaterial={panel.removeMaterial}
            onToggleMaterialContext={panel.toggleMaterialContext}
            persistenceError={panel.persistenceError}
            onRetryPersistence={panel.retryPersistence}
          />
        }
        editor={
          <RightRail
            mobile
            tiers={assist.tiers}
            tier={assist.tier}
            onTier={assist.setTier}
            threads={assist.threads}
            chatThread={assist.chatThread}
            stream={assist.stream}
            hasScenes={scenes.length > 0}
            selectionQuote={selection?.quote ?? null}
            onDetachSelection={onDetachSelection}
            onAskAnchored={askAnchored}
            onAskChat={askChat}
            onQuote={quoteAsk}
            onQuoteInvalidated={assist.invalidateQuote}
            quote={assist.quote}
            quoteLoading={assist.quoteLoading}
            currentSceneOrdinal={currentSceneIndex}
            onStop={assist.stop}
            onDiscuss={discussThread}
            onApply={applyThread}
            onDismiss={assist.dismissThread}
            onReveal={revealAnchor}
            onPreview={previewInPlace}
            onAddNote={panel.addNote}
            onOpenVersions={() => setVersionsOpen(true)}
            applyErrors={applyErrors}
            lastProposal={assist.lastProposal}
          />
        }
      />

      {toast && (
        <div
          className="fixed bottom-[84px] left-1/2 z-50 -translate-x-1/2 border-[2.5px] border-[color:var(--color-accent2)] bg-[color:var(--color-surface)] px-4 py-2 text-[13px] shadow-[4px_4px_0_0_var(--color-shadow)] lg:bottom-4"
          data-testid="scenario-toast"
          onAnimationEnd={() => setToast(null)}
        >
          {toast}
          <button
            onClick={() => setToast(null)}
            aria-label="Закрыть"
            className="sp-btn-ghost ml-3 px-1 text-[color:var(--color-muted-foreground)]"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      )}

      {versionsOpen && (
        <VersionsSheet
          apiUrl={apiUrl}
          scriptId={initial.id}
          onClose={() => setVersionsOpen(false)}
          onRestored={async () => {
            const fresh = await script.reload();
            if (fresh) editorRef.current?.setDoc(fresh.fountain);
            setVersionsOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** «Экспорт» — a menu, PDF first (spec §7); all four formats exist server-side. */
function ExportMenu({
  exportUrl,
  onExport,
}: {
  exportUrl: (format: string) => string;
  onExport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const items: [string, string, string][] = [
    ['pdf', 'PDF', 'для печати и питчинга'],
    ['fdx', 'Final Draft', '.fdx'],
    ['fountain', 'Fountain', '.fountain'],
    ['txt', 'Текст', '.txt'],
  ];
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="sp-btn border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 py-1.5 text-[13px] font-semibold"
        data-testid="scenario-export"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-1.5">
          Экспорт
          <ChevronDown size={12} aria-hidden />
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div
            className="absolute right-0 top-full z-40 mt-1 w-56 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] shadow-[5px_5px_0_0_var(--color-shadow)]"
            data-testid="scenario-export-menu"
            role="menu"
          >
            {items.map(([fmt, label, hint]) => (
              <a
                key={fmt}
                href={exportUrl(fmt)}
                onClick={() => {
                  onExport();
                  setOpen(false);
                }}
                data-testid={`scenario-export-${fmt}`}
                className="sp-btn-ghost flex items-baseline justify-between gap-3 border-b-[2px] border-[color:var(--color-line-soft)] px-3 py-2 last:border-b-0"
                role="menuitem"
              >
                <span className="text-[13px] font-semibold text-[color:var(--color-fg)]">
                  {label}
                </span>
                <span className="font-mono text-[11px] tracking-wide text-[color:var(--color-muted-foreground)]">
                  {hint}
                </span>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Chrome strip under the paper: current element + Tab/Enter hints + save status. */
function ElementRibbon({ element, status }: { element: SpClass; status: string }) {
  const save: Record<string, { label: ReactNode; cls: string }> = {
    saved: {
      label: (
        <span className="inline-flex items-center gap-1">
          <Check size={12} aria-hidden />
          СОХРАНЕНО
        </span>
      ),
      cls: 'text-[color:var(--color-positive)]',
    },
    dirty: { label: '• НЕ СОХРАНЕНО', cls: 'text-[color:var(--color-muted-foreground)]' },
    saving: { label: '… СОХРАНЯЮ', cls: 'text-[color:var(--color-muted-foreground)]' },
    conflict: {
      label: (
        <span className="inline-flex items-center gap-1">
          <TriangleAlert size={12} aria-hidden />
          КОНФЛИКТ
        </span>
      ),
      cls: 'text-[color:var(--color-accent2)]',
    },
    error: {
      label: (
        <span className="inline-flex items-center gap-1">
          <TriangleAlert size={12} aria-hidden />
          ОШИБКА
        </span>
      ),
      cls: 'text-[color:var(--color-destructive)]',
    },
  };
  const s = save[status] ?? save.saved!;
  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div
        className="flex items-center gap-3 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 py-2"
        data-testid="scenario-ribbon"
      >
        <span
          className="border-[2px] border-[color:var(--color-line)] bg-[color:var(--color-fg)] px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-widest text-[color:var(--color-bg)]"
          data-testid="scenario-ribbon-element"
        >
          {SP_LABEL_RU[element]}
        </span>
        <span className="hidden font-mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted-foreground)] sm:inline">
          ENTER — новая строка · TAB — исправить тип строки
        </span>
        <span
          className={`ml-auto font-mono text-[11px] tracking-widest ${s.cls}`}
          data-testid="scenario-save-status"
        >
          {s.label}
        </span>
      </div>
    </div>
  );
}
