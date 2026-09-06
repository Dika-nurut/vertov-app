'use client';

import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  NodeResizer,
  Position,
  getBezierPath,
  useReactFlow,
  useStore,
  useUpdateNodeInternals,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Cpu,
  FileText,
  GripVertical,
  Image as ImageIcon,
  Loader2,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Star,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from '@/components/ui/icons';
import type { ModelRow } from '../../generate/GenerateClient';
import { Switch } from '@/components/ui/switch';
import { NodeMenu } from './NodeMenu';
import { assetSrc } from '@/lib/asset-src';
import {
  BOARD_NODE_REGISTRY,
  boardInputPort,
  boardNodeDefaultData,
  boardOutputPort,
  boardImageQualityIsVendorWord,
  boardImageQualityLabel,
  PROMPT_STUDIO_CREDITS,
  PROMPT_STUDIO_BRIEF_CHAR_LIMIT,
  resolveBoardModelContract,
  validateBoardConnections,
  validateBoardConnectionShape,
  type BoardAiPromptData,
  type BoardCastData,
  type BoardGenerateData,
  type BoardMediaData,
  type BoardNode,
  type BoardNodeType,
  type BoardNoteData,
  type BoardTextData,
  type BoardFrameData,
  type BoardPromptData,
  type BoardSceneData,
  type BoardSemanticPayload,
} from '@seed/shared/board-contract';
import type { ResolvedAsset } from '@/lib/asset-lifecycle';
import { AssetLifecycleNotice } from '../../_components/AssetLifecycleNotice';
import type {
  BoardConnectionRole,
  BoardEdgeDiagnostic,
  BoardTargetDiagnostic,
} from '@seed/shared/board-diagnostics';
import {
  DURATION_MAX,
  DURATION_MIN,
  imageAspectsFor,
  imageQualitiesFor,
  modelsForMode,
  nodeEstimateRequest,
  resolveImageSettings,
  resolveVideoSettings,
  videoAspectsFor,
  videoDurationsFor,
  videoResolutionsFor,
  type NodeSettings,
} from '../../../lib/node-settings';
import { isModelLocked, tierUpsellLabel, TIER_LABEL } from '../../../lib/model-tier';
import { modelDisplayName } from '../../../lib/models';
import { estimatePriceToShow, hasKnownJobEstimate, useJobEstimate } from '@/lib/useJobEstimate';
import {
  boardQuoteKey,
  wiredImageRefs,
  wiredVideoRefUrls,
  type BoardQuoteNodeLike,
  type WiredImageRefs,
} from '@/lib/board-quote';
import { boardBatchCost } from '../../../lib/board-generation-batch';
import {
  MAX_MOVES,
  SHOT_COLOR_TEMP,
  SHOT_ENERGY,
  SHOT_GENRE,
  SHOT_LENSES,
  SHOT_LIGHT,
  SHOT_MOVES,
  SHOT_SIZES,
  effectiveMoves,
  toggleMove,
  type ShotGrammar,
} from '../../../lib/film-grammar';
import {
  characterReferenceSupport,
  identityRefQuality,
  shotsUsingCharacter,
} from '../../../lib/identity';
import {
  CAST_KIND_LABEL,
  CAST_KIND_LABEL_GENITIVE,
  CAST_NODE_LABEL,
  SCENE_OBJECT_KIND_LABEL,
} from '../../../lib/cast';
import { edgePayloadType, PAYLOAD_LABEL } from '../../../lib/edge-payload';
import { buildSceneContext } from '@seed/shared/scene-context';
import { imageHandleIndex, referenceImageHandleIndex, refSlotCount } from '../../../lib/ref-ports';
import { isBoardConnectionTargetOccupied } from '../../../lib/board-connection-policy';
import { BOARD_NODE_H, BOARD_NODE_W } from '../../../lib/board-node-layout';
import type { ShotEdgeLike, ShotNodeLike } from '../../../lib/shot-list';
import {
  imageMentionsInText,
  insertMentionToken,
  mentionQueryBeforeCursor,
  type RefMention,
} from '../../../lib/ref-mentions';

type PromptData = BoardPromptData;
type AiTextModel = BoardAiPromptData['model'];
type AiPromptData = BoardAiPromptData;
type NoteData = BoardNoteData;
type TextData = BoardTextData;
type FrameData = BoardFrameData;
type SceneData = BoardSceneData;
type MediaData = BoardMediaData;
type CastData = BoardCastData;
type GenerateData = BoardGenerateData;
type AnyData =
  | PromptData
  | AiPromptData
  | NoteData
  | TextData
  | FrameData
  | SceneData
  | MediaData
  | GenerateData
  | CastData;
type CatalogItem = {
  icon:
    | 'video'
    | 'image'
    | 'prompt'
    | 'aiprompt'
    | 'media'
    | 'note'
    | 'text'
    | 'frame'
    | 'scene'
    | 'character'
    | 'location';
};

export const BOARD_OVERVIEW_ZOOM = 0.45;

function imageQualityAxisLabel(qualities: readonly string[]): string {
  return qualities.some(boardImageQualityIsVendorWord) ? 'Качество' : 'Разрешение';
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

/* ------------------------------------------------------------------ *
 *  Graph actions context — custom nodes call back into the board.
 * ------------------------------------------------------------------ */
export interface GraphActions {
  /** API base URL — needed by nodes that quote `/v1/jobs/estimate` directly. */
  apiUrl: string;
  models: ModelRow[];
  /** The viewer's LIVE plan tier — models above it render locked with an upsell
   *  (P-B2/DEC-3 parity with /generate). null = nothing entitles them today. */
  planTier: string | null;
  /** Where that upsell points: /pricing, or /settings/billing for an elapsed
   *  subscriber whose lifecycle row needs recovery before a new checkout
   *  (W0/D6). */
  lockedCtaHref: string;
  /** Resolve the model a node actually uses (persisted pick or mode-default) —
   *  used to drive capability-aware settings controls (S4). */
  modelForNode: (d: GenerateData) => ModelRow | undefined;
  requestModelChange: (id: string, modelId: string) => void;
  diagnosticForNode: (id: string) => BoardTargetDiagnostic | undefined;
  edgeIssuesFor: (id: string) => readonly BoardEdgeDiagnostic[];
  edgeRoleFor: (id: string) => BoardConnectionRole | undefined;
  repairNodeSettings: (id: string) => void;
  swapFrameInputs: (id: string) => void;
  patch: (id: string, data: Partial<AnyData>) => void;
  selectResult: (id: string, url: string) => void;
  remove: (id: string) => void;
  requestFrameDelete: (id: string) => void;
  removeEdge: (id: string) => void;
  run: (id: string) => void;
  running: (id: string) => boolean;
  toTray: (id: string) => void;
  upload: (file: File) => Promise<string | null>;
  /** Consistency bridge (S4): re-wire a video shot's refs through a new
   * Seedream keyframe node whose render becomes the shot's first frame. */
  makeKeyframe: (id: string) => void;
  /** AI-промпт: draft a generation prompt from the node's brief via the
   * chosen text model (Claude Sonnet 5 / GPT-5.6 Terra / Gemini 3 Flash). */
  draftPrompt: (id: string) => void;
  extractSceneObjects: (id: string) => Promise<{
    objects: { kind: 'person' | 'place' | 'thing'; name: string }[];
    sourceTruncated: boolean;
    error?: string;
  }>;
  /** Prompt/AI-prompt @image1/@video1 registry from the connected shot refs. */
  mentionsForPrompt: (id: string) => RefMention[];
  /** Scene source → first editable prompt + image-shot workflow. Never runs it. */
  createShotFromScene: (id: string) => void;
  promoteSceneObject: (sceneId: string, index: number) => void;
  unlinkSceneObject: (sceneId: string, index: number) => void;
  removeSceneObject: (sceneId: string, index: number) => void;
  focusBoardNode: (id: string) => void;
  sceneSourceHref: (data: SceneData) => string | null;
  sceneShotCount: (sceneId: string) => number;
  /** Reference-pack edits answer for the shots the card already feeds. */
  addCastStill: (castId: string, url: string) => void;
  removeCastStill: (castId: string, index: number) => void;
  /** Spawn the editable prompt + image shot owned by this cast card. */
  generateCastReference: (id: string) => void;
  /** Append the selected result of an owned image shot to its cast card. */
  appendCastReference: (id: string) => void;
  assetLifecycleFor: (assetId: string | undefined) => ResolvedAsset | undefined;
  /** The URL a run would send for a gallery-identified media node, or undefined
   *  while its asset has not resolved (the runner drops it too). */
  resolveQuoteAssetUrl: (assetId: string) => string | undefined;
  /** Publish the price this node is DISPLAYING, tagged with `boardQuoteKey` of
   *  the request it prices, so the runner can bind the submit to it
   *  (`expectedCost`) only while the two describe the same request. Called only
   *  for a settled quote. */
  publishNodeQuote: (id: string, key: string, cost: number) => void;
  /** Bumped by the runner when a submit is refused with 409 `quote_stale`:
   *  none of the node's own inputs changed, so the badge needs a nudge to pull
   *  the new number. */
  quoteRefreshFor: (id: string) => number;
}
export const BoardGraphContext = createContext<GraphActions | null>(null);
const useGraph = () => {
  const c = useContext(BoardGraphContext);
  if (!c) throw new Error('no graph ctx');
  return c;
};

/* ------------------------------------------------------------------ *
 *  Ports — TYPED handles, colour-coded by payload (per the Runway
 *  playbook): text=green, image=blue, video=violet. Labels reveal on
 *  select (selection-driven chrome); required inputs carry a `*`.
 * ------------------------------------------------------------------ */
type PortType = 'text' | 'image' | 'video' | 'scene';
const PORT_COLOR: Record<PortType, string> = {
  text: 'var(--color-port-text)', // prompt / text
  image: 'var(--color-port-image)', // image / reference
  video: 'var(--color-port-video)', // video
  scene: 'var(--color-accent)', // scene context
};
// rgb channels of the same colours — fed to the handle as a CSS var so the
// resting + hover styling (glow/ring/specular) lives in CSS and `:hover` can
// light the key up without moving it.
const PORT_RGB: Record<PortType, string> = {
  text: '132, 209, 138',
  image: '111, 182, 234',
  video: '199, 155, 255',
  scene: '190, 242, 100',
};

function InPort({
  id,
  label,
  kind,
  top,
  required,
  show,
  invalid,
  reason,
}: {
  id: string;
  label: string;
  kind: PortType;
  top: number | string;
  required?: boolean;
  show?: boolean;
  invalid?: boolean;
  reason?: string | undefined;
}) {
  const c = invalid ? 'var(--color-destructive)' : PORT_COLOR[kind];
  const rgb = invalid ? '255, 82, 71' : PORT_RGB[kind];
  return (
    <>
      <Handle
        id={id}
        type="target"
        position={Position.Left}
        className="seed-port"
        data-invalid={invalid ? 'true' : 'false'}
        style={{ top, ['--port-rgb']: rgb } as React.CSSProperties}
        title={reason ?? label}
      />
      <span
        className={`pointer-events-none absolute z-10 -translate-x-full -translate-y-1/2 whitespace-nowrap rounded-[var(--radius-xs)] border-[1.5px] px-1.5 py-px font-mono text-[11px] font-bold uppercase tracking-wide transition-opacity ${show ? 'opacity-100' : 'opacity-0 group-hover/node:opacity-100'}`}
        style={{
          top,
          left: -8,
          color: c,
          background: `rgba(${rgb}, 0.13)`,
          borderColor: `rgba(${rgb}, 0.4)`,
        }}
      >
        {label}
        {required ? ' *' : ''}
      </span>
    </>
  );
}
function OutPort({
  id,
  label,
  kind,
  show,
}: {
  id: string;
  label: string;
  kind: PortType;
  show?: boolean;
}) {
  const c = PORT_COLOR[kind];
  return (
    <>
      <Handle
        id={id}
        type="source"
        position={Position.Right}
        className="seed-port"
        style={{ top: '50%', ['--port-rgb']: PORT_RGB[kind] } as React.CSSProperties}
        title={label}
      />
      <span
        className={`pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 whitespace-nowrap rounded-[var(--radius-xs)] border-[1.5px] px-1.5 py-px font-mono text-[11px] font-bold uppercase tracking-wide transition-opacity ${show ? 'opacity-100' : 'opacity-0 group-hover/node:opacity-100'}`}
        style={{
          left: 'calc(100% + 8px)',
          color: c,
          background: `rgba(${PORT_RGB[kind]}, 0.13)`,
          borderColor: `rgba(${PORT_RGB[kind]}, 0.4)`,
        }}
      >
        {label}
      </span>
    </>
  );
}

function broadPortType(payload: BoardSemanticPayload): PortType {
  if (payload.startsWith('text.')) return 'text';
  if (payload.startsWith('video.')) return 'video';
  if (payload.startsWith('scene.')) return 'scene';
  return 'image';
}

function RegistryOutPort({
  type,
  data,
  label,
  show,
}: {
  type: BoardNodeType;
  data: Record<string, unknown>;
  label: string;
  show?: boolean;
}) {
  const port = BOARD_NODE_REGISTRY[type].outputPorts(data)[0];
  if (!port) return null;
  return (
    <OutPort
      id={port.handle}
      label={label}
      kind={broadPortType(port.payloads[0]!)}
      show={show ?? false}
    />
  );
}

// Brutalist node shell — hard bone border-[1.5px] + sharp corners + a RESTRAINED hard
// offset shadow. A clear interaction ladder reads as PHYSICAL depth (each step
// lifts the card off its shadow): idle 3px → hover 4px + 1px lift → selected
// periwinkle border-[1.5px] + 5px → dragging (see .seed-node CSS) accent + 6px + 2px
// lift. `seed-node` is the CSS hook for the drag state (RF toggles `.dragging`
// on the wrapper). Hover utilities live on shellIdle so a selected card holds
// its grammar instead of also lifting.
const shell =
  'seed-node group/node rounded-[var(--radius-md)] border-[2.5px] bg-[color:var(--color-surface)] transition-[transform,border-color,box-shadow] duration-150 ease-out';
const shellSel = 'border-[color:var(--color-accent)] shadow-[5px_5px_0_0_var(--color-shadow)]';
const shellIdle =
  'border-[color:var(--color-line)] shadow-[3px_3px_0_0_var(--color-shadow)] hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0_0_var(--color-shadow)]';

// drag affordance for node headers. React Flow itself lets the whole widget move;
// interactive controls opt out with `nodrag`.
const DRAG = 'seed-drag cursor-grab active:cursor-grabbing';

/**
 * Wheel over a card's own content (prompt text, shot settings, lists) should
 * scroll THAT content instead of zooming the canvas — otherwise the only way to
 * read a long prompt is dragging its scrollbar at the card's edge.
 *
 * React Flow skips zooming inside `.nowheel`, so the class is toggled by whether
 * there is anything left to scroll: a short prompt still zooms the canvas, a
 * scrollable one takes the wheel. Spread the result onto the scrolling element.
 */
function useWheelScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const sync = useCallback(() => {
    const el = ref.current;
    if (el) el.classList.toggle('nowheel', el.scrollHeight > el.clientHeight + 1);
  }, []);
  // content grows and shrinks (typing, a result arriving) — re-measure per render
  useEffect(sync);
  return { ref, onPointerEnter: sync, onScroll: sync } as const;
}

export function withWholeNodeDrag<T extends Node>(node: T): T {
  const next = { ...node };
  delete next.dragHandle;
  return next;
}

