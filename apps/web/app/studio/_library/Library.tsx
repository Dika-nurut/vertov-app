// Library (Zone: Body left side) — the 56px IconRail switcher + the 280px
// library panel it drives (Media / Filters / Audio / Effects / Transitions /
// Text / Captions). Extracted VERBATIM from StudioClient (§C continuation);
// purely presentational — the active section + every panel's handlers arrive as
// props. Each panel keeps its own imports.
'use client';

import { RAIL_ITEMS, RAIL_ACTIVE } from '../_model';
import type { TClip, TAudio, Transition, StudioClip, RenderHistoryItem, TText } from '../_model';
import type { CaptionEngine } from '../useStudioMedia';
import type { AsrProgress } from '../../../lib/local-asr/service';
import { FiltersPanel } from './FiltersPanel';
import { EffectsPanel } from './EffectsPanel';
import { TransitionsPanel } from './TransitionsPanel';
import { TextLibraryPanel } from './TextLibraryPanel';
import { AudioLibraryPanel } from './AudioLibraryPanel';
import { CaptionsPanel } from './CaptionsPanel';
import { MediaPanel } from './MediaPanel';

export function Library({
  libSection,
  setLibSection,
  dragOver,
  setDragOver,
  onDropFiles,
  importing,
  upload,
  clips,
  timeline,
  addClip,
  addPip,
  history,
  libClip,
  patchClip,
  music,
  setMusic,
  voiceover,
  setVoiceover,
  addSfx,
  busy,
  uploadAudio,
  apiUrl,
  selectedClip,
  startTxDrag,
  addText,
  autoCaption,
  autoCaptionWords,
  engine,
  setEngine,
  localSupported,
  asrProgress,
  popMode,
  setPopMode,
  popWordCount,
  onClearPop,
  captioning,
  onSrtUpload,
}: {
  libSection: string;
  setLibSection: React.Dispatch<React.SetStateAction<string>>;
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  onDropFiles: (files: FileList | null) => void;
  importing: boolean;
  upload: { pct: number; name: string } | null;
  clips: StudioClip[];
  timeline: TClip[];
  addClip: (url: string, assetId?: string) => void;
  addPip: (url: string, assetId?: string) => void;
  history: RenderHistoryItem[];
  libClip: TClip | null;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  music: TAudio | null;
  setMusic: React.Dispatch<React.SetStateAction<TAudio | null>>;
  voiceover: TAudio | null;
  setVoiceover: React.Dispatch<React.SetStateAction<TAudio | null>>;
  /** Drop a sound-effect clip at the playhead. */
  addSfx: (url: string, name: string, durSec?: number) => void;
  busy: boolean;
  uploadAudio: (file: File) => Promise<TAudio | null>;
  apiUrl: string;
  selectedClip: TClip | null;
  startTxDrag: (t: Transition, e: React.PointerEvent) => void;
  addText: (opts?: {
    text?: string;
    position?: TText['position'];
    font?: TText['font'];
    sizeFrac?: number;
    fade?: boolean;
  }) => void;
  autoCaption: () => void;
  autoCaptionWords: () => void;
  engine: CaptionEngine;
  setEngine: (v: CaptionEngine) => void;
  localSupported: boolean;
  asrProgress: AsrProgress | null;
  popMode: boolean;
  setPopMode: (v: boolean) => void;
  popWordCount: number;
  onClearPop: () => void;
  captioning: boolean;
  onSrtUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <>
      {/* ── IconRail (72px) — library switcher; S4 fills the panels ── */}
      <nav
        aria-label="Библиотека"
        data-testid="studio-rail"
        className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto rounded-[var(--radius-md)] bg-[color:var(--color-surface)] py-3 shadow-[var(--offset-sm)] ring-1 ring-inset ring-[color:var(--color-line)]/10"
        style={{ gridArea: 'rail' }}
      >
        {RAIL_ITEMS.map((it) => {
          const active = RAIL_ACTIVE.has(it.id);
          const sel = libSection === it.id;
          const Icon = it.icon;
          return (
            <button
              key={it.id}
              type="button"
              disabled={!active}
              data-testid={`rail-${it.id}`}
              title={active ? it.label : `${it.label} — скоро`}
              aria-current={sel ? 'true' : undefined}
              onClick={() => active && setLibSection(it.id)}
              className={
                'press-inset grid h-[52px] w-[60px] place-content-center justify-items-center gap-1 rounded-[var(--radius-sm)] text-[11px] font-medium transition-colors ' +
                (sel
                  ? 'selected-neutral text-[color:var(--color-fg)]'
                  : active
                    ? 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]'
                    : 'text-[color:var(--color-faint)] opacity-50 hover:opacity-70 disabled:cursor-not-allowed')
              }
            >
              <Icon size={18} />
              {it.label}
            </button>
          );
        })}
      </nav>

      {/* ---------------- Library: source bin + audio lines ---------------- */}
      <aside
        className="min-h-0 space-y-6 overflow-y-auto rounded-[var(--radius-md)] bg-[color:var(--color-surface)] p-3 shadow-[var(--offset-sm)] ring-1 ring-inset ring-[color:var(--color-line)]/10"
        style={{ gridArea: 'library' }}
      >
        {libSection === 'media' && (
          <MediaPanel
            setDragOver={setDragOver}
            dragOver={dragOver}
            onDropFiles={onDropFiles}
            importing={importing}
            upload={upload}
            clips={clips}
            timeline={timeline}
            addClip={addClip}
            addPip={addPip}
            history={history}
          />
        )}
        {/* S4: Filters library — applies the per-clip `filter` (renders end-to-end). */}
        {libSection === 'filters' && <FiltersPanel clip={libClip} patchClip={patchClip} />}
        {/* S4: Audio library — music + voiceover lines (mixed over the timeline). */}
        {libSection === 'audio' && (
          <AudioLibraryPanel
            music={music}
            setMusic={setMusic}
            voiceover={voiceover}
            setVoiceover={setVoiceover}
            addSfx={addSfx}
            busy={busy}
            uploadAudio={uploadAudio}
            apiUrl={apiUrl}
          />
        )}
        {/* S4: Effects library — one-click looks over filter+grade (ffmpeg-realizable). */}
        {libSection === 'effects' && <EffectsPanel clip={libClip} patchClip={patchClip} />}
        {/* S4: Transitions library — applies the per-clip `transition` into the next clip. */}
        {libSection === 'transitions' && (
          <TransitionsPanel
            clip={selectedClip}
            patchClip={patchClip}
            onTilePointerDown={startTxDrag}
          />
        )}
        {/* S4: Text library — heading/body insert a text clip on the text track. */}
        {libSection === 'text' && <TextLibraryPanel addText={addText} timeline={timeline} />}
        {/* S6: Captions — auto (Deepgram) / manual / upload → caption blocks on
          the text track, burned into the render via drawtext. */}
        {libSection === 'captions' && (
          <CaptionsPanel
            autoCaption={autoCaption}
            autoCaptionWords={autoCaptionWords}
            engine={engine}
            setEngine={setEngine}
            localSupported={localSupported}
            asrProgress={asrProgress}
            popMode={popMode}
            setPopMode={setPopMode}
            popWordCount={popWordCount}
            onClearPop={onClearPop}
            timeline={timeline}
            captioning={captioning}
            addText={addText}
            onSrtUpload={onSrtUpload}
          />
        )}
      </aside>
    </>
  );
}