// Per-node minimums LOCK the card so it can never shrink below the height its
// content needs — otherwise the fixed-min children (e.g. the generate preview's
// min-h-[150px]) overflow the border-[1.5px] when you drag the card to its smallest.
// Each call passes a floor that fits its own chrome (model bar + body + footer).
function Resizer({
  visible,
  minWidth = 200,
  minHeight = 120,
  maxWidth = 4_000,
  maxHeight = 4_000,
}: {
  visible: boolean;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
}) {
  return (
    <NodeResizer
      isVisible={visible}
      minWidth={minWidth}
      minHeight={minHeight}
      maxWidth={maxWidth}
      maxHeight={maxHeight}
      color="var(--color-accent)"
      // bigger, filled, bone-rimmed corner grips + a visible edge line so the
      // resize target is easy to find and grab (was a near-invisible 7px dot).
      handleStyle={{
        width: 12,
        height: 12,
        borderRadius: 2,
        background: 'var(--color-accent)',
        border: '1.5px solid var(--color-line)',
      }}
      lineStyle={{ borderColor: 'rgba(var(--accent-rgb),0.4)', borderWidth: 1.5 }}
    />
  );
}

function DragHitFrame() {
  const rail = 'seed-drag pointer-events-auto absolute cursor-grab active:cursor-grabbing';
  return (
    <div className="pointer-events-none absolute inset-0 z-[2]" aria-hidden="true">
      <div data-testid="node-drag-rail-left" className={`${rail} bottom-4 top-4 -left-2 w-3`} />
      <div data-testid="node-drag-rail-right" className={`${rail} bottom-4 top-4 -right-2 w-3`} />
      <div data-testid="node-drag-rail-bottom" className={`${rail} -bottom-2 left-4 right-4 h-3`} />
    </div>
  );
}

/* Floating node title — the SINGLE design for every widget's name: it sits ABOVE
 * the card (like the generate widget), is the drag handle (grip), and reveals a
 * remove on hover. No name/icon inside the card. */
function NodeTitle({
  id,
  label,
  testid,
  nodeType,
}: {
  id: string;
  label: string;
  testid?: string;
  nodeType?: BoardNodeType;
}) {
  const { remove, requestFrameDelete } = useGraph();
  return (
    <div
      data-testid={testid}
      className="seed-drag absolute bottom-full left-0 right-0 mb-1.5 flex h-7 cursor-grab items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 active:cursor-grabbing"
    >
      <GripVertical
        size={12}
        className="shrink-0 text-[color:var(--color-faint)] transition-colors group-hover/node:text-[color:var(--color-accent)]"
      />
      <span className="truncate font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-muted-foreground)] transition-colors group-hover/node:text-[color:var(--color-fg)]">
        {label}
      </span>
      <button
        type="button"
        onClick={() => (nodeType === 'frame' ? requestFrameDelete(id) : remove(id))}
        aria-label="Удалить"
        className="nodrag shrink-0 text-[color:var(--color-muted-foreground)] opacity-0 transition-opacity hover:text-destructive group-hover/node:opacity-100 touch:opacity-100"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

function MentionTextarea({
  value,
  onChange,
  mentions,
  className,
  placeholder,
  testid,
  maxLength,
}: {
  value: string;
  onChange: (next: string) => void;
  mentions: RefMention[];
  className: string;
  placeholder: string;
  testid: string;
  maxLength?: number;
}) {
  const wheel = useWheelScroll<HTMLTextAreaElement>();
  const mentionsWheel = useWheelScroll<HTMLDivElement>();
  const ref = wheel.ref;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<{ start: number; end: number; query: string } | null>(null);

  const updateActive = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (!el || mentions.length === 0) {
        setActive(null);
        return;
      }
      const cursor = el.selectionStart ?? 0;
      const q = mentionQueryBeforeCursor(el.value, cursor);
      setActive(q ? { start: q.start, end: cursor, query: q.query } : null);
    },
    [mentions.length],
  );

  const filtered = useMemo(() => {
    if (!active) return [];
    return mentions
      .filter((m) => {
        const q = active.query;
        return (
          q.length === 0 ||
          m.token.slice(1).toLowerCase().startsWith(q) ||
          m.label.toLowerCase().includes(q)
        );
      })
      .slice(0, 8);
  }, [active, mentions]);
  const imageMentions = imageMentionsInText(value, mentions);

  function pick(m: RefMention) {
    const el = ref.current;
    const end = active?.end ?? el?.selectionStart ?? value.length;
    const start = active?.start ?? end;
    const next = insertMentionToken(value, start, end, m.token);
    onChange(next.text);
    setActive(null);
    window.requestAnimationFrame(() => {
      const t = ref.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(next.cursor, next.cursor);
    });
  }

  return (
    <div ref={boxRef} className="relative flex min-h-0 flex-1 flex-col">
      <textarea
        {...wheel}
        value={value}
        data-testid={testid}
        onChange={(e) => {
          onChange(e.target.value);
          updateActive(e.target);
        }}
        onKeyUp={(e) => updateActive(e.currentTarget)}
        onClick={(e) => updateActive(e.currentTarget)}
        onSelect={(e) => updateActive(e.currentTarget)}
        onBlur={() => window.setTimeout(() => setActive(null), 120)}
        className={className}
        placeholder={placeholder}
        maxLength={maxLength}
      />
      {imageMentions.length > 0 && (
        <div
          data-testid={`${testid}-image-references`}
          className="nodrag mx-2 -mt-1 mb-2 flex flex-wrap gap-1.5"
        >
          {imageMentions.map(({ token, mention }) => (
            <span
              key={token}
              className={`flex max-w-full items-center gap-1 rounded-[var(--radius-xs)] border-[1.5px] py-0.5 pl-0.5 pr-1 font-mono text-[11px] font-bold ${
                mention
                  ? 'border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] text-[color:var(--color-muted-foreground)]'
                  : 'border-[color:var(--color-destructive)] text-[color:var(--color-destructive)]'
              }`}
            >
              {mention && (
                <img
                  src={assetSrc(mention.url)}
                  alt=""
                  className="h-5 w-5 shrink-0 rounded-[var(--radius-xs)] object-cover"
                />
              )}
              <span className="truncate">
                {mention ? `${token} · ${mention.label}` : `${token} · нет референса`}
              </span>
            </span>
          ))}
        </div>
      )}
      {/* Mention options in a viewport portal (NodeMenu): the old absolute
          list clipped against the canvas edge from inside the node. Same box
          (trigger-width, 8-row cap), same option testids. */}
      <NodeMenu
        anchorRef={boxRef}
        open={active !== null && filtered.length > 0}
        onClose={() => setActive(null)}
        testid={`${testid}-mentions`}
        className="glass-menu p-1.5"
        maxMenuHeight={192}
        divProps={{ ...mentionsWheel }}
      >
        {filtered.map((m) => (
          <button
            key={m.token}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              pick(m);
            }}
            className="nodrag flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-[color:var(--color-surface2)]"
          >
            <span
              className={`tnum shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide ${
                m.kind === 'video'
                  ? 'bg-violet-400/15 text-violet-200'
                  : 'bg-sky-400/15 text-sky-200'
              }`}
            >
              {m.token}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--color-fg)]">
              {m.label}
            </span>
          </button>
        ))}
      </NodeMenu>
    </div>
  );
}

/* ----------------------------- Prompt node ----------------------------- */
function PromptNodeDetail({ id, data, selected }: NodeProps) {
  const d = data as unknown as PromptData;
  const { patch, mentionsForPrompt } = useGraph();
  const mentions = mentionsForPrompt(id);
  return (
    <div
      className={`${shell} ${selected ? shellSel : shellIdle} seed-drag relative flex h-full w-full min-w-[240px] cursor-grab flex-col active:cursor-grabbing`}
    >
      <Resizer visible={selected} minWidth={200} minHeight={110} />
      <NodeTitle id={id} label="Промпт" testid="node-prompt-header" />
      <DragHitFrame />
      {/* cursor-text: the card shell is a drag handle (cursor-grab) and the
          textarea INHERITS that grab/grabbing hand, so placing the caret or
          selecting text showed a fist, not an I-beam (audit 2026-07-29). */}
      <MentionTextarea
        value={d.text}
        onChange={(text) => patch(id, { text })}
        mentions={mentions}
        className="nodrag m-2 min-h-[48px] w-[calc(100%-16px)] flex-1 cursor-text resize-none rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] p-2.5 text-[13px] leading-relaxed text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
        placeholder="Текст промпта…"
        testid="node-prompt-text"
      />
      <RegistryOutPort
        type="prompt"
        data={d as unknown as Record<string, unknown>}
        label="текст"
        show={selected}
      />
    </div>
  );
}

/* --------------------------- AI-prompt node ---------------------------
 * Write a brief, pick a text model, and it drafts a
 * generation prompt. Mirrors the generate widget: a model bar (pressable →
 * dropdown DOWN), a brief⇄result switch (auto-flips to the result while it
 * drafts), and a `текст` output that wires into a shot's prompt slot — the
 * payload lives in `text`, identical to PromptNode, so the run path reads it
 * with zero special-casing. */
const AI_TEXT_MODELS: { id: AiTextModel; label: string }[] = [
  { id: 'claude', label: 'Claude Sonnet 5' },
  { id: 'gpt', label: 'GPT-5.6 Terra' },
  { id: 'gemini', label: 'Gemini 3 Flash' },
];

function AiPromptNodeDetail({ id, data, selected }: NodeProps) {
  const d = data as unknown as AiPromptData;
  const { patch, draftPrompt, mentionsForPrompt } = useGraph();
  const mentions = mentionsForPrompt(id);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const aiModelBtnRef = useRef<HTMLButtonElement | null>(null);
  const resultWheel = useWheelScroll<HTMLDivElement>();
  const busy = d.status === 'running';
  const hasResult = Boolean(d.text && d.text.trim());
  const showResult = d.view !== 'brief' && (busy || hasResult);
  const model = AI_TEXT_MODELS.find((m) => m.id === (d.model ?? 'claude')) ?? AI_TEXT_MODELS[0]!;
  const wiredScene = useStore((state) => {
    const edge = state.edges.find(
      (candidate) => candidate.target === id && candidate.targetHandle === 'scene',
    );
    const node = edge ? state.nodeLookup.get(edge.source) : undefined;
    return node?.type === 'scene' ? (node.data as unknown as SceneData) : null;
  });
  const wiredSceneContext = wiredScene ? buildSceneContext(wiredScene) : '';
  const storedSceneContext = (d.sceneContext ?? '').trim();
  const visibleSceneContext = storedSceneContext || wiredSceneContext;
  const sceneChanged = Boolean(
    storedSceneContext && wiredSceneContext && storedSceneContext !== wiredSceneContext,
  );
  // The card's height is fixed, and the body's old 110px floor could not shrink,
  // so the scene-context block pushed «Создать» straight out through the bottom
  // edge — visible only in a browser, which is where this was caught. When the
  // block is on screen the body gives up its floor; with no block, nothing
  // changes for the cards that already exist.
  const bodyMinHeight = visibleSceneContext || sceneChanged ? 'min-h-[56px]' : 'min-h-[110px]';

  return (
    <div
      className={`${shell} ${selected ? shellSel : shellIdle} relative flex h-full w-full min-w-[240px] flex-col`}
    >
      <Resizer visible={selected} minWidth={220} minHeight={210} />
      <NodeTitle id={id} label="AI-промпт" testid="node-aiprompt-header" />
      <DragHitFrame />

      <InPort id="scene" label="сцена" kind="scene" top={54} show={selected} />

      {/* model bar — a real field (chip glyph + chevron) so it reads as a
          changeable selector; dropdown opens DOWN, inside the widget */}
      <div className="nodrag relative px-1.5 pt-1" onPointerDown={(e) => e.stopPropagation()}>
        <button
          data-testid="ai-model-trigger"
          ref={aiModelBtnRef}
          aria-haspopup="menu"
          aria-expanded={modelMenuOpen}
          disabled={busy}
          onClick={() => setModelMenuOpen((o) => !o)}
          className={
            'press-inset nodrag flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] border-2 bg-[color:var(--color-surface2)] px-2 py-1.5 text-left text-[13px] font-semibold text-[color:var(--color-fg)] transition-colors ' +
            (modelMenuOpen
              ? 'border-[color:var(--color-accent)]'
              : 'border-[color:var(--color-line-soft)] hover:border-[color:var(--color-accent)]')
          }
        >
          <Cpu size={13} className="shrink-0 text-[color:var(--color-faint)]" />
          <span className="min-w-0 flex-1 truncate">{model.label}</span>
          <ChevronDown
            size={13}
            className={
              'shrink-0 text-[color:var(--color-faint)] transition-transform ' +
              (modelMenuOpen ? 'rotate-180' : '')
            }
          />
        </button>
        {/* AI-model options in a viewport portal (NodeMenu) — same clip fix as
            the generate-node model menu. Three short rows, no natural cap. */}
        <NodeMenu
          anchorRef={aiModelBtnRef}
          open={modelMenuOpen}
          onClose={() => setModelMenuOpen(false)}
          className="glass-menu p-1.5"
        >
          <div className="space-y-0.5">
            {AI_TEXT_MODELS.map((m) => {
              const sel = model.id === m.id;
              return (
                <button
                  key={m.id}
                  data-testid={`ai-model-${m.id}`}
                  onClick={() => {
                    patch(id, {
                      model: m.id,
                      // A model change is a different paid request. Do not
                      // replay a claim created for the previous selector.
                      idempotencyKey: undefined,
                    } as Partial<AiPromptData>);
                    setModelMenuOpen(false);
                  }}
                  className={
                    'nodrag flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[13px] transition-colors ' +
                    (sel
                      ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                      : 'text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]')
                  }
                >
                  <span className="truncate">{m.label}</span>
                  {sel && (
                    <Check
                      size={11}
                      className="shrink-0 text-[color:var(--color-primary-foreground)]"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </NodeMenu>
      </div>

      {/* The scene-context block competes with the brief for a FIXED card
          height, so the body's floor drops while it is on screen. */}
      {(visibleSceneContext || sceneChanged) && (
        /* shrink-0 + a hard cap: this card is a fixed-height flex column, so an
           uncapped block here pushes «Создать» out through the bottom edge. The
           body below gives up its own height instead (see bodyMinHeight). */
        <div className="nodrag seed-scroll mx-1.5 mt-1.5 max-h-[88px] shrink-0 overflow-y-auto rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2.5 py-2">
          <div className="font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-faint)]">
            КОНТЕКСТ ИЗ СЦЕНЫ
            {!storedSceneContext && wiredSceneContext && (
              <span className="ml-1 text-[color:var(--color-accent)]">будет отправлено</span>
            )}
          </div>
          {visibleSceneContext && (
            <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--color-fg)]">
              {visibleSceneContext}
            </p>
          )}
          {sceneChanged && (
            <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              Сцена изменилась после фиксации контекста.
            </p>
          )}
        </div>
      )}

      {/* body — the brief you write, or the drafted result */}
      {showResult ? (
        <div
          {...resultWheel}
          data-testid="ai-result"
          onPointerDown={(e) => e.stopPropagation()}
          className={`nodrag seed-scroll relative mx-1.5 mt-1.5 flex-1 overflow-y-auto ${bodyMinHeight} rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] p-2.5 text-[11px] leading-relaxed text-[color:var(--color-fg)]`}
        >
          {busy ? (
            <span className="flex h-full w-full items-center justify-center">
              <Loader2 size={18} className="seed-spin text-[color:var(--color-accent)]" />
            </span>
          ) : (
            d.text
          )}
        </div>
      ) : (
        <MentionTextarea
          value={d.brief ?? ''}
          onChange={(brief) =>
            patch(id, {
              brief,
              // Editing the input changes the paid request identity. A lost
              // response can only be replayed while the brief is unchanged.
              idempotencyKey: undefined,
            } as Partial<AiPromptData>)
          }
          mentions={mentions}
          placeholder="Опишите идею — модель напишет промпт…"
          maxLength={PROMPT_STUDIO_BRIEF_CHAR_LIMIT}
          className={`nodrag mx-1.5 mt-1.5 w-[calc(100%-12px)] flex-1 resize-none ${bodyMinHeight}  rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] p-2.5 text-[11px] leading-relaxed text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]`}
          testid="ai-brief"
        />
      )}

      {/* controls — brief/result switch · draft/redraft */}
      <div
        data-testid="ai-footer-drag"
        className="seed-drag flex cursor-grab items-center gap-1.5 px-1.5 py-1.5 active:cursor-grabbing"
      >
        {showResult && hasResult && !busy && (
          <button
            data-testid="ai-edit"
            onClick={() => patch(id, { view: 'brief' } as Partial<AiPromptData>)}
            className="press-inset nodrag flex h-7 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2.5 text-[13px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            <ChevronLeft size={13} /> Бриф
          </button>
        )}
        {!showResult && hasResult && !busy && (
          <button
            data-testid="ai-result-view"
            onClick={() => patch(id, { view: 'result' } as Partial<AiPromptData>)}
            className="press-inset nodrag flex h-7 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2.5 text-[13px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            Результат <ChevronRight size={13} />
          </button>
        )}
        {/* The bare strip IS the footer's drag affordance — the buttons around it
            are `nodrag`. It has a floor so a longer button label can never eat it
            again: adding the «· N кр.» price grew the CTA from ~90px to 138px on a
            240px node, which left 80px of grip entirely left of centre. */}
        <span data-testid="ai-footer-grip" className="min-w-[72px] flex-1 self-stretch" />
        <button
          data-testid="ai-draft"
          disabled={busy || !(d.brief ?? '').trim()}
          onClick={() => draftPrompt(id)}
          className="press nodrag flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-2.5 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="seed-spin" /> : <Sparkles size={13} />}
          {hasResult ? 'Заново' : 'Создать'} · {PROMPT_STUDIO_CREDITS[d.model ?? 'claude']} кр.
        </button>
      </div>

      {d.status === 'failed' && (
        <p className="nodrag px-2.5 pb-2 text-[11px] text-destructive">
          Не получилось — попробуйте ещё.
        </p>
      )}
      <RegistryOutPort
        type="aiprompt"
        data={d as unknown as Record<string, unknown>}
        label="текст"
        show={selected}
      />
    </div>
  );
}

/* ----------------------------- Note node ----------------------------- */
function NoteNodeDetail({ id, data, selected }: NodeProps) {
  const d = data as unknown as NoteData;
  const { patch } = useGraph();
  const wheel = useWheelScroll<HTMLTextAreaElement>();
  return (
    <div
      className={`${shell} ${selected ? shellSel : shellIdle} relative flex h-full w-full min-w-[240px] flex-col bg-[rgba(var(--accent-rgb),0.07)]`}
    >
      <Resizer visible={selected} minWidth={180} minHeight={100} />
      <NodeTitle id={id} label="Заметка" testid="node-note-header" />
      <DragHitFrame />
      <textarea
        {...wheel}
        value={d.text}
        onChange={(e) => patch(id, { text: e.target.value })}
        className="nodrag m-2 min-h-[48px] w-[calc(100%-16px)] flex-1 cursor-text resize-none rounded-[var(--radius-sm)] bg-transparent p-2 text-[13px] leading-relaxed text-[color:var(--color-fg)] outline-none"
        placeholder="Заметка…"
      />
    </div>
  );
}

/* -------------------------- Organizer nodes -------------------------- */
function TextNodeDetail({ id, data, selected }: NodeProps) {
  const d = data as unknown as TextData;
  const { patch } = useGraph();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.text);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!editing) setDraft(d.text);
    if (editing) inputRef.current?.focus();
  }, [d.text, editing]);
  const commit = () => {
    patch(id, { text: draft.slice(0, 2_000) });
    setEditing(false);
  };
  const sizeClass = d.size === 's' ? 'text-[13px]' : d.size === 'l' ? 'text-[21px]' : 'text-[16px]';
  return (
    <div
      data-testid="text-node"
      onDoubleClick={() => setEditing(true)}
      className={`${shell} ${selected ? shellSel : shellIdle} relative flex h-full w-full min-w-[200px] flex-col bg-[rgba(var(--accent-rgb),0.05)]`}
    >
      <Resizer visible={selected} minWidth={200} minHeight={120} />
      <NodeTitle id={id} label="Текст" testid="node-text-header" />
      <DragHitFrame />
      <textarea
        ref={inputRef}
        value={editing ? draft : d.text}
        readOnly={!editing}
        maxLength={2_000}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setDraft(d.text);
            setEditing(false);
          }
        }}
        placeholder="Текст заметки…"
        className={`nodrag m-2 min-h-0 flex-1 resize-none rounded-[var(--radius-sm)] bg-transparent p-2 ${sizeClass} leading-relaxed text-[color:var(--color-fg)] outline-none ${editing ? 'border-2 border-[color:var(--color-accent)]' : 'border-2 border-transparent'}`}
        aria-label="Текст борда"
      />
      <div
        className="nodrag flex items-center gap-1 px-2 pb-2"
        role="group"
        aria-label="Размер текста"
      >
        {(['s', 'm', 'l'] as const).map((size) => (
          <button
            key={size}
            type="button"
            data-testid={`text-size-${size}`}
            onClick={() => patch(id, { size })}
            className={`h-6 min-w-6 rounded border text-[11px] font-bold ${d.size === size ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]' : 'border-[color:var(--color-line-soft)] text-[color:var(--color-muted-foreground)]'}`}
          >
            {size.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

const FRAME_TINT_CLASS: Record<string, string> = {
  violet: 'bg-violet-400/10',
  blue: 'bg-sky-400/10',
  green: 'bg-emerald-400/10',
  amber: 'bg-amber-400/10',
  pink: 'bg-pink-400/10',
  gray: 'bg-slate-400/10',
};

function FrameNodeDetail({ id, data, selected }: NodeProps) {
  const d = data as unknown as FrameData;
  const { patch } = useGraph();
  const [title, setTitle] = useState(d.title);
  useEffect(() => setTitle(d.title), [d.title]);
  return (
    <div
      data-testid="frame-node"
      className={`${shell} ${selected ? shellSel : shellIdle} ${FRAME_TINT_CLASS[d.tint ?? 'violet'] ?? FRAME_TINT_CLASS.violet} relative flex h-full w-full min-w-[240px] flex-col`}
      style={{ zIndex: -1 }}
    >
      <Resizer visible={selected} minWidth={240} minHeight={160} />
      <NodeTitle id={id} label="Рамка" testid="node-frame-header" nodeType="frame" />
      <DragHitFrame />
      <input
        value={title}
        maxLength={120}
        onChange={(event) => setTitle(event.target.value.slice(0, 120))}
        onBlur={() => patch(id, { title: title.trim() || 'Рамка' })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setTitle(d.title);
            event.currentTarget.blur();
          }
        }}
        className="nodrag mx-3 mt-3 border-b-2 border-[color:var(--color-line-soft)] bg-transparent px-1 py-1 font-display text-lg font-black text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
        aria-label="Название рамки"
      />
      <p className="pointer-events-none px-3 pt-2 text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Группа борда
      </p>
    </div>
  );
}

/* ---------------------------- Scene node ---------------------------- */
// Chip context menu as a viewport portal (NodeMenu): the old absolute menu
// clipped against the canvas edge from inside the scene card. Same items,
// same testids — only the positioning moves to the portal.
function SceneObjectMenuPortal({
  anchorRef,
  open,
  index,
  objectName,
  absent,
  onClose,
  onFocusCast,
  onUnlink,
  onRemove,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  index: number;
  objectName: string;
  absent: boolean;
  onClose: () => void;
  onFocusCast: () => void;
  onUnlink: () => void;
  onRemove: () => void;
}) {
  return (
    <NodeMenu
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      testid={`scene-object-menu-${index}`}
      ariaLabel={`Объект ${objectName}`}
      className="glass-menu p-1"
      widthClass="w-[180px]"
    >
      <>
        {absent && (
          <p className="px-2 py-1 font-mono text-[11px] uppercase text-[color:var(--color-faint)]">
            Больше нет в сцене
          </p>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={onFocusCast}
          className="block w-full rounded-[var(--radius-xs)] px-2 py-1 text-left text-[11px] text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface2)]"
        >
          Перейти к объекту
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid={`scene-object-unlink-${index}`}
          onClick={onUnlink}
          className="block w-full rounded-[var(--radius-xs)] px-2 py-1 text-left text-[11px] text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface2)]"
        >
          Отвязать
        </button>
        {absent && (
          <button
            type="button"
            role="menuitem"
            onClick={onRemove}
            className="block w-full rounded-[var(--radius-xs)] px-2 py-1 text-left text-[11px] text-destructive hover:bg-[color:var(--color-surface2)]"
          >
            Удалить из списка
          </button>
        )}
      </>
    </NodeMenu>
  );
}

function SceneNodeDetail({ id, data, selected }: NodeProps) {
  const d = data as unknown as SceneData;
  const {
    patch,
    createShotFromScene,
    extractSceneObjects,
    promoteSceneObject,
    unlinkSceneObject,
    removeSceneObject,
    focusBoardNode,
    sceneSourceHref,
    sceneShotCount,
  } = useGraph();
  const sceneTextWheel = useWheelScroll<HTMLPreElement>();
  const [objectsBusy, setObjectsBusy] = useState(false);
  const [objectsError, setObjectsError] = useState<string | null>(null);
  const [objectsTruncated, setObjectsTruncated] = useState(false);
  const [showAllObjects, setShowAllObjects] = useState(false);
  const [openChipIndex, setOpenChipIndex] = useState<number | null>(null);
  const objectGroupRef = useRef<HTMLDivElement | null>(null);
  const chipBtns = useRef(new Map<number, HTMLButtonElement>());
  // Anchor for the chip menu portal: the open chip's button element, resolved
  // at place() time (NodeMenu reads `.current` in its positioning effect).
  // A getter keeps one stable ref object while tracking the open chip.
  const openChipAnchorRef = useMemo<RefObject<HTMLElement | null>>(
    () =>
      ({
        get current() {
          return openChipIndex == null
            ? null
            : ((chipBtns.current.get(openChipIndex) ?? null) as HTMLElement | null);
        },
        set current(_: HTMLElement | null) {},
      }) as RefObject<HTMLElement | null>,
    [openChipIndex],
  );
  // An open menu addresses a position in the list, so it cannot survive the list
  // changing under it — a finished re-extraction would leave it on another chip.
  useEffect(() => {
    setOpenChipIndex(null);
  }, [d.objects]);
  // Dismissal rides on the menu portal's own scrim + Escape (NodeMenu) — the
  // previous window pointerdown catcher would close a portal menu on mousedown
  // before its option click ever fires, since the portal lives outside the chip
  // group it used to test containment against.
  const sourceLabel = d.sourceScriptId
    ? `Сценарий · сцена ${d.sourceOrdinal ?? '—'}`
    : 'Локальная сцена';
  const status = d.sourceStatus ?? 'current';
  const objects = d.objects ?? [];
  const visibleObjects = showAllObjects ? objects : objects.slice(0, 6);
  const sourceHref = sceneSourceHref(d);
  const sourcedShotCount = sceneShotCount(id);
  const extractObjects = async () => {
    setObjectsBusy(true);
    setObjectsError(null);
    setObjectsTruncated(false);
    const result = await extractSceneObjects(id);
    setObjectsBusy(false);
    if (result.error) {
      setObjectsError(result.error);
      return;
    }
    setObjectsTruncated(result.sourceTruncated);
    // The chips are the result; a keyboard user should land on them, not stay on
    // a button whose label has just changed under the cursor.
    requestAnimationFrame(() => objectGroupRef.current?.focus());
  };
  return (
    <div
      data-testid="scene-node"
      data-source-status={status}
      className={`${shell} ${selected ? shellSel : shellIdle} relative flex h-full w-full min-w-[280px] flex-col`}
    >
      <Resizer visible={selected} minWidth={260} minHeight={170} />
      <NodeTitle id={id} label="Сцена" testid="node-scene-header" />
      <DragHitFrame />
      <div className="nodrag flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3 pt-2">
        <div className="flex items-center gap-2">
          <FileText size={15} className="shrink-0 text-[color:var(--color-accent)]" />
          <strong className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--color-fg)]">
            {d.title || 'Без заголовка'}
          </strong>
          {status !== 'current' && (
            <span className="rounded-full border border-[color:var(--color-line-soft)] px-2 py-0.5 font-mono text-[11px] font-bold uppercase text-[color:var(--color-destructive)]">
              {status === 'removed' ? 'удалена' : 'изменена'}
            </span>
          )}
        </div>
        {d.synopsis && (
          <p className="line-clamp-3 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            {d.synopsis}
          </p>
        )}
        <div className="min-h-[52px] space-y-1">
          <div className="flex items-center justify-between gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-faint)]">
            <span aria-live="polite">ОБЪЕКТЫ · {objects.length}</span>
            {objects.length > 6 && (
              <button
                type="button"
                aria-expanded={showAllObjects}
                onClick={() => setShowAllObjects((value) => !value)}
                className="text-[color:var(--color-accent)] hover:underline"
              >
                {showAllObjects ? 'Скрыть часть' : 'Показать все'}
              </button>
            )}
          </div>
          {objects.length === 0 ? (
            <>
              <button
                type="button"
                data-testid="scene-extract-objects"
                disabled={!d.sourceText?.trim() || objectsBusy || status === 'removed'}
                onClick={() => void extractObjects()}
                className="press-inset nodrag rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] px-2 py-1 text-[11px] font-semibold text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)] disabled:opacity-40"
              >
                {objectsBusy ? 'Разбираем…' : 'Разобрать сцену'}
              </button>
              <p className="text-[11px] leading-snug text-[color:var(--color-faint)]">
                ИИ проанализирует текст; кредиты не спишутся.
              </p>
            </>
          ) : (
            <div
              ref={objectGroupRef}
              tabIndex={-1}
              className="flex flex-wrap gap-1 outline-none"
              role="group"
              aria-label="Объекты сцены"
            >
              {d.sourceScriptId &&
                d.sourceHash &&
                d.objectsSourceHash &&
                d.sourceHash !== d.objectsSourceHash && (
                  <p className="basis-full text-[11px] leading-tight text-destructive">
                    Объекты из прошлой версии · разберите заново
                  </p>
                )}
              {visibleObjects.map((object, index) => {
                const linked = Boolean(object.castNodeId);
                const open = openChipIndex === index;
                return (
                  <span
                    key={`${object.kind}-${object.name}-${index}`}
                    className="relative inline-flex max-w-[190px] items-center rounded-[var(--radius-xs)] border border-[color:var(--color-line-soft)] text-[11px] text-[color:var(--color-fg)]"
                    title={object.name}
                  >
                    <button
                      type="button"
                      data-testid={`scene-object-chip-${index}`}
                      ref={(el) => {
                        if (el) chipBtns.current.set(index, el);
                        else chipBtns.current.delete(index);
                      }}
                      // A chip addresses a position, so it is inert while a new
                      // extraction is in flight and about to rewrite the list.
                      disabled={objectsBusy}
                      {...(linked
                        ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': open }
                        : { 'aria-pressed': false })}
                      onClick={() =>
                        linked
                          ? setOpenChipIndex(open ? null : index)
                          : promoteSceneObject(id, index)
                      }
                      className="inline-flex min-w-0 items-center gap-1 px-1.5 py-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
                    >
                      <span className="shrink-0 font-mono text-[11px] text-[color:var(--color-faint)]">
                        {SCENE_OBJECT_KIND_LABEL[object.kind]}
                      </span>
                      <span className="truncate">{object.name}</span>
                      <span className="shrink-0 text-[color:var(--color-accent)]">
                        {object.absentFromLatestExtraction ? '!' : linked ? '✓' : '+'}
                      </span>
                    </button>
                    {open && linked && (
                      <SceneObjectMenuPortal
                        anchorRef={openChipAnchorRef}
                        open
                        index={index}
                        objectName={object.name}
                        absent={Boolean(object.absentFromLatestExtraction)}
                        onClose={() => setOpenChipIndex(null)}
                        onFocusCast={() => {
                          setOpenChipIndex(null);
                          if (object.castNodeId) focusBoardNode(object.castNodeId);
                        }}
                        onUnlink={() => {
                          setOpenChipIndex(null);
                          unlinkSceneObject(id, index);
                        }}
                        onRemove={() => {
                          setOpenChipIndex(null);
                          removeSceneObject(id, index);
                        }}
                      />
                    )}
                  </span>
                );
              })}
              <button
                type="button"
                data-testid="scene-extract-objects"
                disabled={!d.sourceText?.trim() || objectsBusy || status === 'removed'}
                onClick={() => void extractObjects()}
                className="press-inset nodrag basis-full rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] px-2 py-1 text-[11px] font-semibold text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)] disabled:opacity-40"
              >
                {objectsBusy ? 'Разбираем…' : 'Разобрать заново'}
              </button>
              <p className="basis-full text-[11px] leading-snug text-[color:var(--color-faint)]">
                ИИ уже разобрал текст; кредиты не списались. Выберите только то, что должно
                повторяться.
              </p>
            </div>
          )}
          {objectsError && (
            <p className="text-[11px] leading-tight text-destructive">{objectsError}</p>
          )}
          {objectsTruncated && (
            <p className="text-[11px] leading-tight text-[color:var(--color-muted-foreground)]">
              Текст сцены был сокращён перед разбором.
            </p>
          )}
        </div>
        {!d.collapsed && (
          <pre
            {...sceneTextWheel}
            className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-2 font-sans text-[11px] leading-relaxed text-[color:var(--color-fg)]"
          >
            {d.sourceText || 'Текст сцены пуст'}
          </pre>
        )}
        <div className="mt-auto border-t border-[color:var(--color-line-soft)] pt-2">
          <div className="flex items-center justify-between gap-2">
            {sourceHref ? (
              <a
                href={sourceHref}
                className="truncate font-mono text-[11px] uppercase text-[color:var(--color-accent)] hover:underline"
              >
                {sourceLabel}
              </a>
            ) : (
              <span className="truncate font-mono text-[11px] uppercase text-[color:var(--color-faint)]">
                {sourceLabel}
              </span>
            )}
            <button
              type="button"
              onClick={() => patch(id, { collapsed: !d.collapsed })}
              className="press-inset rounded-[var(--radius-sm)] px-2 py-1 text-[11px] font-semibold text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
            >
              {d.collapsed ? 'Текст' : 'Свернуть'}
            </button>
          </div>
          <button
            type="button"
            data-testid="scene-add-shot"
            disabled={status === 'removed'}
            onClick={() => createShotFromScene(id)}
            className="press mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] text-[11px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[2px_2px_0_0_var(--color-shadow)] disabled:opacity-40"
          >
            <Plus size={13} /> {sourcedShotCount ? 'Добавить ещё кадр' : 'Добавить первый кадр'}
          </button>
        </div>
      </div>
      <RegistryOutPort
        type="scene"
        data={d as unknown as Record<string, unknown>}
        label="сцена"
        show={selected}
      />
    </div>
  );
}

/* --------------------------- Reference node ---------------------------
 * The continuity backbone: drop a person / place / product / look here once,
 * wire it into many shots, and every shot inherits it (Seedream multi-
 * reference for stills, Seedance first-frame for video). Closes the
 * upload gap too. */
function MediaNodeDetail({ id, data, selected }: NodeProps) {
  const d = data as unknown as MediaData;
  const { upload, patch, assetLifecycleFor } = useGraph();
  const lifecycle = assetLifecycleFor(d.assetId);
  const unavailable = !!d.assetId && lifecycle?.available !== true;
  const mediaUrl = lifecycle?.available ? lifecycle.assetUrl : d.assetId ? '' : d.url;
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const patchUrl = (url: string) =>
    patch(id, {
      url,
      mediaKind: isVideoUrl(url) ? 'video' : 'image',
      assetId: undefined,
    } as Partial<MediaData>);
  async function pick(file: File) {
    setBusy(true);
    const url = await upload(file);
    setBusy(false);
    if (url) patchUrl(url);
  }

  return (
    <div
      className={`${shell} ${selected ? shellSel : shellIdle} relative flex h-full w-full min-w-[240px] flex-col`}
    >
      <Resizer visible={selected} minWidth={200} minHeight={150} />
      <NodeTitle id={id} label="Референс" testid="node-media-header" />
      <DragHitFrame />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
        }}
      />
      {unavailable ? (
        <div className="mx-2 mb-2 mt-1.5 grid h-[120px] min-h-[80px] flex-1 place-items-center rounded-[var(--radius-sm)] border-2 border-red-400/30 bg-black/70 p-3 text-center">
          <AssetLifecycleNotice unavailable />
        </div>
      ) : mediaUrl ? (
        <div className="relative mx-2 mb-2 mt-1.5 h-[120px] min-h-[80px] flex-1 overflow-hidden rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-black">
          {d.mediaKind === 'video' ? (
            <video src={assetSrc(mediaUrl)} muted className="h-full w-full object-cover" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={assetSrc(mediaUrl)} alt="" className="h-full w-full object-cover" />
          )}
          <button
            onClick={() => inputRef.current?.click()}
            className="nodrag absolute bottom-1 right-1 rounded-[var(--radius-xs)] border-[1.5px] border-[color:var(--color-line)] bg-black/70 px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide text-white/85 hover:text-white"
          >
            Заменить
          </button>
        </div>
      ) : (
        <button
          onClick={() => inputRef.current?.click()}
          data-testid="reference-upload"
          className="nodrag mx-2 mb-2 mt-1.5 grid h-[120px] min-h-[80px] w-[calc(100%-16px)] flex-1 place-items-center rounded-[var(--radius-sm)] border-2 border-dashed border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] text-[11px] text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-fg)]"
        >
          {busy ? <Loader2 size={16} className="seed-spin" /> : 'Загрузить изображение'}
        </button>
      )}
      {lifecycle?.available && lifecycle.expiresAt ? (
        <div className="nodrag mx-2 mb-2">
          <AssetLifecycleNotice
            expiresAt={lifecycle.expiresAt}
            assetUrl={lifecycle.assetUrl}
            compact
          />
        </div>
      ) : null}
      {/* output is always present so a planned (drag-to-create) wire shows
          before the upload lands — the edge fills once a file is chosen. */}
      <RegistryOutPort
        type="media"
        data={d as unknown as Record<string, unknown>}
        label="референс"
        show={selected}
      />
    </div>
  );
}

/* ----------------------------- Cast node ------------------------------
 * A NAMED set of 1–4 stills (+ optional motion ref for a location). Wire into
 * shots — stills join the shot's
 * reference pool subject-first, the name lands in the prompt. */
function CastNodeDetail({ id, data, selected }: NodeProps) {
  const d = data as unknown as CastData;
  const { upload, patch, modelForNode, generateCastReference, addCastStill, removeCastStill } =
    useGraph();
  const [busy, setBusy] = useState(false);
  const stillRef = useRef<HTMLInputElement | null>(null);
  const motionRef = useRef<HTMLInputElement | null>(null);
  const isChar = d.castKind === 'character';
  const isProduct = d.castKind === 'product';
  const isIdentity = isChar || isProduct;
  const castKindLabel = CAST_KIND_LABEL[d.castKind];
  const referenceDescription = isChar
    ? `внешность ${CAST_KIND_LABEL_GENITIVE.character}`
    : `вид ${CAST_KIND_LABEL_GENITIVE[d.castKind]}`;
  const accent = isIdentity ? PORT_COLOR.image : PORT_COLOR.video;
  // B-5 identity layer: reference-set strength + how many shots use this
  // character (live from the graph). `.length` keeps the store selector stable.
  const quality = identityRefQuality(d.imageUrls);
  const usedInShots = useStore(
    (s) =>
      shotsUsingCharacter(
        id,
        s.nodes as unknown as ShotNodeLike[],
        s.edges as unknown as ShotEdgeLike[],
      ).length,
  );
  const routeSupport = useStore((state) => {
    // Rank the shots this character feeds and report the BEST route it gets.
    // 'unknown' ranks below 'unsupported' on purpose: a shot whose model has not
    // resolved tells us nothing, so it must never downgrade a sibling shot that
    // does resolve, and it must not be reported as a missing capability.
    let best: 'none' | 'unknown' | 'unsupported' | 'guided' | 'specialized' = 'none';
    for (const edge of state.edges) {
      if (edge.source !== id) continue;
      const target = state.nodes.find((node) => node.id === edge.target);
      if (target?.type !== 'generate') continue;
      const model = modelForNode(target.data as unknown as GenerateData);
      const contract = resolveBoardModelContract(model);
      const support = characterReferenceSupport({
        modelId: model?.id,
        imageInputMax:
          contract?.referenceImageMax && contract.referenceImageMax > 0
            ? contract.referenceImageMax
            : (contract?.imageInput.max ?? 0),
      });
      if (support === 'specialized') return support;
      if (support === 'guided') best = 'guided';
      else if (support === 'unsupported' && best !== 'guided') best = 'unsupported';
      else if (best === 'none') best = 'unknown';
    }
    return best;
  });
  const hasIdleReferenceShot = useStore((state) =>
    state.nodes.some(
      (node) =>
        node.type === 'generate' &&
        (node.data as Record<string, unknown>)['originCastNodeId'] === id &&
        (node.data as Record<string, unknown>)['status'] === 'idle',
    ),
  );

  async function addStill(file: File) {
    if (d.imageUrls.length >= 4) return;
    setBusy(true);
    const url = await upload(file);
    setBusy(false);
    if (url) addCastStill(id, url);
  }
  async function setMotion(file: File) {
    setBusy(true);
    const url = await upload(file);
    setBusy(false);
    if (url) patch(id, { videoUrl: url } as Partial<CastData>);
  }

  return (
    <div
      className={`${shell} ${selected ? shellSel : shellIdle} relative flex h-full w-full min-w-[240px] flex-col`}
      data-testid={`cast-node-${d.castKind}`}
    >
      {/* 180px was the floor before this card gained «Сгенерировать референс» and
          its helper line; measured in a browser, that leaves 22px of content behind a
          scrollbar at the minimum the author can actually drag to. Cards already
          persisted shorter still scroll — the shell clips rather than paints outside. */}
      <Resizer visible={selected} minWidth={220} minHeight={220} />
      <NodeTitle
        id={id}
        label={`${CAST_NODE_LABEL} · ${castKindLabel}`}
        testid="node-cast-header"
      />
      <DragHitFrame />
      <InPort
        id="scene"
        label="сцена"
        kind="scene"
        top="min(54px, calc(100% - 12px))"
        show={selected}
      />
      {/* Keep ports outside the scroll container. Overflow clips hit-testing
          even when React Flow can still measure and paint a handle at the card
          edge, turning a connection gesture into a node drag. */}
      <div className="seed-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        <input
          value={d.name}
          data-testid="cast-name"
          onChange={(e) => patch(id, { name: e.target.value } as Partial<CastData>)}
          placeholder={
            isChar
              ? `Имя ${CAST_KIND_LABEL_GENITIVE.character}…`
              : `Название ${CAST_KIND_LABEL_GENITIVE[d.castKind]}…`
          }
          className="nodrag mx-2 mt-2.5 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2 py-1 text-[13px] font-semibold text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-faint)] focus:border-[color:var(--color-accent)]"
        />
        <textarea
          value={d.description ?? ''}
          onChange={(event) =>
            patch(id, {
              description: event.target.value.slice(0, 200) || undefined,
            } as Partial<CastData>)
          }
          placeholder="Описание внешности или места…"
          className="nodrag mx-2 mt-1 min-h-[42px] resize-none rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2 py-1 text-[11px] text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-faint)] focus:border-[color:var(--color-accent)]"
        />
        {isIdentity && (
          <div
            data-testid="cast-identity"
            data-strength={quality.strength}
            className="mx-2 mt-1.5 flex items-center justify-between gap-2 text-[11px]"
          >
            <span
              title={
                quality.warnings.join(' ') ||
                'Полный набор ракурсов. Результат всё равно зависит от выбранной модели.'
              }
              className={
                quality.strength === 'strong'
                  ? 'text-[color:var(--color-accent)]'
                  : quality.strength === 'ok'
                    ? 'text-[color:var(--color-muted-foreground)]'
                    : 'text-[color:var(--color-faint)]'
              }
            >
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={
                    'inline-block h-1.5 w-1.5 rounded-full ' +
                    (quality.strength === 'none' ? 'border-[1.5px] border-current' : 'bg-current')
                  }
                />
                {quality.strength === 'strong'
                  ? 'референсы: 4/4'
                  : quality.strength === 'ok'
                    ? `референсы: ${quality.refCount}/4`
                    : quality.strength === 'weak'
                      ? 'референсы: 1/4'
                      : 'нет референсов'}
              </span>
            </span>
            <span data-testid="cast-usage" className="tnum text-[color:var(--color-faint)]">
              {usedInShots > 0 ? `в ${usedInShots} ${usedInShots === 1 ? 'кадре' : 'кадрах'}` : '—'}
            </span>
          </div>
        )}
        {isIdentity && usedInShots > 0 && (
          <p
            data-testid="cast-route-support"
            data-support={routeSupport}
            className="mx-2 mt-1 text-[11px] leading-snug text-[color:var(--color-faint)]"
          >
            {routeSupport === 'specialized'
              ? 'Спецрежим референсов · без гарантии точного совпадения'
              : routeSupport === 'guided'
                ? 'Обычные референсы + имя в промпте'
                : routeSupport === 'unknown'
                  ? 'Модель кадра не выбрана — референсы пока не оценить'
                  : 'Выбранная модель не использует референсы объекта'}
          </p>
        )}
        <input
          ref={stillRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void addStill(f);
            e.target.value = '';
          }}
        />
        <input
          ref={motionRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void setMotion(f);
            e.target.value = '';
          }}
        />
        <div className="mx-2 mb-1 mt-1.5 grid grid-cols-4 gap-1">
          {d.imageUrls.map((u, i) => (
            <div
              key={u}
              className="relative h-[42px] overflow-hidden rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line-soft)] bg-black"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={assetSrc(u)} alt="" className="h-full w-full object-cover" />
              <button
                title="Убрать"
                data-testid={`cast-remove-still-${i}`}
                onClick={() => removeCastStill(id, i)}
                className="nodrag absolute right-0 top-0 grid h-3.5 w-3.5 place-items-center rounded-bl-[var(--radius-xs)] bg-black/70 text-white/80 hover:text-destructive"
              >
                <X size={8} />
              </button>
            </div>
          ))}
          {d.imageUrls.length < 4 && (
            <button
              data-testid="cast-add-still"
              onClick={() => stillRef.current?.click()}
              className="nodrag grid h-[42px] place-items-center rounded-[var(--radius-xs)] border-2 border-dashed border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-fg)]"
            >
              {busy ? <Loader2 size={11} className="seed-spin" /> : <Plus size={11} />}
            </button>
          )}
        </div>
        <button
          type="button"
          data-testid="cast-generate-reference"
          disabled={d.imageUrls.length >= 4 || hasIdleReferenceShot}
          onClick={() => generateCastReference(id)}
          className="press nodrag mx-2 mb-1 flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-2 text-[11px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[2px_2px_0_0_var(--color-shadow)] disabled:opacity-40"
        >
          <Sparkles size={13} /> Подготовить референс
        </button>
        <p className="mx-2 mb-1 shrink-0 text-[11px] leading-snug text-[color:var(--color-faint)]">
          Появится отдельный кадр с ценой · запускается и через «Снять всё».
        </p>
        {!isIdentity && (
          <button
            data-testid="cast-add-motion"
            onClick={() => motionRef.current?.click()}
            className="nodrag mx-2 mb-2 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2 py-1 text-left text-[11px] font-semibold text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            {d.videoUrl ? (
              <span className="inline-flex items-center gap-1">
                <Clapperboard size={10} /> Движение задано · заменить
              </span>
            ) : (
              '+ Видео-референс движения (AtlasCloud)'
            )}
          </button>
        )}
        {d.imageUrls.length === 0 && (
          <p className="mx-2 mb-2 text-[11px] leading-snug text-[color:var(--color-faint)]">
            Сначала добавьте референс. Он закрепит {referenceDescription} во всех сценах.
          </p>
        )}
      </div>
      {/* output is always present so a planned (drag-to-create) wire shows
          before any still is added; isValid still blocks a manual wire until
          the cast is ready, and an empty cast contributes nothing at run-time. */}
      <RegistryOutPort
        type="cast"
        data={d as unknown as Record<string, unknown>}
        label={castKindLabel.toLowerCase()}
        show={selected}
      />
    </div>
  );
}

/* --------------------------- Generate node --------------------------- */

/** A settings row inside the in-widget panel: a label + a control. */
// Card-width-aware row. The settings panel is a `@container/np` (see
// NodeSettingsPanel), so this responds to the CARD's width, NOT the viewport —
// a 240px card on a 1080p screen still gets the cramped layout, which is why
// plain `sm:` breakpoints would be wrong here. Narrow (default): label stacks
// ABOVE a full-width control so nothing truncates and tap targets stay big.
// Roomy (≥240px container): the classic inline label · control row.
function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-1.5 @[240px]/np:flex-row @[240px]/np:items-center @[240px]/np:justify-between @[240px]/np:gap-2">
      <span className="min-w-0 truncate text-[11px] text-[color:var(--color-muted-foreground)] @[240px]/np:shrink-0">
        {label}
      </span>
      {children}
    </div>
  );
}

/** Compact dropdown for the settings panel (aspect / duration / resolution).
 * Trigger carries `testid`; each option carries `${testid}-${id}`. */
function NodeSelect<T extends string>({
  value,
  options,
  onChange,
  testid,
  // Full-width when the card is narrow (the control owns its own row), shrinking
  // to a fixed inline width once the card is roomy enough for label · control.
  width = 'w-full @[240px]/np:w-[116px]',
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  testid: string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const listWheel = useWheelScroll<HTMLDivElement>();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const cur = options.find((o) => o.id === value);
  return (
    <div className="relative">
      <button
        data-testid={testid}
        ref={btnRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          `press-inset nodrag flex ${width} items-center justify-between gap-1 rounded-[var(--radius-sm)] border-2 bg-[color:var(--color-surface2)] px-2 py-1.5 text-[11px] font-semibold text-[color:var(--color-fg)] ` +
          (open
            ? 'border-[color:var(--color-accent)]'
            : 'border-[color:var(--color-line-soft)] hover:border-[color:var(--color-accent)]')
        }
      >
        <span className="truncate">{cur?.label ?? value}</span>
        <ChevronDown
          size={12}
          className={
            'shrink-0 text-[color:var(--color-faint)] transition-transform ' +
            (open ? 'rotate-180' : '')
          }
        />
      </button>
      {/* Options in a viewport portal (NodeMenu): the old absolute list
          clipped against the canvas edge from inside the settings panel. */}
      <NodeMenu
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        role="listbox"
        className="glass-menu p-1"
        maxMenuHeight={150}
        divProps={{ ...listWheel }}
      >
        {options.map((o) => {
          const sel = o.id === value;
          return (
            <button
              key={o.id}
              data-testid={`${testid}-${o.id}`}
              role="option"
              aria-selected={sel}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
              className={
                'nodrag flex w-full items-center justify-between rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[11px] transition-colors ' +
                (sel
                  ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                  : 'text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]')
              }
            >
              <span className="truncate">{o.label}</span>
              {sel && (
                <Check
                  size={11}
                  className="shrink-0 text-[color:var(--color-primary-foreground)]"
                />
              )}
            </button>
          );
        })}
      </NodeMenu>
    </div>
  );
}

// In-widget settings panel — REPLACES the preview+controls when the gear is
// pressed; the back button returns. Video and image controls follow the
// selected model; fixed/model-managed values render as information instead of
// inert dropdowns or switches.
function NodeSettingsPanel({
  id,
  d,
  onBack,
  displayCost,
}: {
  id: string;
  d: GenerateData;
  onBack: () => void;
  /**
   * Server-quoted price, or the local flat placeholder while it loads.
   * `null` = the server REFUSED to price this configuration — render «—», never
   * a locally-computed number (see GenerateNodeDetail).
   */
  displayCost: number | null;
}) {
  const { patch, modelForNode, diagnosticForNode, repairNodeSettings, swapFrameInputs } =
    useGraph();
  const panelWheel = useWheelScroll<HTMLDivElement>();
  const settingsWheel = useWheelScroll<HTMLDivElement>();
  const isVideo = d.mode === 'video';
  const set = (p: Partial<NodeSettings>) => patch(id, p as Partial<GenerateData>);
  // Capability-driven option space (S4): the node's resolved model drives the
  // aspect / duration / resolution lists; models that declare none fall back to
  // the static Seedance constants inside the resolvers below.
  const nodeModel = modelForNode(d);
  const nodeModelContract = resolveBoardModelContract(nodeModel);
  const frameSlots = useStore((state) => {
    let first = false;
    let last = false;
    for (const edge of state.edges) {
      if (edge.target !== id) continue;
      if (edge.targetHandle === 'images[0]') first = true;
      if (edge.targetHandle === 'images[1]') last = true;
    }
    return `${first ? 1 : 0}${last ? 1 : 0}`;
  });
  const v = resolveVideoSettings(d, nodeModel);
  const im = resolveImageSettings(d, nodeModel);
  const capAspects = videoAspectsFor(nodeModel);
  const capResolutions = videoResolutionsFor(nodeModel);
  const capDurations = videoDurationsFor(nodeModel);
  const capImageAspects = imageAspectsFor(nodeModel);
  const capImageQualities = imageQualitiesFor(nodeModel);
  const settingIssue = diagnosticForNode(id)?.settingIssues.find(
    (issue) => issue.field !== 'modelId',
  );
  // B-4: structured shot grammar editing (no typing). Patches d.shot.
  const grammar = d.shot ?? {};
  const moves = effectiveMoves(d.shot);
  const setGrammar = (p: Partial<ShotGrammar>) =>
    patch(id, { shot: { ...(d.shot ?? {}), ...p } } as Partial<GenerateData>);
  const noneFirst = (opts: { id: string; label: string }[]) => [{ id: '', label: '—' }, ...opts];
  // Discrete supported durations (Veo 4/6/8) when the model declares them, else
  // the full continuous Seedance range.
  const durationOpts = (
    capDurations && capDurations.length
      ? [...capDurations].sort((a, b) => a - b)
      : Array.from({ length: DURATION_MAX - DURATION_MIN + 1 }, (_, i) => DURATION_MIN + i)
  ).map((n) => ({ id: String(n), label: `${n} с` }));

  return (
    <div
      {...panelWheel}
      data-testid="node-settings-popover"
      className="@container/np nodrag seed-scroll flex h-full flex-col overflow-y-auto px-3 pt-2.5 pb-3 text-left"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <button
          data-testid="node-settings-close"
          onClick={onBack}
          aria-label="Назад"
          className="press-inset grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
        >
          <ChevronLeft size={15} />
        </button>
        <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-fg)]">
          Настройки кадра
        </span>
      </div>

      {settingIssue && (
        <div className="mb-2 rounded-[var(--radius-xs)] border border-[rgba(var(--destructive-rgb),0.5)] bg-destructive/10 px-2 py-1.5 text-[11px] leading-snug text-[color:var(--color-destructive)]">
          {settingIssue.reason}
          <button
            type="button"
            onClick={() => repairNodeSettings(id)}
            className="ml-1.5 font-semibold underline underline-offset-2"
          >
            Исправить
          </button>
        </div>
      )}

      <div {...settingsWheel} className="seed-scroll min-h-0 flex-1 overflow-y-auto pr-0.5">
        <div
          data-testid="image-input-mode"
          data-mode={nodeModelContract?.imageInput.role ?? 'none'}
          className="mb-2 rounded-[var(--radius-xs)] border border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2 py-1.5 text-[11px] leading-snug text-[color:var(--color-muted-foreground)]"
        >
          {nodeModelContract?.imageInput.role === 'frame' ? (
            <>
              <b className="text-[color:var(--color-fg)]">Кадры:</b>{' '}
              {nodeModelContract.imageInput.frameRoles
                .map((role) => (role === 'first' ? 'первый' : 'последний'))
                .join(' + ')}
              . Backend получает каждое изображение с этой ролью.
              {nodeModelContract.imageInput.frameRoles.includes('first') &&
                nodeModelContract.imageInput.frameRoles.includes('last') &&
                frameSlots !== '00' && (
                  <button
                    type="button"
                    data-testid="swap-frame-inputs"
                    onClick={() => swapFrameInputs(id)}
                    className="ml-1.5 font-semibold text-[color:var(--color-accent)] underline underline-offset-2"
                  >
                    Поменять first/last
                  </button>
                )}
              {nodeModelContract.referenceImageMax > 0 && (
                <>
                  {' '}
                  <b className="text-[color:var(--color-fg)]">Референсы:</b> отдельный вход без
                  ролей first/last.
                </>
              )}
            </>
          ) : nodeModelContract?.imageInput.role === 'reference' ? (
            <>
              <b className="text-[color:var(--color-fg)]">Референсы:</b> изображения передаются без
              ролей first/last. Они описывают внешний вид, а не начало ролика.
            </>
          ) : (
            'Выбранная модель не принимает изображения на вход.'
          )}
        </div>
        {isVideo ? (
          <>
            {capAspects.length > 0 && (
              <SettingRow label="Соотношение">
                <NodeSelect
                  testid="vaspect"
                  value={v.videoAspect}
                  onChange={(x) => set({ videoAspect: x })}
                  options={capAspects.map((a) => ({
                    id: a,
                    label: a === 'adaptive' ? 'Авто' : a,
                  }))}
                />
              </SettingRow>
            )}
            <SettingRow label="Длительность">
              <NodeSelect
                testid="vduration"
                value={String(v.durationSeconds)}
                onChange={(x) => set({ durationSeconds: Number(x) })}
                options={durationOpts}
              />
            </SettingRow>
            {capResolutions.length > 0 && (
              <SettingRow label="Разрешение">
                <NodeSelect
                  testid="vres"
                  value={v.videoResolution}
                  onChange={(x) => set({ videoResolution: x })}
                  options={capResolutions.map((r) => ({ id: r, label: r }))}
                />
              </SettingRow>
            )}
            {capAspects.length === 0 && capResolutions.length === 0 && (
              <p className="px-1 py-2 text-[11px] leading-snug text-[color:var(--color-faint)]">
                Формат и разрешение определяет выбранная модель.
              </p>
            )}
            <SettingRow label="Звук в видео">
              {nodeModelContract?.generateAudio ? (
                <span className="flex items-center gap-2">
                  {v.generateAudio ? (
                    <Volume2 size={13} className="text-[color:var(--color-muted-foreground)]" />
                  ) : (
                    <VolumeX size={13} className="text-[color:var(--color-faint)]" />
                  )}
                  <Switch
                    data-testid="vaudio"
                    aria-label="Генерировать звук"
                    checked={v.generateAudio}
                    onCheckedChange={(on) => set({ generateAudio: on })}
                    title="Добавить звук к видео"
                    className="nodrag h-5 w-9 [&>span]:size-4 [&>span]:data-[state=checked]:translate-x-[18px]"
                  />
                </span>
              ) : nodeModelContract?.audioOutput ? (
                <span className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                  <Volume2 size={13} className="text-[color:var(--color-muted-foreground)]" />
                  Звук создаётся автоматически
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-faint)]">
                  <VolumeX size={13} />
                  Без звука
                </span>
              )}
            </SettingRow>
          </>
        ) : (
          <>
            {capImageAspects.length > 0 && (
              <SettingRow label="Соотношение">
                <NodeSelect
                  testid="iaspect"
                  value={im.imageAspect}
                  onChange={(x) => set({ imageAspect: x })}
                  options={capImageAspects.map((a) => ({ id: a, label: a }))}
                />
              </SettingRow>
            )}
            {capImageQualities.length > 0 && (
              <SettingRow label={imageQualityAxisLabel(capImageQualities)}>
                <NodeSelect
                  testid="iquality"
                  value={im.imageQuality}
                  onChange={(x) => set({ imageQuality: x })}
                  options={capImageQualities.map((q) => ({
                    id: q,
                    label: boardImageQualityLabel(q),
                  }))}
                />
              </SettingRow>
            )}
            {capImageAspects.length === 0 && capImageQualities.length === 0 && (
              <p className="px-1 py-2 text-[11px] leading-snug text-[color:var(--color-faint)]">
                Формат и разрешение определяет выбранная модель.
              </p>
            )}
          </>
        )}

        {/* B-4: structured shot grammar — director controls, no typing. */}
        <div
          data-testid="shot-grammar"
          className="mt-2 border-t-[1.5px] border-[rgba(var(--paper-rgb),0.08)] pt-2"
        >
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-faint)]">
            Грамматика кадра
          </span>
          <SettingRow label="План">
            <NodeSelect
              testid="g-size"
              value={grammar.size ?? ''}
              onChange={(x) => setGrammar({ size: x || undefined })}
              options={noneFirst(SHOT_SIZES.map((o) => ({ id: o.id, label: o.label })))}
            />
          </SettingRow>
          <SettingRow label="Объектив">
            <NodeSelect
              testid="g-lens"
              value={grammar.lens ?? ''}
              onChange={(x) => setGrammar({ lens: x || undefined })}
              options={noneFirst(SHOT_LENSES.map((o) => ({ id: o.id, label: o.label })))}
            />
          </SettingRow>
          <SettingRow label="Свет">
            <NodeSelect
              testid="g-light"
              value={grammar.light ?? ''}
              onChange={(x) => setGrammar({ light: x || undefined })}
              options={noneFirst(SHOT_LIGHT.map((o) => ({ id: o.id, label: o.label })))}
            />
          </SettingRow>
          <SettingRow label="Температура">
            <NodeSelect
              testid="g-temp"
              value={grammar.colorTemp ?? ''}
              onChange={(x) => setGrammar({ colorTemp: x || undefined })}
              options={noneFirst(SHOT_COLOR_TEMP.map((o) => ({ id: o.id, label: o.label })))}
            />
          </SettingRow>
          <SettingRow label="Жанр">
            <NodeSelect
              testid="g-genre"
              value={grammar.genre ?? ''}
              onChange={(x) => setGrammar({ genre: x || undefined })}
              options={noneFirst(SHOT_GENRE.map((o) => ({ id: o.id, label: o.label })))}
            />
          </SettingRow>
          <SettingRow label="Энергия">
            <NodeSelect
              testid="g-energy"
              value={grammar.energy ?? ''}
              onChange={(x) => setGrammar({ energy: x || undefined })}
              options={noneFirst(SHOT_ENERGY.map((o) => ({ id: o.id, label: o.label })))}
            />
          </SettingRow>
          <div className="mt-1.5">
            <span className="mb-1 block text-[11px] text-[color:var(--color-faint)]">
              Движение камеры (до {MAX_MOVES})
            </span>
            <div className="flex flex-wrap gap-1" data-testid="g-moves">
              {SHOT_MOVES.map((o) => {
                const on = moves.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    data-testid={`g-move-${o.id}`}
                    data-on={on ? 'true' : 'false'}
                    onClick={() => setGrammar({ moves: toggleMove(moves, o.id), move: undefined })}
                    className={
                      'press-inset rounded-[var(--radius-sm)] border-[1.5px] px-2 py-0.5 text-[11px] transition-colors ' +
                      (on
                        ? 'border-[color:var(--color-accent)] text-[color:var(--color-accent)]'
                        : 'border-[rgba(var(--paper-rgb),0.15)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                    }
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between border-t-2 border-[color:var(--color-line-soft)] pt-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-faint)]">
          Стоимость кадра
        </span>
        <span
          data-testid="node-settings-cost"
          className="tnum text-[11px] font-semibold text-[color:var(--color-accent)]"
        >
          {displayCost ?? '—'}
        </span>
      </div>
    </div>
  );
}

function ResultVideo(props: React.ComponentProps<'video'>) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || typeof IntersectionObserver === 'undefined') return;
    // Controls own playback. Scrolling away may pause, but visibility never
    // starts playback again or changes the viewer's selected time.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) video.pause();
      },
      { threshold: 0.2 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);
  return <video ref={ref} {...props} />;
}

function GenerateNodeDetail({ id, data, selected }: NodeProps) {
  const d = data as unknown as GenerateData;
  const contractNode = {
    type: 'generate',
    data: d as unknown as Record<string, unknown>,
  } as Pick<BoardNode, 'type' | 'data'>;
  const promptPort = boardInputPort(contractNode, 'prompt')!;
  const referencePort = boardInputPort(contractNode, 'images[0]')!;
  const genericReferencePort = boardInputPort(contractNode, 'referenceImages[0]')!;
  const {
    apiUrl,
    models,
    planTier,
    lockedCtaHref,
    modelForNode,
    requestModelChange,
    diagnosticForNode,
    repairNodeSettings,
    patch,
    selectResult,
    appendCastReference,
    remove,
    run,
    running,
    toTray,
    resolveQuoteAssetUrl,
    publishNodeQuote,
    quoteRefreshFor,
  } = useGraph();
  const isVideo = d.mode === 'video';
  const busy = running(id) || d.status === 'running';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuWheel = useWheelScroll<HTMLDivElement>();
  const modelBtnRef = useRef<HTMLButtonElement | null>(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const reactFlow = useReactFlow();

  const choices = useMemo(() => modelsForMode(models, d.mode), [models, d.mode]);
  const current = modelForNode(d);
  // P-B2/DEC-3 parity with /generate: out-of-plan models stay VISIBLE in the
  // picker but are not selectable — they route to /pricing instead of letting
  // the user wire a graph that can only fail with a 403 at submit.
  const currentLocked = Boolean(current && isModelLocked(current, planTier));
  const modelContract = resolveBoardModelContract(current);
  // The motion references a run of this node would compile RIGHT NOW. Their
  // presence is a price selector on the server, so quoting settings alone made
  // the badge show a price that was not the price of the submitted request for
  // any shot with a wired video reference. Joined into one string so the React
  // Flow store subscription compares by value.
  const videoRefKey = useStore((s) =>
    wiredVideoRefUrls({
      nodeId: id,
      nodes: s.nodes as unknown as BoardQuoteNodeLike[],
      edges: s.edges,
      videoReferenceMax: modelContract?.videoReferenceMax ?? 0,
      resolveAssetUrl: resolveQuoteAssetUrl,
    }).join('\n'),
  );
  const videoRefUrls = useMemo(() => (videoRefKey ? videoRefKey.split('\n') : []), [videoRefKey]);
  const imageRefKey = useStore((s) =>
    JSON.stringify(
      wiredImageRefs({
        nodeId: id,
        nodes: s.nodes as unknown as BoardQuoteNodeLike[],
        edges: s.edges,
        imageInput: modelContract?.imageInput ?? { role: 'none', max: 0, frameRoles: [] },
        imageReferenceMax: modelContract?.referenceImageMax ?? 0,
        resolveAssetUrl: resolveQuoteAssetUrl,
      }),
    ),
  );
  const imageRefs = useMemo(() => JSON.parse(imageRefKey) as WiredImageRefs, [imageRefKey]);
  // Server-quoted price — same resolver `/v1/jobs` charges with, so it cannot
  // diverge from the reserved cost. There is deliberately no local fallback:
  // an unknown quote is shown as «—» and cannot be submitted.
  const estimateRequest = nodeEstimateRequest({
    mode: d.mode,
    model: current,
    settings: d,
    count: d.count,
    imageUrls: imageRefs.imageUrls,
    frameImages: imageRefs.frameImages,
    pendingReferenceCount: imageRefs.pendingReferenceCount,
    pendingFrameCount: imageRefs.pendingFrameCount,
    videoUrls: videoRefUrls,
  });
  const estimate = useJobEstimate({
    apiUrl,
    modelId: estimateRequest?.modelId,
    // The compiler's single-space placeholder keeps the request schema-valid
    // for an empty node. Price is determined by model and settings, so the hook
    // must not treat that placeholder's blank trim as an incomplete quote.
    prompt: estimateRequest?.prompt ?? '',
    params: estimateRequest?.params ?? {},
    // The sum, for the same reason as the Run All sheet: the price depends on how
    // many input images the submit will carry, not on which slot each one fills.
    pendingReferenceCount:
      (estimateRequest?.pendingReferenceCount ?? 0) + (estimateRequest?.pendingFrameCount ?? 0),
    source: 'boards',
    enabled: Boolean(estimateRequest),
    requiresPrompt: false,
    refreshToken: quoteRefreshFor(id),
  });
  const priceRefusal = estimate.refusal;
  // The quote prices ONE job. A video shot with count > 1 fans out into that
  // many jobs, so the badge shows the batch total while the bound price stays
  // per-job — binding the total would make every job in the batch claim it
  // costs four times what it does.
  const jobCost = estimatePriceToShow(estimate);
  const displayCost = boardBatchCost(jobCost, d.mode, d.count);
  const priceUnknown = displayCost === null;
  // Publish exactly what the badge shows, tagged with the request it is the
  // price OF. `hasKnownJobEstimate` is the same settled-quote rule /generate
  // submits on. Nothing is published while the quote is loading, failed or
  // refused — and nothing is erased on unmount either: the key is what makes a
  // stored number safe, so the runner ignores this entry the moment the shot
  // stops matching it (see the registry's ownership note).
  const bindableCost = hasKnownJobEstimate(estimate) ? jobCost : null;
  const bindableKey = estimateRequest
    ? boardQuoteKey({
        modelId: estimateRequest.modelId,
        mode: d.mode,
        params: estimateRequest.params,
        pendingReferenceCount: estimateRequest.pendingReferenceCount,
        pendingFrameCount: estimateRequest.pendingFrameCount,
      })
    : null;
  useEffect(() => {
    if (bindableKey === null || bindableCost === null) return;
    publishNodeQuote(id, bindableKey, bindableCost);
  }, [id, bindableKey, bindableCost, publishNodeQuote]);
  const cap = modelContract?.imageInput.max ?? 0;
  const referenceImageCap = modelContract?.referenceImageMax ?? 0;
  const diagnostic = diagnosticForNode(id);
  const invalid = diagnostic ? !diagnostic.executable : false;
  const invalidReason =
    diagnostic?.settingIssues[0]?.reason ??
    diagnostic?.edgeIssues[0]?.reason ??
    diagnostic?.generalIssues[0]?.reason;
  const canRepairSettings =
    diagnostic?.settingIssues.some(
      (issue) => issue.field !== 'modelId' && issue.replacement !== undefined,
    ) ?? false;
  const issueForHandle = (handle: string) =>
    diagnostic?.edgeIssues.find((issue) => issue.targetHandle === handle);

  // «connect for more slots»: one handle per wired reference + one empty
  const refSlots = useStore((s) => {
    const occupied: number[] = [];
    for (const e of s.edges) {
      if (e.target !== id) continue;
      const idx = imageHandleIndex(e.targetHandle);
      if (idx !== null) occupied.push(idx);
    }
    const occupiedSlots = occupied.length ? Math.min(Math.max(...occupied) + 1, 32) : 0;
    return Math.max(cap > 0 ? refSlotCount(occupied, cap) : 0, occupiedSlots);
  });
  const referenceImageSlots = useStore((s) => {
    const occupied: number[] = [];
    for (const e of s.edges) {
      if (e.target !== id) continue;
      const idx = referenceImageHandleIndex(e.targetHandle);
      if (idx !== null) occupied.push(idx);
    }
    const occupiedSlots = occupied.length ? Math.min(Math.max(...occupied) + 1, 32) : 0;
    return Math.max(
      referenceImageCap > 0 ? refSlotCount(occupied, referenceImageCap) : 0,
      occupiedSlots,
    );
  });
  const previousRefSlots = useRef(`${refSlots}:${referenceImageSlots}`);
  useEffect(() => {
    // React Flow measures handles on mount. Calling updateNodeInternals for every
    // freshly-mounted generator turns a large document into N full graph
    // recalculations; only a real post-mount slot-count change needs the update.
    const slots = `${refSlots}:${referenceImageSlots}`;
    if (previousRefSlots.current === slots) return;
    previousRefSlots.current = slots;
    updateNodeInternals(id);
  }, [id, refSlots, referenceImageSlots, updateNodeInternals]);

  // Runway×Higgsfield widget: a preview SCREEN with the MODEL NAME above it
  // (pressable → model switcher), a settings gear (per-model gen settings), and
  // a tries counter (each try spawns a result node). Prompt is a connected note.
  const hasResult = d.status === 'done' && Boolean(d.resultUrl);
  const hasOriginCast = typeof d.originCastNodeId === 'string' && d.originCastNodeId.length > 0;
  const originCastExists = useStore((state) =>
    hasOriginCast ? state.nodeLookup.has(d.originCastNodeId!) : false,
  );
  const canAppendCastReference = Boolean(
    hasResult && !isVideo && hasOriginCast && originCastExists,
  );
  const rerunWarning = !busy && ((d.takes?.length ?? 0) > 0 || Boolean(d.resultUrl));
  const modelName = current ? modelDisplayName(current) : 'Выбрать модель';
  const count = d.count ?? 1;
  const setCount = (n: number) =>
    patch(id, { count: Math.max(1, Math.min(4, n)) } as Partial<GenerateData>);

  return (
    <div
      data-testid="generate-node-shell"
      data-invalid={invalid ? 'true' : 'false'}
      className={`${shell} ${selected ? shellSel : shellIdle} ${invalid ? 'ring-2 ring-destructive/70' : ''} seed-drag relative flex h-full w-full min-w-[240px] cursor-grab flex-col active:cursor-grabbing`}
    >
      <Resizer visible={selected} minWidth={240} minHeight={256} />

      {/* Name floats ABOVE the card — the single design shared by every widget. */}
      <NodeTitle
        id={id}
        label={`Генерация ${isVideo ? 'видео' : 'изображения'}`}
        testid="node-generate-header"
      />
      <DragHitFrame />

      {/* Ports — pinned to the borders; labels render OUTSIDE the card, on hover. */}
      <InPort
        id={promptPort.handle}
        label="промпт"
        kind={broadPortType(promptPort.payloads[0]!)}
        top={52}
        required={promptPort.required}
        show={selected}
        invalid={Boolean(issueForHandle(promptPort.handle))}
        reason={issueForHandle(promptPort.handle)?.reason}
      />
      {Array.from({ length: refSlots }, (_, i) => {
        const handle = referencePort.handle.replace('[i]', `[${i}]`);
        const issue = issueForHandle(handle);
        const frameRole = modelContract?.imageInput.frameRoles[i];
        return (
          <InPort
            key={handle}
            id={handle}
            label={
              modelContract?.imageInput.role === 'frame'
                ? frameRole === 'first'
                  ? 'первый кадр'
                  : frameRole === 'last'
                    ? 'последний кадр'
                    : `кадр ${i + 1}`
                : refSlots > 1
                  ? `реф ${i + 1}`
                  : 'референс'
            }
            kind={broadPortType(referencePort.payloads[0]!)}
            top={88 + i * 24}
            show={selected || modelContract?.imageInput.role === 'frame'}
            invalid={Boolean(issue)}
            reason={issue?.reason}
          />
        );
      })}
      {Array.from({ length: referenceImageSlots }, (_, i) => {
        const handle = `referenceImages[${i}]`;
        const issue = issueForHandle(handle);
        return (
          <InPort
            key={handle}
            id={handle}
            label={referenceImageSlots > 1 ? `реф ${i + 1}` : 'референс'}
            kind={broadPortType(genericReferencePort.payloads[0]!)}
            top={88 + (refSlots + i) * 24}
            show={selected}
            invalid={Boolean(issue)}
            reason={issue?.reason}
          />
        );
      })}
      <RegistryOutPort
        type="generate"
        data={d as unknown as Record<string, unknown>}
        label={isVideo ? 'видео' : 'картинка'}
        show={selected}
      />

      {settingsOpen ? (
        <NodeSettingsPanel
          id={id}
          d={d}
          onBack={() => setSettingsOpen(false)}
          displayCost={displayCost}
        />
      ) : (
        <>
          {/* MODEL bar (top) — a real field: inset fill, leading chip glyph and a
              trailing chevron so it READS as a changeable selector (was a bare
              label). Border stays soft at rest, periwinkle when open / hovered;
              the dropdown opens DOWN, over the preview, inside the widget. */}
          <div className="nodrag relative px-1.5 pt-1.5" onPointerDown={(e) => e.stopPropagation()}>
            <button
              data-testid="node-model-trigger"
              ref={modelBtnRef}
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              onClick={() => setModelMenuOpen((o) => !o)}
              className={
                'press-inset nodrag flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] border-2 bg-[color:var(--color-surface2)] px-2 py-1.5 text-left text-[13px] font-semibold text-[color:var(--color-fg)] transition-colors ' +
                (modelMenuOpen
                  ? 'border-[color:var(--color-accent)]'
                  : 'border-[color:var(--color-line-soft)] hover:border-[color:var(--color-accent)]')
              }
            >
              {currentLocked ? (
                <Lock size={13} className="shrink-0 text-[color:var(--color-faint)]" />
              ) : (
                <Cpu size={13} className="shrink-0 text-[color:var(--color-faint)]" />
              )}
              <span className="min-w-0 flex-1 truncate">{modelName}</span>
              <ChevronDown
                size={13}
                className={
                  'shrink-0 text-[color:var(--color-faint)] transition-transform ' +
                  (modelMenuOpen ? 'rotate-180' : '')
                }
              />
            </button>
            {/* Model options in a viewport portal (NodeMenu): the old absolute
                dropdown clipped against the canvas edge whenever the node sat
                low or the canvas was zoomed. Same options, same testids. */}
            <NodeMenu
              anchorRef={modelBtnRef}
              open={modelMenuOpen}
              onClose={() => setModelMenuOpen(false)}
              className="glass-menu p-1.5"
              maxMenuHeight={200}
              divProps={{ ...modelMenuWheel }}
            >
              <div className="space-y-0.5">
                {choices.map((m) => {
                  const sel = current?.id === m.id;
                  // Locked rows stay pickable (exactly what ModelEffectPicker
                  // does on /generate) — the wall is the run button below,
                  // which turns into the upgrade CTA. The lock + plan name
                  // replace the price, so it never reads as affordable.
                  const locked = isModelLocked(m, planTier);
                  return (
                    <button
                      key={m.id}
                      data-testid={`node-model-${m.id}`}
                      data-locked={locked ? 'true' : 'false'}
                      title={locked ? tierUpsellLabel(m) : undefined}
                      onClick={() => {
                        requestModelChange(id, m.id);
                        setModelMenuOpen(false);
                      }}
                      className={
                        'nodrag flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[13px] transition-colors ' +
                        (sel
                          ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                          : locked
                            ? 'text-[color:var(--color-faint)] hover:bg-[color:var(--color-surface2)]'
                            : 'text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]')
                      }
                    >
                      <span className="truncate">{modelDisplayName(m)}</span>
                      {locked ? (
                        <span
                          className={
                            'flex shrink-0 items-center gap-1 font-mono text-[11px] font-bold uppercase ' +
                            (sel
                              ? 'text-[color:var(--color-primary-foreground)]'
                              : 'text-[color:var(--color-faint)]')
                          }
                        >
                          {TIER_LABEL[m.tierMin ?? 'creator'] ?? 'Креатор'}
                          <Lock size={11} />
                        </span>
                      ) : sel ? (
                        <Check size={11} className="text-[color:var(--color-primary-foreground)]" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </NodeMenu>
          </div>

          {/* THE SCREEN — the preview fills the card and is part of the drag
              handle (the whole card moves; only the controls are nodrag). */}
          <div
            data-testid="node-screen"
            className="relative mx-3 my-2 min-h-[150px] flex-1 overflow-hidden rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-black"
          >
            {hasResult && d.resultUrl ? (
              <>
                {d.resultKind === 'video' ? (
                  <ResultVideo
                    data-testid="node-result"
                    src={`${assetSrc(d.resultUrl)}#t=0.1`}
                    muted
                    playsInline
                    controls
                    preload="metadata"
                    className="nodrag seed-develop h-full w-full object-cover"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    data-testid="node-result"
                    src={assetSrc(d.resultUrl)}
                    alt=""
                    className="seed-develop h-full w-full object-cover"
                  />
                )}
                <div className="absolute top-1.5 right-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="reroll"
                    disabled={invalid || priceUnknown}
                    onClick={() => run(id)}
                    title={
                      invalid
                        ? invalidReason
                        : priceRefusal
                          ? (priceRefusal.message ??
                            'Не удалось посчитать стоимость этой конфигурации.')
                          : priceUnknown
                            ? 'Стоимость кадра ещё не подтверждена сервером.'
                            : 'Переснять с тем же образом (рефы объекта сохраняются)'
                    }
                    className="nodrag grid h-6 w-6 place-items-center rounded-full bg-black/55 leading-none text-white/75 hover:text-white disabled:opacity-35"
                  >
                    <RefreshCw size={13} aria-hidden />
                  </button>
                  {d.resultKind === 'video' && (
                    <button
                      onClick={() => toTray(id)}
                      title="В монтаж"
                      className="nodrag rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-primary-foreground)]"
                    >
                      В монтаж
                    </button>
                  )}
                </div>
                {/* B-5: mark this take as identity-drifted + reroll keeping the
                    wired character's refs (reroll = re-run; refs re-pulled from
                    the connected cast node → same identity pack). */}
                <button
                  type="button"
                  data-testid="drift-toggle"
                  data-drifted={d.drifted ? 'true' : 'false'}
                  onClick={() => patch(id, { drifted: !d.drifted } as Partial<GenerateData>)}
                  title={d.drifted ? 'Снять пометку дрейфа образа' : 'Образ персонажа дрейфует'}
                  className={
                    'nodrag absolute left-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full text-[13px] font-bold leading-none ' +
                    (d.drifted
                      ? 'bg-[rgba(var(--accent-rgb),0.9)] text-[color:var(--color-primary-foreground)]'
                      : 'bg-black/55 text-white/75 hover:text-white')
                  }
                >
                  ≠
                </button>
              </>
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                {busy ? (
                  <Loader2 size={24} className="seed-spin text-[color:var(--color-accent)]" />
                ) : isVideo ? (
                  <Clapperboard size={28} className="text-white/10" />
                ) : (
                  <ImageIcon size={28} className="text-white/10" />
                )}
              </div>
            )}
          </div>

          {/* B-3: take-strip — pick the best take of this shot; the chosen one
              becomes the node's result (drives the shot list + storyboard). */}
          {d.takes && d.takes.length > 1 && (
            <div
              data-testid="take-strip"
              className="nodrag flex items-center gap-1 px-3 pb-2"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {d.takes.map((url, i) => {
                const chosen = d.resultUrl === url;
                return (
                  <button
                    key={`${url}-${i}`}
                    type="button"
                    data-testid="take-thumb"
                    data-chosen={chosen ? 'true' : 'false'}
                    aria-pressed={chosen}
                    title={chosen ? 'Лучший дубль' : `Сделать лучшим дублем (${i + 1})`}
                    onClick={() => selectResult(id, url)}
                    className={
                      // quiet-nested hairline (1.5px): a small take-selector chip
                      // living inside an already-bordered card, not a primary frame.
                      'relative h-9 w-9 shrink-0 overflow-hidden rounded-[var(--radius-xs)] border-[1.5px] transition-colors ' +
                      (chosen
                        ? 'border-[color:var(--color-accent)]'
                        : 'border-[rgba(var(--paper-rgb),0.12)] hover:border-[rgba(var(--paper-rgb),0.3)]')
                    }
                  >
                    {isVideoUrl(url) ? (
                      <video
                        src={assetSrc(url)}
                        muted
                        playsInline
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={assetSrc(url)} alt="" className="h-full w-full object-cover" />
                    )}
                    {chosen && (
                      <span className="absolute right-0.5 top-0.5 text-[color:var(--color-accent)]">
                        <Star size={9} fill="currentColor" aria-hidden />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {canAppendCastReference && (
            <button
              type="button"
              data-testid="add-to-cast"
              onClick={() => appendCastReference(id)}
              className="press nodrag mx-1.5 mb-1 flex h-7 w-[calc(100%-12px)] shrink-0 items-center justify-center rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-2 text-[11px] font-semibold text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
            >
              Добавить в объект
            </button>
          )}

          {/* control row — tries · gear · run (normal-size text) */}
          <div
            data-testid="node-footer-drag"
            className="seed-drag flex cursor-grab items-center gap-1.5 px-1.5 py-1.5 active:cursor-grabbing"
          >
            {/* tries — takes land in this card's take-strip; −/+ centred + aligned */}
            <div
              className="nodrag flex h-7 shrink-0 items-center rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] px-0.5"
              title="Сколько кадров сгенерировать"
            >
              <button
                data-testid="batch-dec"
                aria-label="Меньше"
                disabled={count <= 1}
                onClick={() => setCount(count - 1)}
                className="press-inset nodrag grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)] disabled:opacity-30"
              >
                <Minus size={13} />
              </button>
              <span
                data-testid="batch-count"
                className="tnum w-4 text-center text-[13px] font-semibold text-[color:var(--color-fg)]"
              >
                {count}
              </span>
              <button
                data-testid="batch-inc"
                aria-label="Больше"
                disabled={count >= 4}
                onClick={() => setCount(count + 1)}
                className="press-inset nodrag grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)] disabled:opacity-30"
              >
                <Plus size={13} />
              </button>
            </div>

            <span className="flex-1" />

            {/* gear → in-widget settings */}
            <button
              data-testid="node-settings-open"
              onClick={() => {
                setSettingsOpen(true);
                requestAnimationFrame(() => {
                  void reactFlow.fitView({
                    nodes: [{ id }],
                    duration: 250,
                    padding: 0.35,
                    maxZoom: 1,
                  });
                });
              }}
              title="Настройки генерации"
              className="press-inset nodrag grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
            >
              <Settings2 size={14} />
            </button>

            {/* run — the one periwinkle action; cost rides inside (no «кр»).
                Out-of-plan model ⇒ the same upsell CTA /generate shows in place
                of its submit button (GenerateClient.tsx:2508-2525). */}
            {currentLocked ? (
              <a
                data-testid="node-run-upsell"
                href={lockedCtaHref}
                title={tierUpsellLabel(current)}
                className="press nodrag flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-2.5 text-[13px] font-semibold text-[color:var(--color-fg)] shadow-[3px_3px_0_0_var(--color-shadow)]"
              >
                <Lock size={13} />
                <span className="font-mono text-[11px] font-bold uppercase">
                  {TIER_LABEL[current?.tierMin ?? 'creator'] ?? 'Креатор'}
                </span>
              </a>
            ) : (
              <button
                data-testid="node-run"
                disabled={busy || invalid || priceUnknown}
                onClick={() => run(id)}
                title={
                  invalid
                    ? invalidReason
                    : priceRefusal
                      ? (priceRefusal.message ??
                        'Не удалось посчитать стоимость этой конфигурации.')
                      : priceUnknown
                        ? 'Стоимость кадра ещё не подтверждена сервером.'
                        : rerunWarning
                          ? 'Запустить генерацию — перезапуск заменит дубли'
                          : 'Запустить генерацию'
                }
                data-price-refused={priceRefusal ? priceRefusal.code : undefined}
                className="press nodrag flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-2.5 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-40"
              >
                {busy ? <Loader2 size={13} className="seed-spin" /> : <Sparkles size={13} />}
                <span data-testid="node-cost" className="tnum">
                  {displayCost ?? '—'}
                </span>
              </button>
            )}
          </div>
          {invalidReason && (
            <div
              data-testid="node-invalid-reason"
              className="nodrag mx-1.5 mb-1.5 flex items-start gap-1.5 rounded-[var(--radius-xs)] border border-destructive/55 bg-destructive/10 px-2 py-1 text-[11px] leading-snug text-destructive"
            >
              <span className="min-w-0 flex-1">{invalidReason}</span>
              {canRepairSettings && (
                <button
                  type="button"
                  data-testid="node-repair-settings"
                  onClick={() => repairNodeSettings(id)}
                  className="shrink-0 font-semibold underline underline-offset-2"
                >
                  Исправить
                </button>
              )}
            </div>
          )}
          {priceRefusal && (
            <div
              data-testid="node-price-refusal"
              role="alert"
              className="nodrag mx-1.5 mb-1.5 rounded-[var(--radius-xs)] border border-destructive/55 bg-destructive/10 px-2 py-1 text-[11px] leading-snug text-destructive"
            >
              {priceRefusal.message ?? 'Эту конфигурацию нельзя оценить. Измените настройки кадра.'}
            </div>
          )}
          {rerunWarning && (
            <div
              data-testid="node-rerun-warning"
              className="nodrag mx-1.5 mb-1.5 rounded-[var(--radius-xs)] border border-[color:var(--color-line-soft)] px-2 py-1 text-[11px] leading-snug text-[color:var(--color-muted-foreground)]"
            >
              Перезапуск заменит дубли
            </div>
          )}
        </>
      )}
      {d.status === 'failed' && (
        <div
          data-testid="node-failure-reason"
          className="nodrag mx-1.5 mb-1.5 rounded-[var(--radius-xs)] border border-destructive/55 bg-destructive/10 px-2 py-1.5 text-[11px] leading-snug text-destructive"
        >
          <p>{d.failureMessage ?? 'Генерация не завершилась. Повторите запуск.'}</p>
          {d.failureAction === 'retry' && (
            <button
              type="button"
              data-testid="node-failure-action"
              disabled={priceUnknown}
              onClick={() => run(id)}
              className="mt-1 font-semibold underline underline-offset-2"
            >
              Повторить
            </button>
          )}
          {d.failureAction === 'settings' && (
            <button
              type="button"
              data-testid="node-failure-action"
              onClick={() => setSettingsOpen(true)}
              className="mt-1 font-semibold underline underline-offset-2"
            >
              Открыть настройки
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * At Fit/overview zoom the controls inside 200 full editor cards are below a
 * usable pixel size but still expensive to mount. Keep the semantic card,
 * status, and every connected/available handle so the graph remains legible;
 * mount the editable renderer again as soon as the user zooms into working
 * range. This is visual level-of-detail, not a second document model.
 */
function OverviewNode({ id, type, data, selected }: NodeProps & { type: BoardNodeType }) {
  const { modelForNode } = useGraph();
  const raw = data as Record<string, unknown>;
  const generate = type === 'generate' ? (data as unknown as GenerateData) : null;
  const overviewModelContract = generate ? resolveBoardModelContract(modelForNode(generate)) : null;
  const overviewReferenceCap = overviewModelContract ? overviewModelContract.imageInput.max : 0;
  const overviewReferenceImageCap = overviewModelContract?.referenceImageMax ?? 0;
  const refSlots = useStore((state) => {
    if (!generate) return 0;
    const occupied: number[] = [];
    for (const edge of state.edges) {
      if (edge.target !== id) continue;
      const index = imageHandleIndex(edge.targetHandle);
      if (index !== null) occupied.push(index);
    }
    const occupiedSlots = occupied.length ? Math.max(...occupied) + 1 : 0;
    return Math.max(
      overviewReferenceCap > 0 ? refSlotCount(occupied, overviewReferenceCap) : 0,
      occupiedSlots,
    );
  });
  const referenceImageSlots = useStore((state) => {
    if (!generate) return 0;
    const occupied: number[] = [];
    for (const edge of state.edges) {
      if (edge.target !== id) continue;
      const index = referenceImageHandleIndex(edge.targetHandle);
      if (index !== null) occupied.push(index);
    }
    const occupiedSlots = occupied.length ? Math.max(...occupied) + 1 : 0;
    return Math.max(
      overviewReferenceImageCap > 0 ? refSlotCount(occupied, overviewReferenceImageCap) : 0,
      occupiedSlots,
    );
  });
  const outputPort = BOARD_NODE_REGISTRY[type].outputPorts(raw)[0];
  const outputHandle = outputPort?.handle ?? '';
  const outputKind = outputPort ? broadPortType(outputPort.payloads[0]!) : null;
  const castKindLabel =
    raw['castKind'] === 'location'
      ? CAST_KIND_LABEL.location
      : raw['castKind'] === 'product'
        ? CAST_KIND_LABEL.product
        : CAST_KIND_LABEL.character;
  const label =
    type === 'generate'
      ? generate?.mode === 'image'
        ? 'Кадр · изображение'
        : 'Кадр · видео'
      : type === 'prompt'
        ? 'Промпт'
        : type === 'aiprompt'
          ? 'AI-промпт'
          : type === 'media'
            ? 'Референс'
            : type === 'cast'
              ? `${CAST_NODE_LABEL} · ${castKindLabel}`
              : type === 'scene'
                ? 'Сцена'
                : type === 'text'
                  ? 'Текст'
                  : type === 'frame'
                    ? 'Рамка'
                    : 'Заметка';
  const status = generate?.status;
  const accent =
    status === 'done'
      ? 'var(--color-accent2)'
      : status === 'running'
        ? 'var(--color-accent)'
        : status === 'failed'
          ? 'var(--color-destructive)'
          : 'var(--color-faint)';

  return (
    <div
      data-testid={type === 'generate' ? 'generate-node-shell' : undefined}
      data-overview="true"
      className={`${shell} ${selected ? shellSel : shellIdle} relative flex h-full w-full items-center justify-center overflow-hidden`}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-2" style={{ background: accent }} />
      <span className="max-w-[80%] truncate font-mono text-[20px] font-black uppercase tracking-wide text-[color:var(--color-fg)]">
        {label}
      </span>
      {generate && (
        <>
          <Handle
            id="prompt"
            type="target"
            position={Position.Left}
            className="seed-port"
            style={
              {
                top: 52,
                ['--port-rgb']: PORT_RGB.text,
              } as React.CSSProperties
            }
            title="промпт"
          />
          {Array.from({ length: refSlots }, (_, index) => (
            <Handle
              key={`images[${index}]`}
              id={`images[${index}]`}
              type="target"
              position={Position.Left}
              className="seed-port"
              style={
                {
                  top: 88 + index * 24,
                  ['--port-rgb']: PORT_RGB.image,
                } as React.CSSProperties
              }
              title={
                overviewModelContract?.imageInput.role === 'frame'
                  ? overviewModelContract.imageInput.frameRoles[index] === 'first'
                    ? 'первый кадр'
                    : overviewModelContract.imageInput.frameRoles[index] === 'last'
                      ? 'последний кадр'
                      : `кадр ${index + 1}`
                  : `референс ${index + 1}`
              }
            />
          ))}
          {Array.from({ length: referenceImageSlots }, (_, index) => (
            <Handle
              key={`referenceImages[${index}]`}
              id={`referenceImages[${index}]`}
              type="target"
              position={Position.Left}
              className="seed-port"
              style={
                {
                  top: 88 + (refSlots + index) * 24,
                  ['--port-rgb']: PORT_RGB.image,
                } as React.CSSProperties
              }
              title={`референс ${index + 1}`}
            />
          ))}
        </>
      )}
      {type === 'aiprompt' && (
        <Handle
          id="scene"
          type="target"
          position={Position.Left}
          className="seed-port"
          style={
            {
              top: '50%',
              ['--port-rgb']: PORT_RGB.scene,
            } as React.CSSProperties
          }
          title="сцена"
        />
      )}
      {type === 'cast' && (
        <Handle
          id="scene"
          type="target"
          position={Position.Left}
          className="seed-port"
          style={{ top: '50%', ['--port-rgb']: PORT_RGB.scene } as React.CSSProperties}
          title="сцена"
        />
      )}
      {type !== 'note' && outputPort && outputKind && (
        <Handle
          id={outputHandle}
          type="source"
          position={Position.Right}
          className="seed-port"
          style={
            {
              top: '50%',
              ['--port-rgb']: PORT_RGB[outputKind],
            } as React.CSSProperties
          }
          title={label}
        />
      )}
    </div>
  );
}

function useOverviewRenderer() {
  return useStore((state) => state.transform[2] < BOARD_OVERVIEW_ZOOM);
}

function PromptNode(props: NodeProps) {
  return useOverviewRenderer() ? (
    <OverviewNode {...props} type="prompt" />
  ) : (
    <PromptNodeDetail {...props} />
  );
}

function AiPromptNode(props: NodeProps) {
  return useOverviewRenderer() ? (
    <OverviewNode {...props} type="aiprompt" />
  ) : (
    <AiPromptNodeDetail {...props} />
  );
}

function NoteNode(props: NodeProps) {
  return useOverviewRenderer() ? (
    <OverviewNode {...props} type="note" />
  ) : (
    <NoteNodeDetail {...props} />
  );
}

function TextNode(props: NodeProps) {
  return useOverviewRenderer() ? (
    <OverviewNode {...props} type="text" />
  ) : (
    <TextNodeDetail {...props} />
  );
}

function FrameNode(props: NodeProps) {
  return useOverviewRenderer() ? (
    <OverviewNode {...props} type="frame" />
  ) : (
    <FrameNodeDetail {...props} />
  );
}

function SceneNode(props: NodeProps) {
  return useOverviewRenderer() ? (
    <OverviewNode {...props} type="scene" />
  ) : (
    <SceneNodeDetail {...props} />
  );
}

function MediaNode(props: NodeProps) {
  return useOverviewRenderer() ? (
    <OverviewNode {...props} type="media" />
  ) : (
    <MediaNodeDetail {...props} />
  );
}

function CastNode(props: NodeProps) {
  return useOverviewRenderer() ? (
    <OverviewNode {...props} type="cast" />
  ) : (
    <CastNodeDetail {...props} />
  );
}

function GenerateNode(props: NodeProps) {
  return useOverviewRenderer() ? (
    <OverviewNode {...props} type="generate" />
  ) : (
    <GenerateNodeDetail {...props} />
  );
}

export const nodeTypes = {
  prompt: PromptNode,
  aiprompt: AiPromptNode,
  note: NoteNode,
  text: TextNode,
  frame: FrameNode,
  scene: SceneNode,
  media: MediaNode,
  cast: CastNode,
  generate: GenerateNode,
};

// Default data for a freshly-spawned node of each type. Shared by the add-menu
// (addNode) and the drag-to-empty-canvas connect menu (addNodeConnected).
export const NODE_BASE: Record<keyof typeof nodeTypes, AnyData> = {
  prompt: boardNodeDefaultData('prompt') as PromptData,
  aiprompt: boardNodeDefaultData('aiprompt') as AiPromptData,
  note: boardNodeDefaultData('note') as NoteData,
  text: boardNodeDefaultData('text') as TextData,
  frame: boardNodeDefaultData('frame') as FrameData,
  scene: boardNodeDefaultData('scene') as SceneData,
  media: boardNodeDefaultData('media') as MediaData,
  cast: boardNodeDefaultData('cast') as CastData,
  generate: boardNodeDefaultData('generate') as GenerateData,
};

// One default size for EVERY widget when spawned — uniform, comfortable, and
// big enough that the prompt/note widgets aren't cramped. Resizable after.
export const NODE_W = BOARD_NODE_W;
export const NODE_H = BOARD_NODE_H;

/* ------------------------------------------------------------------ *
 *  Drag-to-empty-canvas connect menu (Runway pattern): release a wire
 *  over blank canvas and we offer to CREATE + auto-wire the node that
 *  legally belongs on the other end. The offer set mirrors `isValid`,
 *  but framed as "what can I make here?" instead of "is this allowed?".
 * ------------------------------------------------------------------ */
export interface DropOffer {
  key: string;
  label: string;
  hint?: string;
  icon: CatalogItem['icon'];
  t: keyof typeof nodeTypes;
  d: Partial<AnyData>;
  // `newSource`: the created node feeds INTO the handle we dragged from.
  // `newTarget`: the created node CONSUMES the handle we dragged from.
  wire: 'newSource' | 'newTarget';
  newHandle: string; // the handle on the CREATED node that carries the edge
}

/**
 * Quick-connect may create an empty object card already wired to a shot. The
 * empty card is intentional planned work: it becomes executable after the
 * author uploads or generates its first reference. Validate that prospective
 * edge against one placeholder image, but persist the real empty card.
 *
 * Keep this shared with the commit path. Filtering an offer with a placeholder
 * and then committing it against different data leaves a menu action that
 * appears valid but creates nothing.
 */
export function dropOfferValidationData(
  offer: Pick<DropOffer, 't' | 'wire'>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return offer.t === 'cast' && offer.wire === 'newSource'
    ? { ...data, imageUrls: ['planned-ref'] }
    : data;
}

export function connectOffers(
  origin: Pick<Node, 'type' | 'data'>,
  fromHandle: string | null,
  fromType: 'source' | 'target',
  modelForTarget: (data: GenerateData) => ModelRow | undefined,
  existingInputs: {
    source: Pick<BoardNode, 'type' | 'data'>;
    sourceHandle: string | null | undefined;
    targetHandle: string | null | undefined;
  }[] = [],
): DropOffer[] {
  const originType = origin.type ?? '';
  if (!(originType in BOARD_NODE_REGISTRY)) return [];
  const filterCompatible = (offers: DropOffer[]) =>
    offers.filter((offer) => {
      const created = {
        type: offer.t,
        data: boardNodeDefaultData(offer.t, offer.d as Record<string, unknown>),
      } as Pick<BoardNode, 'type' | 'data'>;
      // A connect-menu cast node is intentionally created empty, then filled by
      // upload. Use one placeholder still only for capability filtering so a
      // reference model can offer the planned node while frame-only models do not.
      const compatibilitySource =
        created.type === 'cast'
          ? ({
              ...created,
              data: dropOfferValidationData(offer, created.data as Record<string, unknown>),
            } as Pick<BoardNode, 'type' | 'data'>)
          : created;
      const existing = {
        type: originType as BoardNodeType,
        data: origin.data,
      } as Pick<BoardNode, 'type' | 'data'>;
      const source = offer.wire === 'newSource' ? compatibilitySource : existing;
      const target = offer.wire === 'newSource' ? existing : created;
      const sourceHandle = offer.wire === 'newSource' ? offer.newHandle : fromHandle;
      const targetHandle = offer.wire === 'newSource' ? fromHandle : offer.newHandle;
      if (target.type !== 'generate') {
        if (!validateBoardConnectionShape({ source, sourceHandle, target, targetHandle }).ok) {
          return false;
        }
        return !(
          (target.type === 'aiprompt' || target.type === 'cast') &&
          targetHandle === 'scene' &&
          isBoardConnectionTargetOccupied(existingInputs, 'scene')
        );
      }
      return validateBoardConnections({
        target,
        targetModel: modelForTarget(target.data as GenerateData),
        connections: [
          ...(offer.wire === 'newSource' ? existingInputs : []),
          { source, sourceHandle, targetHandle },
        ],
      }).ok;
    });
  const genVideo = {
    t: 'generate' as const,
    d: { mode: 'video' } as Partial<AnyData>,
    icon: 'video' as const,
    hint: 'Seedance',
  };
  const genImage = {
    t: 'generate' as const,
    d: { mode: 'image' } as Partial<AnyData>,
    icon: 'image' as const,
    hint: 'Seedream',
  };

  if (fromType === 'target') {
    // dragged from an INPUT port → the new node must SOURCE into it
    if (originType === 'aiprompt' && fromHandle === 'scene') {
      return filterCompatible([
        {
          key: 'scene',
          label: 'Сцена',
          hint: 'контекст',
          icon: 'scene',
          t: 'scene',
          d: {},
          wire: 'newSource',
          newHandle: 'context',
        },
      ]);
    }
    if (originType === 'cast' && fromHandle === 'scene') {
      return filterCompatible([
        {
          key: 'scene',
          label: 'Сцена',
          hint: 'контекст',
          icon: 'scene',
          t: 'scene',
          d: {},
          wire: 'newSource',
          newHandle: 'context',
        },
      ]);
    }
    if (originType !== 'generate') return [];
    if (fromHandle === 'prompt') {
      return filterCompatible([
        {
          key: 'prompt',
          label: 'Промпт',
          hint: 'текст',
          icon: 'prompt',
          t: 'prompt',
          d: {},
          wire: 'newSource',
          newHandle: 'text',
        },
        {
          key: 'aiprompt',
          label: 'AI-промпт',
          hint: 'Claude/GPT',
          icon: 'aiprompt',
          t: 'aiprompt',
          d: {},
          wire: 'newSource',
          newHandle: 'text',
        },
      ]);
    }
    if (imageHandleIndex(fromHandle) !== null || referenceImageHandleIndex(fromHandle) !== null) {
      return filterCompatible([
        {
          key: 'media',
          label: 'Референс',
          hint: 'загрузка',
          icon: 'media',
          t: 'media',
          d: {},
          wire: 'newSource',
          newHandle: 'out',
        },
        {
          key: 'character',
          label: CAST_KIND_LABEL.character,
          hint: 'набор референсов',
          icon: 'character',
          t: 'cast',
          d: { castKind: 'character' },
          wire: 'newSource',
          newHandle: 'out',
        },
        {
          key: 'location',
          label: CAST_KIND_LABEL.location,
          hint: 'набор референсов',
          icon: 'location',
          t: 'cast',
          d: { castKind: 'location' },
          wire: 'newSource',
          newHandle: 'out',
        },
        {
          key: 'product',
          label: CAST_KIND_LABEL.product,
          hint: 'набор референсов',
          icon: 'image',
          t: 'cast',
          d: { castKind: 'product' },
          wire: 'newSource',
          newHandle: 'out',
        },
        {
          key: 'gen-image',
          label: 'Кадр · картинка',
          ...genImage,
          wire: 'newSource',
          newHandle: 'out',
        },
      ]);
    }
    return [];
  }

  // dragged from an OUTPUT port → the new node must CONSUME it
  if (originType === 'scene' && fromHandle === 'context') {
    return filterCompatible([
      {
        key: 'aiprompt',
        label: 'AI-промпт',
        hint: 'контекст сцены',
        icon: 'aiprompt',
        t: 'aiprompt',
        d: {},
        wire: 'newTarget',
        newHandle: 'scene',
      },
      {
        key: 'cast-character',
        label: CAST_KIND_LABEL.character,
        hint: 'контекст сцены',
        icon: 'character',
        t: 'cast',
        d: { castKind: 'character' },
        wire: 'newTarget',
        newHandle: 'scene',
      },
    ]);
  }
  if (originType === 'prompt' || originType === 'aiprompt') {
    return filterCompatible([
      {
        key: 'gen-video',
        label: 'Кадр · видео',
        ...genVideo,
        wire: 'newTarget',
        newHandle: 'prompt',
      },
      {
        key: 'gen-image',
        label: 'Кадр · картинка',
        ...genImage,
        wire: 'newTarget',
        newHandle: 'prompt',
      },
    ]);
  }
  if (originType === 'media' || originType === 'cast' || originType === 'generate') {
    return filterCompatible([
      {
        key: 'gen-video',
        label: 'Кадр · видео',
        ...genVideo,
        wire: 'newTarget',
        newHandle: 'images[0]',
      },
      {
        key: 'gen-image',
        label: 'Кадр · картинка',
        ...genImage,
        wire: 'newTarget',
        newHandle: 'images[0]',
      },
    ]);
  }
  return [];
}

/* ------------------------------------------------------------------ *
 *  Typed edge — colour-coded by payload with a midpoint data chip and
 *  a hover «remove connection» handle (Higgsfield's edge-midpoint
 *  delete). Delete-key removal still works too (deleteKeyCode).
 * ------------------------------------------------------------------ */
function TypedEdgeDetail({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) {
  const { removeEdge, edgeIssuesFor, edgeRoleFor } = useGraph();
  const issues = edgeIssuesFor(id);
  const invalid = issues.length > 0;
  const role = edgeRoleFor(id);
  const sourceHandle = useStore((s) => s.edges.find((edge) => edge.id === id)?.sourceHandle);
  const kind = useStore((s) => {
    const n = s.nodeLookup.get(source);
    return edgePayloadType(
      n ? { type: n.type, data: n.data as Record<string, unknown> } : undefined,
      sourceHandle,
    );
  });
  const color = invalid
    ? 'var(--color-destructive)'
    : kind
      ? PORT_COLOR[kind]
      : 'rgba(var(--paper-rgb),0.4)';
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const style = {
    stroke: color,
    strokeWidth: invalid || selected ? 2.5 : 1.5,
    opacity: 0.9,
    ...(invalid ? { strokeDasharray: '6 4' } : {}),
  };
  return (
    <>
      <BaseEdge id={id} path={path} style={style} />
      <EdgeLabelRenderer>
        <div
          className="group/edge nodrag nopan absolute flex items-center gap-1"
          style={{
            transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
        >
          {kind && (
            <span
              data-testid={`edge-role-${id}`}
              data-invalid={invalid ? 'true' : 'false'}
              title={invalid ? issues.map((issue) => issue.reason).join(' ') : role?.label}
              className="select-none rounded-[var(--radius-xs)] px-1.5 py-px font-mono text-[11px] font-bold uppercase tracking-wide"
              style={{
                color,
                background: `color-mix(in srgb, ${color} 14%, transparent)`,
                border: `1.5px solid color-mix(in srgb, ${color} 40%, transparent)`,
              }}
            >
              {invalid ? 'ошибка' : (role?.label ?? PAYLOAD_LABEL[kind])}
            </span>
          )}
          <button
            data-testid={`edge-remove-${id}`}
            title="Убрать связь"
            onClick={() => removeEdge(id)}
            className="grid h-4 w-4 place-items-center rounded-[var(--radius-xs)] border-[1.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] opacity-0 transition-opacity hover:text-destructive group-hover/edge:opacity-100 touch:opacity-100"
          >
            <X size={9} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function OverviewTypedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <BaseEdge
      id={id}
      path={path}
      style={{
        stroke: 'rgba(var(--paper-rgb),0.38)',
        strokeWidth: selected ? 2.5 : 1.5,
        opacity: 0.72,
      }}
    />
  );
}

function TypedEdge(props: EdgeProps) {
  return useOverviewRenderer() ? <OverviewTypedEdge {...props} /> : <TypedEdgeDetail {...props} />;
}

export const edgeTypes = { typed: TypedEdge };
