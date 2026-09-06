'use client';

import { trackEvent, PlausibleEvent } from '../../_components/PlausibleEvents';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  ConnectionMode,
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  SelectionMode,
  addEdge,
  getBezierPath,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  useStoreApi,
  useUpdateNodeInternals,
  useViewport,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type IsValidConnection,
  type FinalConnectionState,
  type OnNodesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Clapperboard,
  Cpu,
  Hand,
  Image as ImageIcon,
  Keyboard,
  Loader2,
  Map as MapIcon,
  MapPin,
  Maximize,
  Minus,
  MousePointer2,
  Play,
  Plus,
  Redo2,
  Settings2,
  Sparkles,
  StickyNote,
  Trash2,
  Undo2,
  UserRound,
  Volume2,
  VolumeX,
  Check,
  Clock3,
  ChevronDown,
  ChevronLeft,
  GripVertical,
  X,
  Film,
  ListChecks,
  Star,
  ZoomIn,
  ZoomOut,
} from '@/components/ui/icons';
import { TokenStar } from '@/components/ui/token-star';
import type { ModelRow } from '../../generate/GenerateClient';
import { JOB_EVENT, JOB_SUBMITTED_EVENT } from '../../_components/JobsTray';
import { invalidateBalance } from '../../_components/BalanceWidget';
import { SaveIndicator, useSaveStatus } from '../../_components/SaveIndicator';
import { Switch } from '@/components/ui/switch';
import { assetSrc } from '@/lib/asset-src';
import { withProjectContext } from '@/lib/project-context';
import {
  BOARD_NODE_REGISTRY,
  BOARD_LIMITS,
  BOARD_NODE_VERSION,
  BOARD_SCHEMA_VERSION,
  normalizeBoardNodeOrder,
  boardInputPort,
  boardGenerateGraphHasCycle,
  boardGenerateSettingsPatch,
  boardNodeDefaultData,
  boardOutputPort,
  compileBoardGenerationRequest,
  parseBoardDocument,
  resolveBoardModelContract,
  validateBoardConnections,
  validateBoardConnectionShape,
  type BoardAiPromptData,
  type BoardCastData,
  type BoardCompiledFrameImage,
  type BoardDocument,
  type BoardGenerateData,
  type BoardMediaData,
  type BoardNode,
  type BoardNodeType,
  type BoardNoteData,
  type BoardPromptData,
  type BoardSceneData,
  type BoardResolvedModelContract,
  type BoardSemanticPayload,
} from '@seed/shared/board-contract';
import { compareBoardReadingOrder } from '@seed/shared/board-order';
import { resolveGeneratePrompt } from '@seed/shared/board-prompt';
import { buildSceneContext } from '@seed/shared/scene-context';
import {
  analyzeBoardModelChange,
  type BoardConnectionRole,
  type BoardEdgeDiagnostic,
  type BoardGraphNodeLike,
  type BoardModelChangeImpact,
  type BoardTargetDiagnostic,
  type BoardTargetInput,
} from '@seed/shared/board-diagnostics';
import { createAutosaveScheduler } from '../../../lib/autosave';
import {
  createBoardAutosaveEngine,
  type BoardAutosaveEngine,
} from '../../../lib/board-autosave-engine';
import { BoardDocumentGraphCache } from '../../../lib/board-document-graph';
import { BoardGraphDiagnosticsCache } from '../../../lib/board-diagnostics-cache';
import { createBoardConnectionPolicy } from '../../../lib/board-connection-policy';
import {
  mergeSceneObjects,
  projectSceneObjectExtraction,
} from '../../../lib/scene-object-response';
import {
  clearBoardSelection,
  copyBoardSelection,
  duplicateBoardSelection,
  isBoardTypingTarget,
  pasteBoardClipboard,
  patchBoardNode,
  removeBoardFrame,
  removeBoardNode,
  removeBoardSelection,
  selectedBoardNodeIds,
  selectAllBoardNodes,
  type BoardClipboard,
  wrapBoardSelectionInFrame,
} from '../../../lib/board-graph-commands';
import { putBoardDocument } from '../../../lib/board-persistence';
import {
  boardRevision,
  clearBoardRecovery,
  createBoardRecoverySnapshotFromDocument,
  getBoardRecoveryClientId,
  readBoardRecovery,
  sameBoardDocument,
  writeBoardRecovery,
  type BoardRecoverySnapshot,
} from '../../../lib/board-recovery';
import { uploadMediaFile } from '../../../lib/upload';
import {
  SHOT_SIZES,
  SHOT_MOVES,
  SHOT_LENSES,
  SHOT_LIGHT,
  SHOT_COLOR_TEMP,
  SHOT_GENRE,
  SHOT_ENERGY,
  MAX_MOVES,
  buildShotPrompt,
  effectiveMoves,
  shotGrammarLabel,
  toggleMove,
  type ShotGrammar,
} from '../../../lib/film-grammar';
import {
  SnapshotHistory,
  isVolatilePatch,
  mergeVolatile,
  patchNeedsStoreSync,
} from '../../../lib/graph-history';
import { jobFailureGuidance } from '../../../lib/job-failure';
import { plural } from '../../../lib/home-utils';
import { deriveShotList, type ShotEdgeLike, type ShotNodeLike } from '../../../lib/shot-list';
import { buildStoryboardHtml } from '../../../lib/storyboard';
import { identityRefQuality, shotsUsingCharacter } from '../../../lib/identity';
import { clampNodePosition, findFreePosition } from '../../../lib/spawn-position';
import {
  imageHandleIndex,
  normalizeRefEdges,
  referenceImageHandleIndex,
  refSlotCount,
} from '../../../lib/ref-ports';
import { edgePayloadType, PAYLOAD_LABEL } from '../../../lib/edge-payload';
import { planRunAll, type PlanEdge, type PlanNode, type RunPlan } from '../../../lib/run-plan';
import {
  planSceneContinuityShot,
  type SceneContinuityLimits,
  type SceneContinuityOverflowItem,
  type SceneContinuityPlan,
} from '../../../lib/scene-continuity-bridge';
import { sceneObjectKey } from '@seed/shared/scene-objects';
import { validateBoardCommit } from '../../../lib/board-commit-guard';
import { planCastStillAdd, planCastStillRemove } from '../../../lib/cast-pack-edit';
import {
  CastPackDetachDialog,
  SceneObjectPromotionDialog,
  SceneObjectSubsetSheet,
  type SceneObjectPromotionRequest,
} from './SceneContinuityDialogs';
import { boardBatchCost, boardTakesInSubmitOrder } from '../../../lib/board-generation-batch';
import { boardRunModelLocked } from '../../../lib/board-run-request';
import { executeBoardRunPlan, resumePersistedBoardJobs } from '../../../lib/board-runner';
import { BoardHistoryPanel } from './BoardHistoryPanel';
import {
  DagTaskDeadlineError,
  createDagRunControl,
  withAbortDeadline,
  type DagRunControl,
} from '../../../lib/run-scheduler';
import {
  defaultModelForMode,
  modelsForMode,
  unlockedModelsForMode,
  nodeEstimateRequest,
  resolveModel,
  resolveImageSettings,
  resolveVideoSettings,
  imageAspectsFor,
  imageQualitiesFor,
  videoAspectsFor,
  videoResolutionsFor,
  videoDurationsFor,
  DURATION_MIN,
  DURATION_MAX,
  type NodeSettings,
  type NodeEstimateRequest,
} from '../../../lib/node-settings';
import { estimatePriceToShow, hasKnownJobEstimate, useJobEstimate } from '@/lib/useJobEstimate';
import {
  boardQuoteKey,
  createBoardQuoteRegistry,
  isVideoShotResult,
  wiredImageRefs,
  wiredVideoRefUrls,
  type BoardQuoteNodeLike,
} from '../../../lib/board-quote';
import { tierUpsellLabel } from '../../../lib/model-tier';
import { modelDisplayName } from '../../../lib/models';
import {
  resolveProvider,
  willDropVideoRefs,
  GATEWAY_POLICIES,
  type GatewayPolicy,
} from '../../../lib/gateway-routing';
import {
  assembleShotRefs,
  castPromptPrefix,
  type CastLike,
  type RefSource,
} from '../../../lib/cast';
import { aiPromptClaimKey, shouldRetainAiPromptClaim } from '../../../lib/ai-prompt-idempotency';

import { planKeyframeBridge } from '../../../lib/keyframe';
import {
  appendCastReference as appendCastReferenceToGraph,
  isCastReferenceSceneSeedable,
  planCastReference,
} from '../../../lib/cast-reference';
import {
  buildRefMentions,
  insertMentionToken,
  mentionQueryBeforeCursor,
  type MentionSource,
  type RefMention,
} from '../../../lib/ref-mentions';
import {
  BOARD_OVERVIEW_ZOOM,
  BoardGraphContext,
  NODE_BASE,
  NODE_H,
  NODE_W,
  connectOffers,
  dropOfferValidationData,
  edgeTypes,
  nodeTypes,
  withWholeNodeDrag,
  type DropOffer,
  type GraphActions,
} from './BoardNodes';
import {
  BoardOverviewCanvas,
  CanvasRail,
  CastPanel,
  catalogIcon,
  filterCatalog,
  type CanvasTool,
} from './BoardCanvasChrome';
import { BoardExportMenu, BoardStudioSheet } from './BoardExportSurfaces';
import { ProjectMediaPicker } from './ProjectMediaPicker';
import { useResolvedAssets } from '@/lib/asset-lifecycle';
import { ScenarioSourcePicker } from './ScenarioSourcePicker';
import { StudioDestinationDialog } from './StudioDestinationDialog';

const BOARD_JOB_NETWORK_TIMEOUT_MS = 30_000;
const SCENE_OBJECTS_NETWORK_TIMEOUT_MS = 120_000;

function sceneObjectsErrorMessage(status: number, error: unknown): string {
  switch (error) {
    case 'signup_required':
      return 'Разбор сцен доступен после регистрации.';
    case 'not_found':
      return 'Сцена не найдена.';
    case 'scene_removed':
      return 'Сцена удалена из сценария.';
    case 'scene_objects_in_progress':
      return 'Разбор уже выполняется — дождитесь результата.';
    case 'scene_source_empty':
      return 'В сцене нет текста для разбора.';
    case 'scene_objects_unusable':
      return 'Не удалось получить пригодные объекты из сцены.';
    case 'rate_limit_exceeded':
      return 'Лимит разборов исчерпан — попробуйте позже.';
    case 'invalid_board_state':
      return 'Состояние борда некорректно — обновите его.';
    case 'scene_objects_failed':
      return 'Разбор сцены не удался — попробуйте позже.';
    case 'scene_objects_timeout':
      return 'Разбор сцены занял слишком много времени — попробуйте позже.';
    case 'generation_disabled':
      return 'Разбор сцен отключён администратором.';
    case 'daily_spend_cap_unconfigured':
      return 'Дневной бюджет разбора не настроен.';
    case 'daily_spend_unavailable':
      return 'Не удалось проверить дневной бюджет разбора — попробуйте позже.';
    case 'scene_objects_daily_cap_unconfigured':
    case 'scene_objects_daily_unavailable':
    case 'scene_objects_unavailable':
    case 'scene_objects_daily_cap_exceeded':
    case 'daily_spend_cap_exceeded':
      return 'Разбор сцены временно недоступен — попробуйте позже.';
    default:
      return `Разбор сцены не удался (HTTP ${status}).`;
  }
}

/**
 * «Борд» as a node graph — one coherent model (per the Higgsfield
 * reverse-engineering playbook): every generation is a node with typed
 * ports, you draw connections (prompt → generate, image → video), and
 * Run executes the wired graph. No competing composer/modal — adding a
 * node and pressing Run is the only way to generate.
 */

type PromptData = BoardPromptData;
/** AI-промпт — a brief + a text model drafts a generation
 * prompt. Switches to the result on draft; the `текст` output carries `result`
 * (falls back to the brief) into a shot's prompt slot, exactly like PromptData. */
type AiTextModel = BoardAiPromptData['model'];
type AiPromptData = BoardAiPromptData;
type NoteData = BoardNoteData;
type SceneData = BoardSceneData;
type MediaData = BoardMediaData;
type SceneObjectsResult = {
  objects: { kind: 'person' | 'place' | 'thing'; name: string }[];
  sourceTruncated: boolean;
  error?: string;
};
/** Персонаж / Локация — a NAMED reference set the cast panel tracks (S2).
 * Wire it into shots: its stills join the shot's reference pool subject-first
 * and its name is prepended to the prompt (no API-level roles exist). */
type CastData = BoardCastData;
type GenerateData = BoardGenerateData;
type AnyData =
  | PromptData
  | AiPromptData
  | NoteData
  | SceneData
  | MediaData
  | GenerateData
  | CastData;

/** Everything undo/redo travels through together. */
interface BoardSnapshot {
  nodes: Node[];
  edges: Edge[];
  tray: string[];
}

interface ModelChangeDialogState {
  nodeId: string;
  current: ModelRow | undefined;
  next: ModelRow;
  suggestion: ModelRow | undefined;
  impact: BoardModelChangeImpact;
}

type RunAllQuote = {
  /** Price of ONE job — the number the runner binds. Never the batch total. */
  cost: number | null;
  /** Jobs this row will submit: 1, or `count` for a video shot with takes. */
  takes: number;
  refusal: { code: string; message: string | null } | null;
  /** `boardQuoteKey` of the request this row quoted, so the approved total's
   *  addends are the numbers the runner binds. Null when there is no request. */
  key: string | null;
};

type BoardJobBatchState = {
  jobIds: string[];
  terminal: Set<string>;
  failed: Set<string>;
  successful: Set<string>;
  assetsByJobId: Map<string, string[]>;
  mainByJobId: Map<string, string>;
  lastFrameByJobId: Map<string, string>;
  initialTakes: string[];
  initialLastFrameUrl?: string;
  failure: ReturnType<typeof jobFailureGuidance> | null;
};

function createBoardJobBatchState(
  jobIds: readonly string[],
  initialTakes: readonly string[] = [],
  initialLastFrameUrl?: string,
): BoardJobBatchState {
  return {
    jobIds: [...jobIds],
    terminal: new Set(),
    failed: new Set(),
    successful: new Set(),
    assetsByJobId: new Map(),
    mainByJobId: new Map(),
    lastFrameByJobId: new Map(),
    initialTakes: [...initialTakes],
    ...(initialLastFrameUrl ? { initialLastFrameUrl } : {}),
    failure: null,
  };
}

function RunAllQuoteRow({
  apiUrl,
  item,
  index,
  prompt,
  request,
  onQuote,
}: {
  apiUrl: string;
  item: RunPlan['items'][number];
  index: number;
  /** The node's own text, shown as the row label. NOT a pricing input — but it
   *  must stay a prop: dropping it silently resolves `prompt` to window.prompt. */
  prompt: string | undefined;
  request: NodeEstimateRequest | undefined;
  onQuote: (id: string, quote: RunAllQuote) => void;
}) {
  const estimate = useJobEstimate({
    apiUrl,
    modelId: request?.modelId,
    // The compiler's placeholder is schema-valid even before the node has
    // text. Prompt is not a pricing input, so Run All quotes it immediately.
    prompt: request?.prompt ?? '',
    params: request?.params ?? {},
    // The SUM: the server prices «how many input images will exist», and a frame
    // is one of them. Only the local key needs to know which channel they land in.
    pendingReferenceCount:
      (request?.pendingReferenceCount ?? 0) + (request?.pendingFrameCount ?? 0),
    source: 'boards',
    enabled: Boolean(request),
    requiresPrompt: false,
  });
  const quote: RunAllQuote = {
    cost: hasKnownJobEstimate(estimate) ? estimatePriceToShow(estimate) : null,
    takes: item.mode === 'video' ? Math.max(1, item.count ?? 1) : 1,
    refusal: estimate.refusal,
    key: request
      ? boardQuoteKey({
          modelId: request.modelId,
          mode: item.mode,
          params: request.params,
          pendingReferenceCount: request.pendingReferenceCount,
          pendingFrameCount: request.pendingFrameCount,
        })
      : null,
  };
  useEffect(
    () => onQuote(item.id, quote),
    [item.id, onQuote, quote.cost, quote.takes, quote.refusal, quote.key],
  );

  return (
    <div
      data-testid="run-all-row"
      className="flex flex-wrap items-center gap-2 border-b-[1.5px] border-[color:var(--color-line)] px-3 py-2 last:border-0"
    >
      <span className="tnum w-5 shrink-0 text-[11px] text-[color:var(--color-faint)]">
        {index + 1}
      </span>
      {item.mode === 'video' ? (
        <Clapperboard size={12} className="shrink-0 text-[color:var(--color-faint)]" />
      ) : (
        <ImageIcon size={12} className="shrink-0 text-[color:var(--color-faint)]" />
      )}
      <span className="flex-1 truncate text-[13px] text-[color:var(--color-fg)]">
        {prompt || `Кадр ${index + 1} · ${item.mode === 'video' ? 'видео' : 'картинка'}`}
      </span>
      <span className="tnum inline-flex shrink-0 items-center gap-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
        <TokenStar size={11} />
        {quote.cost === null ? '—' : quote.cost * quote.takes}
        {quote.takes > 1 && (
          <span className="text-[color:var(--color-faint)]">{` · ${quote.takes} дубля`}</span>
        )}
      </span>
      {quote.refusal && (
        <p
          data-testid="run-all-row-refusal"
          role="alert"
          className="basis-full text-[11px] leading-snug text-destructive"
        >
          {quote.refusal.message ?? 'Эту конфигурацию нельзя оценить. Измените настройки кадра.'}
        </p>
      )}
    </div>
  );
}
type AddCatalogItem = ReturnType<typeof filterCatalog>[number]['items'][number];

/**
 * Keep catalog filtering local to the menu. On a 200-node Board, storing the
 * query in Inner forced the entire ReactFlow tree to participate in every
 * keystroke even though the document did not change.
 */
function AddNodeMenu({
  keepOpen,
  onKeepOpenChange,
  onChoose,
  onClose,
}: {
  keepOpen: boolean;
  onKeepOpenChange: (value: boolean) => void;
  onChoose: (item: AddCatalogItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => filterCatalog(query), [query]);
  const choose = (item: AddCatalogItem) => {
    onChoose(item);
    if (!keepOpen) onClose();
  };

  return (
    <div
      data-testid="add-menu"
      className="glass-menu absolute bottom-[148px] left-1/2 z-40 w-64 -translate-x-1/2 p-1.5"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <input
        autoFocus
        value={query}
        data-testid="add-search"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            const first = groups[0]?.items[0];
            if (first) choose(first);
          }
        }}
        placeholder="Поиск узла…"
        className="mb-1 w-full rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-2.5 py-1.5 text-[13px] text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-faint)] focus:border-[color:var(--color-accent)]"
      />
      <div className="max-h-[320px] overflow-y-auto">
        {groups.map((group) => (
          <div key={group.category}>
            <p className="px-2.5 pb-0.5 pt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-faint)]">
              {group.category}
            </p>
            {group.items.map((item) => (
              <button
                key={item.testid}
                data-testid={item.testid}
                onClick={() => choose(item)}
                className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px] text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface2)]"
              >
                <span className="text-[color:var(--color-accent)]">{catalogIcon(item.icon)}</span>
                <span className="flex-1">{item.label}</span>
                {item.hint && (
                  <span className="text-[11px] text-[color:var(--color-faint)]">{item.hint}</span>
                )}
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && (
          <p className="px-2.5 py-3 text-[13px] text-[color:var(--color-faint)]">
            Ничего не нашлось.
          </p>
        )}
      </div>
      <label className="mt-1 flex cursor-pointer items-center gap-2 border-t-2 border-[color:var(--color-line)] px-2.5 pb-1 pt-2 text-[11px] text-[color:var(--color-muted-foreground)]">
        <input
          type="checkbox"
          data-testid="add-keep-open"
          checked={keepOpen}
          onChange={(event) => onKeepOpenChange(event.target.checked)}
          className="seed-check"
        />
        Не закрывать — добавить несколько
      </label>
    </div>
  );
}
const sameSnapshot = (a: BoardSnapshot, b: BoardSnapshot) =>
  a.nodes === b.nodes && a.edges === b.edges && a.tray === b.tray;

function randomKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
let _uid = 0;
const uid = () =>
  `n-${++_uid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
function isVideoUrl(u: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(u);
}
/**
 * Ctrl+C buffer. It lives in sessionStorage so a copy survives opening another
 * board in the same tab (a real reload — module state would not) while staying
 * out of other tabs and dying with the session.
 */
const BOARD_CLIPBOARD_KEY = 'seed:board-clipboard';
function readBoardClipboard(): BoardClipboard | null {
  try {
    const raw = window.sessionStorage.getItem(BOARD_CLIPBOARD_KEY);
    const parsed = raw ? (JSON.parse(raw) as BoardClipboard) : null;
    return parsed?.nodes?.length ? parsed : null;
  } catch {
    return null;
  }
}
function writeBoardClipboard(clipboard: BoardClipboard): void {
  try {
    window.sessionStorage.setItem(BOARD_CLIPBOARD_KEY, JSON.stringify(clipboard));
  } catch {
    /* private mode / quota — copy simply does not survive navigation */
  }
}

/* ================================================================== *
 *  Board (inner — inside ReactFlowProvider)
 * ================================================================== */
function Inner({
  boardId,
  initialTitle,
  initialState,
  workspaceProjectId,
  models,
  planTier,
  lockedCtaHref,
  apiUrl,
  devTools = false,
  isAnonymous = false,
}: {
  boardId: string;
  initialTitle: string;
  initialState: Record<string, unknown>;
  workspaceProjectId: string | null;
  models: ModelRow[];
  planTier: string | null;
  lockedCtaHref: string;
  apiUrl: string;
  devTools?: boolean;
  isAnonymous?: boolean;
}) {
  const st = parseBoardDocument(initialState);
  const documentMetadataRef = useRef<Record<string, unknown>>(
    Object.fromEntries(
      Object.entries(st).filter(
        ([key]) => !['schemaVersion', 'nodes', 'edges', 'viewport', 'tray', '__rev'].includes(key),
      ),
    ),
  );
  const recoveryClientIdRef = useRef<string | null>(null);
  if (recoveryClientIdRef.current === null) {
    recoveryClientIdRef.current =
      typeof window === 'undefined'
        ? 'server-render'
        : getBoardRecoveryClientId(window.sessionStorage);
  }
  const recoveryClientId = recoveryClientIdRef.current;
  const [nodes, setNodes, onNodesChangeState] = useNodesState<Node>(
    normalizeBoardNodeOrder(st.nodes).map((n) => withWholeNodeDrag(n as unknown as Node)),
  );
  const onNodesChange = useCallback<OnNodesChange<Node>>(
    (changes) => onNodesChangeState(changes),
    [onNodesChangeState],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    normalizeRefEdges(st.edges as unknown as Edge[]).map((e) => ({
      ...e,
      type: 'typed',
    })),
  );
  const documentGraphCacheRef = useRef<BoardDocumentGraphCache | null>(null);
  if (!documentGraphCacheRef.current) documentGraphCacheRef.current = new BoardDocumentGraphCache();
  const diagnosticsCacheRef = useRef<BoardGraphDiagnosticsCache | null>(null);
  if (!diagnosticsCacheRef.current) diagnosticsCacheRef.current = new BoardGraphDiagnosticsCache();
  const { documentNodes, documentEdges } = documentGraphCacheRef.current.update(nodes, edges);
  const [title, setTitle] = useState(initialTitle);
  const [saveConflict, setSaveConflict] = useState<{
    snapshot: BoardRecoverySnapshot;
    serverRev: number;
    source: 'conflict' | 'recovery';
  } | null>(() => {
    if (typeof window === 'undefined') return null;
    const recovered = readBoardRecovery(window.localStorage, boardId, recoveryClientId);
    if (!recovered) return null;
    if (sameBoardDocument(recovered.state, st)) {
      clearBoardRecovery(window.localStorage, boardId, recovered.clientId);
      return null;
    }
    return {
      snapshot: recovered,
      serverRev: boardRevision(st),
      source: 'recovery',
    };
  });
  const [recoveryAction, setRecoveryAction] = useState<'reload' | 'duplicate' | 'overwrite' | null>(
    null,
  );
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  // B-3: linear shot-list review derived live from the graph.
  const [shotListOpen, setShotListOpen] = useState(false);
  const [scenarioPickerOpen, setScenarioPickerOpen] = useState(false);
  const shotList = useMemo(
    () => deriveShotList(documentNodes as unknown as ShotNodeLike[], documentEdges),
    [documentNodes, documentEdges],
  );
  // B-3: export the shot list as a printable storyboard / contact sheet.
  const exportStoryboard = useCallback(() => {
    const html = buildStoryboardHtml(shotList, title || 'Раскадровка');
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `storyboard-${(title || 'board').replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'board'}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [shotList, title]);
  const [tray, setTray] = useState<string[]>(st.tray);
  const rf = useReactFlow();
  const rfStore = useStoreApi();
  const save = useSaveStatus();
  const [toast, setToast] = useState<string | null>(null);
  const [minimap, setMinimap] = useState(false);
  const [overviewMode, setOverviewMode] = useState(
    () => (st.viewport?.zoom ?? 1) < BOARD_OVERVIEW_ZOOM,
  );
  const [tool, setTool] = useState<CanvasTool>('pan');
  const [spacePan, setSpacePan] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addKeep, setAddKeep] = useState(false);
  const [projectMediaPickerOpen, setProjectMediaPickerOpen] = useState(false);
  const identifiedAssetIds = useMemo(
    () =>
      nodes.flatMap((node) => {
        if (node.type !== 'media') return [];
        const assetId = (node.data as unknown as MediaData).assetId;
        return assetId ? [assetId] : [];
      }),
    [nodes],
  );
  const assetLifecycle = useResolvedAssets(apiUrl, identifiedAssetIds);
  // The URL a run would actually send for a gallery-identified media node.
  // `resolveRefs` skips an asset that has not resolved, so an unresolved id is
  // undefined here too and every quote drops that reference the same way.
  const resolveQuoteAssetUrl = useCallback(
    (assetId: string) => {
      const identified = assetLifecycle.get(assetId);
      return identified?.available ? identified.assetUrl : undefined;
    },
    [assetLifecycle],
  );
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioKey, setStudioKey] = useState(0);
  const [assembling, setAssembling] = useState(false);
  const [studioDestinationNodes, setStudioDestinationNodes] = useState<Node[] | false>(false);
  const studioHandoffKeysRef = useRef(new Map<string, string>());
  const [castOpen, setCastOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [modelChange, setModelChange] = useState<ModelChangeDialogState | null>(null);
  const [portRejection, setPortRejection] = useState<{
    x: number;
    y: number;
    reason: string;
  } | null>(null);
  // Temp operator gateway policy (dev widget): auto / force-openrouter /
  // force-atlascloud. Persisted across visits; sent as `provider` per shot.
  const [gatewayPolicy, setGatewayPolicy] = useState<GatewayPolicy>('auto');
  useEffect(() => {
    if (!devTools || typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('seed.board.gateway');
    if (saved === 'auto' || saved === 'openrouter' || saved === 'atlascloud') {
      setGatewayPolicy(saved);
    }
  }, [devTools]);
  const changeGatewayPolicy = useCallback((p: GatewayPolicy) => {
    setGatewayPolicy(p);
    if (typeof window !== 'undefined') window.localStorage.setItem('seed.board.gateway', p);
  }, []);
  const gatewayPolicyRef = useRef<GatewayPolicy>('auto');
  gatewayPolicyRef.current = gatewayPolicy;
  const [runAllPlan, setRunAllPlan] = useState<RunPlan | null>(null);
  const [runAllRequests, setRunAllRequests] = useState<
    Record<string, NodeEstimateRequest | undefined>
  >({});
  const [runAllQuotes, setRunAllQuotes] = useState<Record<string, RunAllQuote>>({});
  // Every price a shot has been quoted, keyed by the request it prices. BOTH
  // quote surfaces write here — the node badge and the «Снять всё» sheet — and
  // `runNode` binds `expectedCost` only when the stored key matches the request
  // it just compiled. Two writers are the point: React Flow unmounts off-screen
  // nodes and overview mode unmounts all of them, so the badge alone cannot
  // cover a Run All whose total the user has already approved.
  const nodeQuotesRef = useRef(createBoardQuoteRegistry());
  // Bumped per node when a submit is refused with 409 `quote_stale`. Nothing about
  // the node's inputs changed — the catalogue moved — so without this nudge the
  // badge would keep re-offering the same refused number.
  const [quoteRefresh, setQuoteRefresh] = useState<Record<string, number>>({});
  const publishNodeQuote = useCallback((id: string, key: string, cost: number) => {
    nodeQuotesRef.current.publish(id, key, cost);
  }, []);
  const quoteRefreshFor = useCallback((id: string) => quoteRefresh[id] ?? 0, [quoteRefresh]);
  const [runningAll, setRunningAll] = useState(false);
  const [runAllStopping, setRunAllStopping] = useState(false);
  const [reconcilingJobs, setReconcilingJobs] = useState(false);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const trayRef = useRef(tray);
  trayRef.current = tray;
  const titleRef = useRef(title);
  titleRef.current = title;
  const saveConflictRef = useRef(saveConflict);
  saveConflictRef.current = saveConflict;
  const boardStateRef = useRef({ nodes: documentNodes, edges: documentEdges, tray });
  boardStateRef.current = { nodes: documentNodes, edges: documentEdges, tray };
  const castReferenceSpawnReservationsRef = useRef(new Set<string>());
  const castReferenceAppendReservationsRef = useRef(new Map<string, string>());
  const castReferenceAppendEffectRef = useRef<{
    shotId: string;
    resultUrl: string | undefined;
    result: ReturnType<typeof appendCastReferenceToGraph>;
  } | null>(null);

  /* ---- scene → continuity → shot: reservations and author decisions ---- */
  const sceneShotLockRef = useRef(new Set<string>());
  const [subsetRequest, setSubsetRequest] = useState<{
    sceneNodeId: string;
    reason: string;
    items: SceneContinuityOverflowItem[];
    limits: SceneContinuityLimits;
  } | null>(null);
  const [promotionRequest, setPromotionRequest] = useState<{
    sceneNodeId: string;
    objectIndex: number;
    /** Guards the index against a re-extraction landing while the dialog is open. */
    objectKey: string;
    request: SceneObjectPromotionRequest;
  } | null>(null);
  const [detachRequest, setDetachRequest] = useState<{
    castId: string;
    index: number;
    shotCount: number;
  } | null>(null);
  const [frameDeleteRequest, setFrameDeleteRequest] = useState<{
    frameId: string;
    childCount: number;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  /* ---- undo/redo (snapshot-before-action; lib/graph-history) ---- */
  const historyRef = useRef<SnapshotHistory<BoardSnapshot> | null>(null);
  if (!historyRef.current) historyRef.current = new SnapshotHistory(100, 1200, sameSnapshot);
  const [, setHistTick] = useState(0); // re-render undo/redo button states
  const takeSnapshot = useCallback((groupKey?: string) => {
    historyRef.current!.snapshot(
      { nodes: nodesRef.current, edges: edgesRef.current, tray: trayRef.current },
      groupKey,
    );
    setHistTick((t) => t + 1);
  }, []);
  const undo = useCallback(() => {
    const cur = { nodes: nodesRef.current, edges: edgesRef.current, tray: trayRef.current };
    const s = historyRef.current!.undo(cur);
    if (!s) return;
    const nextNodes = mergeVolatile(s.nodes, cur.nodes).map((n) => withWholeNodeDrag(n));
    setNodes(nextNodes);
    setEdges(s.edges);
    setTray(s.tray);
    setHistTick((t) => t + 1);
  }, [setNodes, setEdges]);
  const redo = useCallback(() => {
    const cur = { nodes: nodesRef.current, edges: edgesRef.current, tray: trayRef.current };
    const s = historyRef.current!.redo(cur);
    if (!s) return;
    const nextNodes = mergeVolatile(s.nodes, cur.nodes).map((n) => withWholeNodeDrag(n));
    setNodes(nextNodes);
    setEdges(s.edges);
    setTray(s.tray);
    setHistTick((t) => t + 1);
  }, [setNodes, setEdges]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  const clearSelection = useCallback(() => {
    setNodes((currentNodes) => clearBoardSelection(currentNodes));
    setEdges((currentEdges) =>
      currentEdges.some((edge) => edge.selected)
        ? currentEdges.map((edge) => ({ ...edge, selected: false }))
        : currentEdges,
    );
  }, [setNodes, setEdges]);
  const selectAll = useCallback(() => {
    setNodes((currentNodes) => selectAllBoardNodes(currentNodes));
  }, [setNodes]);
  const currentSelectedNodeIds = useCallback(() => selectedBoardNodeIds(nodesRef.current), []);
  const removeSelection = useCallback(
    (selectedIds = currentSelectedNodeIds()) => {
      const next = removeBoardSelection({
        nodes: nodesRef.current,
        edges: edgesRef.current,
        tray: trayRef.current,
        selectedIds,
      });
      if (!next.removed) return false;
      const selectedFrame = nodesRef.current.find(
        (node) => selectedIds.has(node.id) && node.type === 'frame',
      );
      if (selectedFrame) {
        setFrameDeleteRequest({
          frameId: selectedFrame.id,
          childCount: nodesRef.current.filter((node) => node.parentId === selectedFrame.id).length,
        });
        return true;
      }
      takeSnapshot();
      setNodes(next.nodes as Node[]);
      setEdges(next.edges as Edge[]);
      setTray([...next.tray]);
      return true;
    },
    [currentSelectedNodeIds, setNodes, setEdges, takeSnapshot],
  );
  // Duplicate the current selection (+ any edges fully inside it), offset a
  // touch; generate clones start fresh (no inherited take). Undoable.
  const duplicateSelection = useCallback(() => {
    const result = duplicateBoardSelection({
      nodes: nodesRef.current,
      edges: edgesRef.current,
      makeId: uid,
      selectedIds: currentSelectedNodeIds(),
    });
    if (!result.duplicated) return;
    takeSnapshot();
    setNodes(result.nodes as Node[]);
    setEdges(result.edges as Edge[]);
  }, [currentSelectedNodeIds, setNodes, setEdges, takeSnapshot]);

  // Ctrl+C / Ctrl+V — copy cards instead of re-creating them through «+».
  const copySelection = useCallback(
    (selectedIds = currentSelectedNodeIds()) => {
      const copied = copyBoardSelection({
        nodes: nodesRef.current,
        edges: edgesRef.current,
        selectedIds,
      });
      if (!copied) return false;
      writeBoardClipboard(copied);
      showToast(
        copied.nodes.length === 1
          ? 'Карточка скопирована.'
          : `Скопировано карточек: ${copied.nodes.length}.`,
      );
      return true;
    },
    [currentSelectedNodeIds, showToast],
  );
  const pasteClipboard = useCallback(() => {
    const clipboard = readBoardClipboard();
    if (!clipboard) return;
    const center = rf.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 - 40,
    });
    const taken = nodesRef.current.map((n) => n.position);
    const result = pasteBoardClipboard({
      nodes: nodesRef.current,
      edges: edgesRef.current,
      clipboard,
      makeId: uid,
      anchor: { x: center.x - 120, y: center.y - 80 },
      selectedIds: currentSelectedNodeIds(),
      place: (desired) => {
        const free = findFreePosition(desired, taken);
        taken.push(free);
        return free;
      },
    });
    if (!result.pasted) return;
    takeSnapshot();
    setNodes(result.nodes as Node[]);
    setEdges(result.edges as Edge[]);
  }, [currentSelectedNodeIds, rf, setNodes, setEdges, takeSnapshot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isBoardTypingTarget(e.target as HTMLElement | null)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        setSpacePan(true);
        return;
      }
      // ? toggles the shortcuts sheet (Shift+/ surfaces as either)
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      // Escape: close overlays, else clear selection
      if (e.key === 'Escape') {
        setShortcutsOpen(false);
        setAddOpen(false);
        setRunAllPlan(null);
        setModelChange(null);
        setPortRejection(null);
        clearSelection();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (removeSelection()) e.preventDefault();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (k === 'y') {
        e.preventDefault();
        redo();
      } else if (k === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (k === 'c') {
        // a live text selection on the canvas still copies natively
        if (window.getSelection()?.toString()) return;
        if (copySelection()) e.preventDefault();
      } else if (k === 'x') {
        const selectedIds = currentSelectedNodeIds();
        if (copySelection(selectedIds) && removeSelection(selectedIds)) e.preventDefault();
      } else if (k === 'v') {
        if (!readBoardClipboard()) return;
        e.preventDefault();
        pasteClipboard();
      } else if (k === 'a') {
        // select-all is SAFE: deletion is always snapshot-backed, so the
        // Ctrl+A → Delete hazard both playbooks flag is fully undoable here.
        e.preventDefault();
        selectAll();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePan(false);
    };
    const onBlur = () => setSpacePan(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    undo,
    redo,
    duplicateSelection,
    copySelection,
    currentSelectedNodeIds,
    pasteClipboard,
    selectAll,
    clearSelection,
    removeSelection,
  ]);

  useEffect(() => {
    if (!portRejection) return;
    const timer = window.setTimeout(() => setPortRejection(null), 4200);
    return () => window.clearTimeout(timer);
  }, [portRejection]);

  // P-B2 parity with /generate: a board default must never land on a model the
  // plan cannot run, so the preferred id only wins when it is in-plan.
  const imageModel = useMemo(
    () => defaultModelForMode(models, 'image', 'seedream-5-0-pro', planTier),
    [models, planTier],
  );
  const videoModel = useMemo(
    () => defaultModelForMode(models, 'video', 'seedance-2-0-fast', planTier),
    [models, planTier],
  );
  const modelLocked = useCallback(
    (model: ModelRow | undefined) => boardRunModelLocked(model, planTier),
    [planTier],
  );
  // Resolve the model a node actually uses: its persisted pick if still valid
  // for the mode, else the board's mode-default (P9 per-node model picker).
  const modelForNode = useCallback(
    (d: GenerateData) => {
      if (d.modelId) return modelsForMode(models, d.mode).find((model) => model.id === d.modelId);
      return resolveModel(models, d.mode, undefined, d.mode === 'video' ? videoModel : imageModel);
    },
    [models, videoModel, imageModel],
  );
  const connectionPolicy = useMemo(
    () =>
      createBoardConnectionPolicy({
        nodes: documentNodes,
        edges: documentEdges,
        modelForNode: (node) => modelForNode(node.data as unknown as GenerateData),
      }),
    [documentNodes, documentEdges, modelForNode],
  );
  const diagnosticNodes = useMemo<BoardGraphNodeLike[]>(
    () =>
      documentNodes.flatMap((node) =>
        node.type && node.type in BOARD_NODE_REGISTRY
          ? [
              {
                id: node.id,
                type: node.type as BoardNodeType,
                data: node.data,
              },
            ]
          : [],
      ),
    [documentNodes],
  );
  const graphDiagnostic = useMemo(
    () =>
      diagnosticsCacheRef.current!.update({
        nodes: diagnosticNodes,
        edges: documentEdges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
        })),
        modelForNode: (node) =>
          node.type === 'generate' ? modelForNode(node.data as unknown as GenerateData) : undefined,
        requireReady: true,
      }),
    [diagnosticNodes, documentEdges, modelForNode],
  );
  const nodeDiagnostics = useMemo(
    () => new Map(graphDiagnostic.nodes.map((diagnostic) => [diagnostic.nodeId, diagnostic])),
    [graphDiagnostic.nodes],
  );
  const edgeDiagnostics = useMemo(() => {
    const byEdge = new Map<string, BoardEdgeDiagnostic[]>();
    for (const diagnostic of graphDiagnostic.nodes) {
      for (const issue of diagnostic.edgeIssues) {
        byEdge.set(issue.edgeId, [...(byEdge.get(issue.edgeId) ?? []), issue]);
      }
    }
    return byEdge;
  }, [graphDiagnostic.nodes]);
  const edgeRoles = useMemo(
    () => new Map(graphDiagnostic.roles.map((role) => [role.edgeId, role])),
    [graphDiagnostic.roles],
  );
  const diagnosticForNode = useCallback((id: string) => nodeDiagnostics.get(id), [nodeDiagnostics]);
  const edgeIssuesFor = useCallback(
    (id: string) => edgeDiagnostics.get(id) ?? [],
    [edgeDiagnostics],
  );
  const edgeRoleFor = useCallback((id: string) => edgeRoles.get(id), [edgeRoles]);

  const targetInputsFor = useCallback((targetId: string): BoardTargetInput[] => {
    const inputs: BoardTargetInput[] = [];
    for (const edge of edgesRef.current.filter((candidate) => candidate.target === targetId)) {
      const source = nodesRef.current.find((candidate) => candidate.id === edge.source);
      if (!source?.type || !(source.type in BOARD_NODE_REGISTRY)) continue;
      inputs.push({
        edgeId: edge.id,
        sourceNodeId: source.id,
        source: {
          type: source.type as BoardNodeType,
          data: source.data,
        } as Pick<BoardNode, 'type' | 'data'>,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      });
    }
    return inputs;
  }, []);

  /* ---- persistence (serialised, honest) ---- */
  // The save state machine — one-in-flight, conflict freeze, rev discipline and
  // recovery-before-network — lives in lib/board-autosave-engine.ts, where it is
  // unit-tested. This component only supplies the board and the UI reactions.
  const persistedViewportRef = useRef(st.viewport ?? { x: 80, y: 60, zoom: 1 });
  const observedGraphRef = useRef({ nodes: documentNodes, edges: documentEdges, tray });

  const currentBoardDocument = (): BoardDocument => {
    const viewport = rf.getViewport();
    const projected = documentGraphCacheRef.current!.update(nodesRef.current, edgesRef.current);
    return {
      ...documentMetadataRef.current,
      schemaVersion: BOARD_SCHEMA_VERSION,
      nodes: projected.documentNodes,
      edges: projected.documentEdges,
      viewport,
      tray: boardStateRef.current.tray,
    } as unknown as BoardDocument;
  };

  const preserveRecovery = (
    state: BoardDocument,
    expectedRev = autosaveRef.current!.rev(),
    serverRev?: number,
  ): BoardRecoverySnapshot | null => {
    try {
      const snapshot = createBoardRecoverySnapshotFromDocument({
        boardId,
        clientId: recoveryClientId,
        title: titleRef.current || 'Без названия',
        expectedRev,
        ...(serverRev !== undefined ? { serverRev } : {}),
        state,
      });
      // Keep the in-memory copy even when private mode/quota disables storage.
      writeBoardRecovery(window.localStorage, snapshot);
      return snapshot;
    } catch {
      return null;
    }
  };

  // Hybrid "action + inaction" autosave with a throttle ceiling: save ~900ms
  // after editing pauses, but force a checkpoint at least every 4s of CONTINUOUS
  // editing. The ceiling both protects the user (an impatient leave loses ≤4s of
  // work, and pagehide flushes even that) and protects us (continuous editing
  // emits ≤1 save / 4s instead of the old 0ms-per-change storm that tripped the
  // API's per-IP rate limit into a wall of 429s).
  // Conflict resolution saves OUTSIDE the engine on purpose: «duplicate» writes
  // to a freshly created board and «overwrite» deliberately ignores the rev
  // guard, so neither may touch the engine's one-in-flight/rev state.
  const putBoardState = async (
    state: BoardDocument,
    expectedRev: number,
    targetBoardId = boardId,
  ) => putBoardDocument({ apiUrl, boardId: targetBoardId, state, expectedRev });

  const saveSchedulerRef = useRef<ReturnType<typeof createAutosaveScheduler> | null>(null);
  const autosaveRef = useRef<BoardAutosaveEngine | null>(null);
  const rateLimitRetryTimerRef = useRef<number | null>(null);
  if (!autosaveRef.current) {
    autosaveRef.current = createBoardAutosaveEngine<BoardRecoverySnapshot>({
      getDocument: () => currentBoardDocument(),
      put: async (state, expectedRev) => {
        const result = await putBoardDocument({ apiUrl, boardId, state, expectedRev });
        // The viewport we just persisted, so the idle-viewport watcher below
        // knows a pan/zoom is genuinely new rather than the one already stored.
        if (result.kind === 'saved') persistedViewportRef.current = state.viewport!;
        return result;
      },
      preserveRecovery: (state, expectedRev, serverRev) =>
        preserveRecovery(state, expectedRev, serverRev),
      clearRecovery: () => clearBoardRecovery(window.localStorage, boardId, recoveryClientId),
      // Owns the «Сохранение…» / «Не сохранено» badge, incl. the bounded backoff.
      runSave: (attempt) => save.run(attempt),
      onConflict: (conflict) => {
        setRecoveryError(null);
        setSaveConflict(conflict);
      },
      onTooLarge: () =>
        showToast('Борд слишком большой для сохранения. Локальная копия сохранена в браузере.'),
      onRateLimited: (retryAfterMs) => {
        showToast('Автосохранение немного замедлено — продолжу автоматически.');
        if (rateLimitRetryTimerRef.current === null) {
          rateLimitRetryTimerRef.current = window.setTimeout(
            () => {
              rateLimitRetryTimerRef.current = null;
              if (!autosaveRef.current?.isBlocked()) autosaveRef.current?.save();
            },
            Math.max(1_000, retryAfterMs ?? 5_000),
          );
        }
      },
      cancelScheduled: () => saveSchedulerRef.current?.cancel(),
      initialRev: boardRevision(st),
      initiallyDirty: saveConflict !== null,
    });
    // A recovery snapshot found on mount is an unresolved conflict too: nothing
    // may be saved over the server's copy until the user picks a side.
    if (saveConflict !== null) autosaveRef.current.block();
  }
  const autosave = autosaveRef.current;

  if (!saveSchedulerRef.current) {
    saveSchedulerRef.current = createAutosaveScheduler(() => autosave.save(), {
      debounceMs: 900,
      maxWaitMs: 4000,
    });
  }
  useEffect(() => {
    const observed = observedGraphRef.current;
    if (
      observed.nodes === documentNodes &&
      observed.edges === documentEdges &&
      observed.tray === tray
    ) {
      return;
    }
    observedGraphRef.current = { nodes: documentNodes, edges: documentEdges, tray };
    autosave.markDirty();
    preserveRecovery(currentBoardDocument());
    if (!autosave.isBlocked()) saveSchedulerRef.current?.schedule();
  }, [documentNodes, documentEdges, tray]);
  useEffect(
    () => () => {
      saveSchedulerRef.current?.cancel();
      if (rateLimitRetryTimerRef.current !== null)
        window.clearTimeout(rateLimitRetryTimerRef.current);
    },
    [],
  );

  const saveBeforeScenarioImport = useCallback(
    (): Promise<boolean> =>
      autosave.waitForIdle({
        timeoutMs: 15_000,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      }),
    [autosave],
  );

  const applyScenarioBoardState = useCallback(
    (incoming: BoardDocument, summary: string) => {
      const parsed = parseBoardDocument(incoming);
      documentMetadataRef.current = Object.fromEntries(
        Object.entries(parsed).filter(
          ([key]) =>
            !['schemaVersion', 'nodes', 'edges', 'viewport', 'tray', '__rev'].includes(key),
        ),
      );
      const nextNodes = normalizeBoardNodeOrder(parsed.nodes).map((node) =>
        withWholeNodeDrag(node as unknown as Node),
      );
      const nextEdges = normalizeRefEdges(parsed.edges as unknown as Edge[]).map((edge) => ({
        ...edge,
        type: 'typed',
      }));
      const nextTray = parsed.tray;
      takeSnapshot('scenario-source');
      autosave.adoptRev(boardRevision(parsed));
      observedGraphRef.current = { nodes: nextNodes, edges: nextEdges, tray: nextTray };
      boardStateRef.current = { nodes: nextNodes, edges: nextEdges, tray: nextTray };
      setNodes(nextNodes);
      setEdges(nextEdges);
      setTray(nextTray);
      // The imported source column can extend below the old empty-board
      // viewport. Frame the result so every selected scene is immediately
      // visible instead of making the user hunt for off-screen blocks.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          void rf.fitView({ padding: 0.2, duration: 250, includeHiddenNodes: true });
        });
      });
      clearBoardRecovery(window.localStorage, boardId, recoveryClientId);
      showToast(summary);
    },
    [boardId, recoveryClientId, rf, setEdges, setNodes, showToast, takeSnapshot],
  );
  // A durable local snapshot is written before the best-effort keepalive. If an
  // older in-flight request wins the race, the rejected newer document is still
  // offered for recovery on the next visit.
  useEffect(() => {
    const flush = () => {
      if (!autosave.isDirty() || autosave.isBlocked()) return;
      try {
        const state = currentBoardDocument();
        preserveRecovery(state);
        void fetch(`${apiUrl}/v1/boards/${boardId}`, {
          method: 'PUT',
          credentials: 'include',
          keepalive: true,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state, rev: autosave.rev() }),
        });
      } catch {
        /* the local recovery snapshot remains available */
      }
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [apiUrl, boardId, rf]);
  // pan/zoom with no other change must survive a reload too
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportIntentRef = useRef(false);
  const onViewportMove = useCallback((_event: unknown, viewport: { zoom: number }) => {
    const next = viewport.zoom < BOARD_OVERVIEW_ZOOM;
    setOverviewMode((current) => (current === next ? current : next));
  }, []);
  const fitBoard = useCallback(() => {
    viewportIntentRef.current = true;
    const largeDocument = nodesRef.current.length > 80 || edgesRef.current.length > 120;
    if (largeDocument) {
      // Commit the canvas overview before changing the viewport, otherwise the
      // fit frame first mounts every full-detail node it is about to hide.
      const bounds = getNodesBounds(nodesRef.current);
      const viewport = getViewportForBounds(
        bounds,
        window.innerWidth,
        window.innerHeight,
        0.25,
        2,
        0.25,
      );
      setOverviewMode(true);
      requestAnimationFrame(() => {
        void rf.setViewport(viewport, { duration: 0 });
      });
      return;
    }
    setOverviewMode(false);
    void rf.fitView({ padding: 0.25, duration: 250, includeHiddenNodes: true });
  }, [rf]);
  const onMoveEnd = useCallback((event: unknown) => {
    // React Flow emits null-event move completions for initial viewport setup.
    // Ignore those unless a rail control explicitly marked user intent.
    const intendedProgrammaticMove = viewportIntentRef.current;
    viewportIntentRef.current = false;
    if (event == null && !intendedProgrammaticMove) return;
    if (moveTimer.current) clearTimeout(moveTimer.current);
    moveTimer.current = setTimeout(() => {
      const viewport = rf.getViewport();
      const persisted = persistedViewportRef.current;
      if (
        Math.abs(viewport.x - persisted.x) < 0.001 &&
        Math.abs(viewport.y - persisted.y) < 0.001 &&
        Math.abs(viewport.zoom - persisted.zoom) < 0.0001
      ) {
        return;
      }
      autosave.markDirty();
      preserveRecovery(currentBoardDocument());
      if (!autosave.isBlocked()) autosave.save();
    }, 1500);
  }, []);
  useEffect(
    () => () => {
      if (moveTimer.current) clearTimeout(moveTimer.current);
    },
    [],
  );

  function reloadServerBoard() {
    setRecoveryAction('reload');
    clearBoardRecovery(window.localStorage, boardId, saveConflictRef.current?.snapshot.clientId);
    window.location.reload();
  }

  async function duplicateRecoveredBoard() {
    const conflict = saveConflictRef.current;
    if (!conflict || recoveryAction) return;
    setRecoveryAction('duplicate');
    setRecoveryError(null);
    let createdId: string | null = null;
    try {
      const suffix = ' — восстановлено';
      const base = (conflict.snapshot.title || titleRef.current || 'Без названия').slice(
        0,
        80 - suffix.length,
      );
      const created = await fetch(`${apiUrl}/v1/boards`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        // Recovery must not eject the user from Среда: a duplicate made in
        // project mode belongs to the same project, or it never shows up on
        // the project desk again. Standalone recovery stays standalone.
        body: JSON.stringify({
          title: `${base}${suffix}`,
          ...(workspaceProjectId ? { projectId: workspaceProjectId } : {}),
        }),
      });
      const body: unknown = await created.json().catch(() => null);
      if (
        !created.ok ||
        typeof body !== 'object' ||
        body === null ||
        !('id' in body) ||
        typeof body.id !== 'string'
      ) {
        throw new Error('create_failed');
      }
      createdId = body.id;
      const initialRev = 'state' in body ? boardRevision(body.state) : 0;
      const saved = await putBoardState(conflict.snapshot.state, initialRev, createdId);
      if (saved.kind !== 'saved') throw new Error('save_failed');
      clearBoardRecovery(window.localStorage, boardId, conflict.snapshot.clientId);
      window.location.assign(
        workspaceProjectId
          ? withProjectContext(`/boards/${createdId}`, workspaceProjectId)
          : `/boards/${createdId}`,
      );
    } catch {
      if (createdId) {
        void fetch(`${apiUrl}/v1/boards/${createdId}`, {
          method: 'DELETE',
          credentials: 'include',
        });
      }
      setRecoveryError(
        'Не удалось создать копию. Локальная версия сохранена — попробуйте ещё раз.',
      );
      setRecoveryAction(null);
    }
  }

  async function overwriteServerBoard() {
    const conflict = saveConflictRef.current;
    if (!conflict || recoveryAction) return;
    setRecoveryAction('overwrite');
    setRecoveryError(null);
    const result = await putBoardState(conflict.snapshot.state, conflict.serverRev);
    if (result.kind === 'saved') {
      autosave.adoptRev(result.rev);
      autosave.unblock();
      clearBoardRecovery(window.localStorage, boardId, conflict.snapshot.clientId);
      setSaveConflict(null);
      window.location.reload();
      return;
    }
    if (result.kind === 'conflict') {
      const snapshot =
        preserveRecovery(conflict.snapshot.state, conflict.snapshot.expectedRev, result.rev) ??
        conflict.snapshot;
      setSaveConflict({ snapshot, serverRev: result.rev, source: 'conflict' });
      setRecoveryError('Борд снова изменили. Серверная версия обновлена — подтвердите ещё раз.');
    } else {
      setRecoveryError('Не удалось перезаписать борд. Локальная версия сохранена.');
    }
    setRecoveryAction(null);
  }

  function saveTitle(next: string) {
    setTitle(next);
    save.run(async () => {
      try {
        const r = await fetch(`${apiUrl}/v1/boards/${boardId}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: next || 'Без названия' }),
        });
        return r.ok;
      } catch {
        return false;
      }
    });
  }

  /* ---- node helpers ---- */
  const patch = useCallback(
    (id: string, data: Partial<AnyData>) => {
      // run-pipeline status patches are not user actions — no undo point
      const patchData = data as Record<string, unknown>;
      const volatile = isVolatilePatch(patchData);
      const needsStoreSync = patchNeedsStoreSync(patchData);
      if (!volatile) {
        takeSnapshot(`patch:${id}:${Object.keys(data).sort().join('+')}`);
      }
      // A controlled field must see the patch in React Flow's store before React
      // restores it. Lifecycle-only patches skip the extra rebuild; unknown keys
      // stay on the safe path so new controlled fields cannot miss the bridge.
      const patchNodes = (nodes: readonly Node[]) => patchBoardNode(nodes, id, patchData);
      if (needsStoreSync) rfStore.getState().setNodes(patchNodes(rfStore.getState().nodes));
      setNodes(patchNodes);
    },
    [rfStore, setNodes, takeSnapshot],
  );
  const requestModelChange = useCallback(
    (id: string, modelId: string) => {
      const node = nodesRef.current.find((candidate) => candidate.id === id);
      const next = models.find((candidate) => candidate.id === modelId);
      if (!node || node.type !== 'generate' || !next) return;
      const data = node.data as unknown as GenerateData;
      const current = modelForNode(data);
      if (current?.id === next.id && data.modelId === next.id) return;
      const connections = targetInputsFor(id);
      const impact = analyzeBoardModelChange({
        nodeId: id,
        data,
        nextModel: next,
        connections,
      });
      if (impact.canApplyWithoutChanges) {
        takeSnapshot(`model:${id}`);
        setNodes((currentNodes) =>
          currentNodes.map((candidate) =>
            candidate.id === id
              ? { ...candidate, data: { ...candidate.data, modelId: next.id } }
              : candidate,
          ),
        );
        return;
      }

      // The "keep your wiring, use this instead" suggestion must itself be
      // runnable on the plan.
      const ordered = [
        ...(current && !modelLocked(current) ? [current] : []),
        ...unlockedModelsForMode(models, data.mode, planTier).filter(
          (candidate) => candidate.id !== current?.id && candidate.id !== next.id,
        ),
      ];
      const suggestion = ordered.find(
        (candidate) =>
          analyzeBoardModelChange({
            nodeId: id,
            data,
            nextModel: candidate,
            connections,
          }).canApplyWithoutChanges,
      );
      setModelChange({ nodeId: id, current, next, suggestion, impact });
    },
    [modelForNode, modelLocked, models, planTier, setNodes, takeSnapshot, targetInputsFor],
  );
  const applyModelChange = useCallback(() => {
    if (!modelChange) return;
    const removed = new Set(modelChange.impact.edgeIssues.map((issue) => issue.edgeId));
    takeSnapshot(`model:${modelChange.nodeId}:remove:${[...removed].sort().join(',')}`);
    setNodes((currentNodes) =>
      currentNodes.map((candidate) =>
        candidate.id === modelChange.nodeId
          ? {
              ...candidate,
              data: {
                ...candidate.data,
                modelId: modelChange.next.id,
                ...modelChange.impact.settingsPatch,
              },
            }
          : candidate,
      ),
    );
    if (removed.size > 0) {
      setEdges((currentEdges) => currentEdges.filter((edge) => !removed.has(edge.id)));
    }
    setModelChange(null);
  }, [modelChange, setEdges, setNodes, takeSnapshot]);
  const applySuggestedModel = useCallback(() => {
    if (!modelChange?.suggestion) return;
    if (modelChange.current?.id === modelChange.suggestion.id) {
      setModelChange(null);
      return;
    }
    takeSnapshot(`model:${modelChange.nodeId}`);
    setNodes((currentNodes) =>
      currentNodes.map((candidate) =>
        candidate.id === modelChange.nodeId
          ? { ...candidate, data: { ...candidate.data, modelId: modelChange.suggestion!.id } }
          : candidate,
      ),
    );
    setModelChange(null);
  }, [modelChange, setNodes, takeSnapshot]);
  const repairNodeSettings = useCallback(
    (id: string) => {
      const diagnostic = nodeDiagnostics.get(id);
      if (!diagnostic) return;
      const settingsPatch = boardGenerateSettingsPatch(diagnostic.settingIssues);
      if (Object.keys(settingsPatch).length === 0) return;
      takeSnapshot(`settings:${id}:repair`);
      setNodes((currentNodes) =>
        currentNodes.map((candidate) =>
          candidate.id === id
            ? { ...candidate, data: { ...candidate.data, ...settingsPatch } }
            : candidate,
        ),
      );
    },
    [nodeDiagnostics, setNodes, takeSnapshot],
  );
  const remove = useCallback(
    (id: string) => {
      takeSnapshot();
      const next = removeBoardNode({
        nodes: nodesRef.current,
        edges: edgesRef.current,
        tray: trayRef.current,
        nodeId: id,
      });
      setNodes(next.nodes as Node[]);
      setEdges(next.edges as Edge[]);
      setTray(next.tray);
    },
    [setNodes, setEdges, takeSnapshot],
  );

  const requestFrameDelete = useCallback((id: string) => {
    setFrameDeleteRequest({
      frameId: id,
      childCount: nodesRef.current.filter((node) => node.parentId === id).length,
    });
  }, []);

  const applyFrameDelete = useCallback(
    (includeChildren: boolean) => {
      if (!frameDeleteRequest) return;
      const next = removeBoardFrame({
        nodes: nodesRef.current,
        edges: edgesRef.current,
        tray: trayRef.current,
        frameId: frameDeleteRequest.frameId,
        includeChildren,
      });
      if (!next.removed) {
        setFrameDeleteRequest(null);
        return;
      }
      takeSnapshot('frame-delete');
      setNodes(next.nodes as Node[]);
      setEdges(next.edges as Edge[]);
      setTray([...next.tray]);
      setFrameDeleteRequest(null);
    },
    [frameDeleteRequest, setEdges, setNodes, takeSnapshot],
  );

  const swapFrameInputs = useCallback(
    (targetId: string) => {
      const hasFrameEdge = edgesRef.current.some(
        (edge) =>
          edge.target === targetId &&
          (edge.targetHandle === 'images[0]' || edge.targetHandle === 'images[1]'),
      );
      if (!hasFrameEdge) return;
      takeSnapshot(`frames:${targetId}:swap`);
      setEdges((current) =>
        current.map((edge) => {
          if (edge.target !== targetId) return edge;
          if (edge.targetHandle === 'images[0]') return { ...edge, targetHandle: 'images[1]' };
          if (edge.targetHandle === 'images[1]') return { ...edge, targetHandle: 'images[0]' };
          return edge;
        }),
      );
      showToast('Первый и последний кадры поменяны местами.');
    },
    [setEdges, showToast, takeSnapshot],
  );

  const wrapSelectionInFrame = useCallback(() => {
    const selectedCount = nodesRef.current.filter(
      (node) => node.selected && node.type !== 'frame',
    ).length;
    if (selectedCount === 0) {
      showToast('Выберите хотя бы один узел, чтобы обернуть его в рамку.');
      return null;
    }
    takeSnapshot('frame-wrap');
    const next = wrapBoardSelectionInFrame({ nodes: nodesRef.current, frameId: uid() });
    setNodes(next as Node[]);
    showToast(`Выделенные узлы объединены в рамку (${selectedCount}).`);
    return next[0]?.id ?? null;
  }, [setNodes, showToast, takeSnapshot]);

  const addNode = useCallback(
    (type: keyof typeof nodeTypes, partial?: Partial<AnyData>) => {
      if (
        type === 'frame' &&
        nodesRef.current.some((node) => node.selected && node.type !== 'frame')
      ) {
        return wrapSelectionInFrame();
      }
      const center = rf.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2 - 40,
      });
      const id = uid();
      const data = { ...(NODE_BASE[type] as AnyData), ...(partial ?? {}) };
      takeSnapshot();
      const node: Node = {
        id,
        type,
        width: NODE_W,
        height: NODE_H,
        ...(type === 'frame' ? { width: 520, height: 320, zIndex: -1 } : {}),
        // never drop a new node on top of an existing one
        position: findFreePosition(
          { x: center.x - 120, y: center.y - 80 },
          nodesRef.current.map((n) => n.position),
        ),
        data: data as Record<string, unknown>,
      };
      setNodes((nds) => [...nds, node]);
      return id;
    },
    [rf, setNodes, takeSnapshot, wrapSelectionInFrame],
  );
  const chooseCatalogItem = useCallback(
    (item: AddCatalogItem) => {
      if (item.t === 'scene') setScenarioPickerOpen(true);
      else if (item.t === 'media' && workspaceProjectId) setProjectMediaPickerOpen(true);
      else addNode(item.t, item.d);
    },
    [addNode, workspaceProjectId],
  );

  const sceneContinuityCasts = useCallback((data: SceneData) => {
    const castById = new Map(
      nodesRef.current.filter((node) => node.type === 'cast').map((node) => [node.id, node]),
    );
    // Two chips may point at one card — a stale chip kept next to a re-extracted
    // one, or the same name promoted twice. The card is wired once: a duplicate
    // would eat a second input slot and double-count its pack.
    const seen = new Set<string>();
    return (data.objects ?? []).flatMap((object) => {
      const castNode = object.castNodeId ? castById.get(object.castNodeId) : undefined;
      if (!castNode || seen.has(castNode.id)) return [];
      seen.add(castNode.id);
      return [
        {
          id: castNode.id,
          node: castNode as unknown as BoardNode,
          name: object.name,
          ...(object.description ? { description: object.description } : {}),
        },
      ];
    });
  }, []);

  const planSceneShot = useCallback(
    (sceneNodeId: string, selectedCastIds?: readonly string[]) => {
      const scene = nodesRef.current.find((node) => node.id === sceneNodeId);
      if (scene?.type !== 'scene') return null;
      const data = scene.data as unknown as SceneData;
      if (data.sourceStatus === 'removed') {
        showToast('Сцена удалена из сценария — сначала обновите источник.');
        return null;
      }
      const casts = sceneContinuityCasts(data);
      return planSceneContinuityShot({
        document: currentBoardDocument(),
        sceneNodeId,
        casts,
        ...(selectedCastIds ? { selectedCastIds } : {}),
        model: imageModel && !modelLocked(imageModel) ? imageModel : undefined,
        ids: {
          promptId: uid(),
          shotId: uid(),
          promptEdgeId: uid(),
          castEdgeIds: casts.map(() => uid()),
        },
      });
    },
    [imageModel, modelLocked, sceneContinuityCasts, showToast],
  );

  const commitSceneShot = useCallback(
    (sceneNodeId: string, plan: SceneContinuityPlan) => {
      if (!plan.ok) {
        showToast(plan.reason);
        return;
      }
      takeSnapshot(`scene:first-shot:${sceneNodeId}`);
      // React Flow keeps the document projection plus the one piece of view
      // state the author expects: the new Prompt comes up selected so he can
      // type into it straight away.
      const nextNodes = (plan.document.nodes as unknown as Node[]).map((node) =>
        node.id === plan.promptId ? { ...node, selected: true } : { ...node, selected: false },
      );
      const nextEdges = plan.document.edges as unknown as Edge[];
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      boardStateRef.current = {
        nodes: plan.document.nodes as unknown as Node[],
        edges: nextEdges,
        tray: plan.document.tray ?? trayRef.current,
      };
      setNodes(nextNodes);
      setEdges(nextEdges);
      requestAnimationFrame(() => {
        void rf.fitView({
          nodes: [{ id: sceneNodeId }, { id: plan.promptId }, { id: plan.shotId }],
          padding: 0.18,
          duration: 300,
        });
      });
      showToast('Черновик первого кадра создан — отредактируйте промпт и запустите вручную.');
    },
    [rf, setEdges, setNodes, showToast, takeSnapshot],
  );

  const createShotFromScene = useCallback(
    (sceneNodeId: string) => {
      // Per-command reservation: the whole plan+commit is synchronous, so the
      // second half of a double click would otherwise plan against the first
      // half's result and quietly build a second scaffold.
      if (sceneShotLockRef.current.has(sceneNodeId)) return;
      sceneShotLockRef.current.add(sceneNodeId);
      window.setTimeout(() => sceneShotLockRef.current.delete(sceneNodeId), 500);

      const plan = planSceneShot(sceneNodeId);
      if (!plan) return;
      if (!plan.ok && plan.overflow && plan.limits) {
        setSubsetRequest({
          sceneNodeId,
          reason: plan.reason,
          items: plan.overflow,
          limits: plan.limits,
        });
        return;
      }
      commitSceneShot(sceneNodeId, plan);
    },
    [commitSceneShot, planSceneShot],
  );

  /**
   * Apply a decided promotion. `reuseCastNodeId === null` creates a new card.
   * The candidate document is parsed and byte-measured before anything is
   * committed, so a full board refuses instead of reporting success and then
   * failing in autosave.
   */
  const applyScenePromotion = useCallback(
    (
      sceneNodeId: string,
      objectIndex: number,
      reuseCastNodeId: string | null,
      expectedKey?: string,
    ) => {
      const scene = nodesRef.current.find((node) => node.id === sceneNodeId);
      if (scene?.type !== 'scene') return;
      const sceneData = scene.data as unknown as SceneData;
      const object = sceneData.objects?.[objectIndex];
      if (!object || object.castNodeId) return;
      // A position in the array is not an identity: a re-extraction can finish
      // while the chooser is open and slide a different object under this index.
      if (expectedKey && sceneObjectKey(object) !== expectedKey) {
        showToast('Список объектов изменился — откройте чип заново.');
        return;
      }
      const castKind: CastData['castKind'] =
        object.kind === 'person' ? 'character' : object.kind === 'place' ? 'location' : 'product';
      const castNodeId = reuseCastNodeId ?? uid();
      let nextNodes = nodesRef.current.map((node) => {
        if (node.id !== sceneNodeId) return node;
        const data = node.data as unknown as SceneData;
        return {
          ...node,
          data: {
            ...data,
            objects: (data.objects ?? []).map((entry, index) =>
              index === objectIndex ? { ...entry, castNodeId } : entry,
            ),
          },
        };
      });
      if (!reuseCastNodeId) {
        const position = findFreePosition(
          { x: scene.position.x + (scene.width ?? NODE_W) + 100, y: scene.position.y + 180 },
          nextNodes.map((node) => node.position),
        );
        nextNodes = [
          ...nextNodes,
          {
            id: castNodeId,
            type: 'cast',
            width: NODE_W,
            height: NODE_H,
            position,
            data: boardNodeDefaultData('cast', {
              castKind,
              name: object.name,
              imageUrls: [],
              ...(object.description ? { description: object.description } : {}),
            }),
          },
        ];
      }
      // Read the live document BEFORE re-projecting: `currentBoardDocument`
      // drives the same cache off the pre-command refs.
      const base = currentBoardDocument();
      const projected = documentGraphCacheRef.current!.update(nextNodes, edgesRef.current);
      const candidate = validateBoardCommit({
        ...base,
        nodes: projected.documentNodes,
        edges: projected.documentEdges,
      });
      if (!candidate.ok) {
        showToast(candidate.reason);
        return;
      }
      takeSnapshot(`scene:promote:${sceneNodeId}:${objectIndex}`);
      nodesRef.current = nextNodes;
      boardStateRef.current = {
        nodes: projected.documentNodes,
        edges: projected.documentEdges,
        tray: trayRef.current,
      };
      setNodes(nextNodes);
      showToast(
        reuseCastNodeId ? 'Объект переиспользован.' : 'Карточка объекта создана без запуска.',
      );
    },
    [setNodes, showToast, takeSnapshot],
  );

  const promoteSceneObject = useCallback(
    (sceneNodeId: string, objectIndex: number) => {
      const scene = nodesRef.current.find((node) => node.id === sceneNodeId);
      if (scene?.type !== 'scene') return;
      const sceneData = scene.data as unknown as SceneData;
      const object = sceneData.objects?.[objectIndex];
      if (!object || object.castNodeId) return;
      const castKind: CastData['castKind'] =
        object.kind === 'person' ? 'character' : object.kind === 'place' ? 'location' : 'product';
      const normalized = object.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      const matches = nodesRef.current.filter((node) => {
        if (node.type !== 'cast') return false;
        const data = node.data as unknown as CastData;
        return (
          data.castKind === castKind &&
          data.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === normalized
        );
      });
      const candidates = matches.map((node) => {
        const data = node.data as unknown as CastData;
        return {
          id: node.id,
          name: data.name,
          castKind: data.castKind,
          stillCount: data.imageUrls?.length ?? 0,
        };
      });
      // Nothing auto-selects: more than one card of the same kind is a question
      // for the author, and «вещь» always says out loud that it becomes a товар.
      if (candidates.length > 1) {
        setPromotionRequest({
          sceneNodeId,
          objectIndex,
          objectKey: sceneObjectKey(object),
          request: { kind: 'choose', name: object.name, candidates },
        });
        return;
      }
      if (object.kind === 'thing') {
        setPromotionRequest({
          sceneNodeId,
          objectIndex,
          objectKey: sceneObjectKey(object),
          request: candidates[0]
            ? { kind: 'reuse-product', name: object.name, candidate: candidates[0] }
            : { kind: 'create-product', name: object.name },
        });
        return;
      }
      applyScenePromotion(sceneNodeId, objectIndex, candidates[0]?.id ?? null);
    },
    [applyScenePromotion],
  );

  const unlinkSceneObject = useCallback(
    (sceneNodeId: string, objectIndex: number) => {
      const nextNodes = nodesRef.current.map((node) => {
        if (node.id !== sceneNodeId || node.type !== 'scene') return node;
        const data = node.data as unknown as SceneData;
        return {
          ...node,
          data: {
            ...data,
            objects: (data.objects ?? []).map((entry, index) => {
              if (index !== objectIndex) return entry;
              const { castNodeId: _castNodeId, ...rest } = entry;
              return rest;
            }),
          },
        };
      });
      takeSnapshot(`scene:unlink:${sceneNodeId}:${objectIndex}`);
      nodesRef.current = nextNodes;
      const projected = documentGraphCacheRef.current!.update(nextNodes, edgesRef.current);
      boardStateRef.current = {
        nodes: projected.documentNodes,
        edges: projected.documentEdges,
        tray: trayRef.current,
      };
      setNodes(nextNodes);
    },
    [setNodes, takeSnapshot],
  );

  const removeSceneObject = useCallback(
    (sceneNodeId: string, objectIndex: number) => {
      const nextNodes = nodesRef.current.map((node) => {
        if (node.id !== sceneNodeId || node.type !== 'scene') return node;
        const data = node.data as unknown as SceneData;
        return {
          ...node,
          data: {
            ...data,
            objects: (data.objects ?? []).filter((_, index) => index !== objectIndex),
          },
        };
      });
      takeSnapshot(`scene:remove-object:${sceneNodeId}:${objectIndex}`);
      nodesRef.current = nextNodes;
      const projected = documentGraphCacheRef.current!.update(nextNodes, edgesRef.current);
      boardStateRef.current = {
        nodes: projected.documentNodes,
        edges: projected.documentEdges,
        tray: trayRef.current,
      };
      setNodes(nextNodes);
    },
    [setNodes, takeSnapshot],
  );

  const focusBoardNode = useCallback(
    (nodeId: string) => {
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId })));
      void rf.fitView({ nodes: [{ id: nodeId }], padding: 0.35, duration: 250 });
    },
    [rf, setNodes],
  );

  const sceneSourceHref = useCallback(
    (data: SceneData) => {
      if (!data.sourceScriptId) return null;
      const href = `/scenario/${encodeURIComponent(data.sourceScriptId)}`;
      return workspaceProjectId ? withProjectContext(href, workspaceProjectId) : href;
    },
    [workspaceProjectId],
  );

  const sceneShotCount = useCallback(
    (sceneId: string) =>
      nodesRef.current.filter(
        (node) =>
          node.type === 'generate' &&
          (node.data as Record<string, unknown>)['sourceSceneNodeId'] === sceneId,
      ).length,
    [],
  );

  /** Commit a planned reference-pack edit; both directions share the write. */
  const commitCastPackPlan = useCallback(
    (
      castId: string,
      plan: ReturnType<typeof planCastStillRemove>,
      groupKey: string,
      success?: string,
    ) => {
      if (!plan.ok) {
        showToast(plan.reason);
        return;
      }
      const nextNodes = plan.nodes as unknown as Node[];
      const nextEdges = plan.edges as unknown as Edge[];
      const base = currentBoardDocument();
      const projected = documentGraphCacheRef.current!.update(nextNodes, nextEdges);
      const candidate = validateBoardCommit({
        ...base,
        nodes: projected.documentNodes,
        edges: projected.documentEdges,
      });
      if (!candidate.ok) {
        showToast(candidate.reason);
        return;
      }
      takeSnapshot(`${groupKey}:${castId}`);
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      boardStateRef.current = {
        nodes: projected.documentNodes,
        edges: projected.documentEdges,
        tray: trayRef.current,
      };
      setNodes(nextNodes);
      setEdges(nextEdges);
      if (success) showToast(success);
    },
    [setEdges, setNodes, showToast, takeSnapshot],
  );

  /**
   * A reference pack is edited on the card, but it feeds shots elsewhere on the
   * canvas. Both directions therefore answer for those shots before writing.
   */
  const addCastStill = useCallback(
    (castId: string, url: string) => {
      const plan = planCastStillAdd({
        nodes: nodesRef.current as never,
        edges: edgesRef.current as never,
        castId,
        url,
        modelForNode: (node) =>
          node.type === 'generate' ? modelForNode(node.data as unknown as GenerateData) : undefined,
      });
      commitCastPackPlan(castId, plan, `cast:still-add:${url}`);
    },
    [commitCastPackPlan, modelForNode],
  );

  const removeCastStill = useCallback(
    (castId: string, index: number) => {
      const preview = planCastStillRemove({
        nodes: nodesRef.current as never,
        edges: edgesRef.current as never,
        castId,
        index,
      });
      // Ask whenever the write would cut a wire, not only when the wire happens
      // to end on a shot.
      if (preview.ok && preview.edges.length !== edgesRef.current.length) {
        setDetachRequest({ castId, index, shotCount: preview.detachedShotIds.length });
        return;
      }
      commitCastPackPlan(castId, preview, `cast:still-remove:${index}`);
    },
    [commitCastPackPlan],
  );

  const generateCastReference = useCallback(
    (castNodeId: string) => {
      if (castReferenceSpawnReservationsRef.current.has(castNodeId)) {
        const stillIdle = nodesRef.current.some(
          (node) =>
            node.type === 'generate' &&
            (node.data as Record<string, unknown>)['originCastNodeId'] === castNodeId &&
            (node.data as Record<string, unknown>)['status'] === 'idle',
        );
        if (stillIdle) {
          showToast('Для этого объекта референс уже создан на борде.');
          return;
        }
        castReferenceSpawnReservationsRef.current.delete(castNodeId);
      }
      const cast = nodesRef.current.find((node) => node.id === castNodeId);
      if (cast?.type !== 'cast') return;
      const sceneEdge = edgesRef.current.find(
        (edge) => edge.target === castNodeId && edge.targetHandle === 'scene',
      );
      const scene = sceneEdge
        ? nodesRef.current.find((node) => node.id === sceneEdge.source)
        : undefined;
      if (scene?.type === 'scene') {
        const sceneData = scene.data as unknown as SceneData;
        if (!isCastReferenceSceneSeedable(sceneData)) {
          showToast('Сцена удалена из сценария — сначала обновите источник.');
          return;
        }
      }
      const imageCandidates = [
        ...(imageModel && !modelLocked(imageModel) ? [imageModel] : []),
        ...unlockedModelsForMode(models, 'image', planTier).filter(
          (candidate) => candidate.id !== imageModel?.id,
        ),
      ];
      const plan = planCastReference({
        cast: { id: cast.id, data: cast.data as Record<string, unknown> },
        promptId: uid(),
        shotId: uid(),
        edgeId: uid(),
        modelId: imageCandidates[0]?.id,
        sceneContext: scene?.type === 'scene' ? buildSceneContext(scene.data as SceneData) : '',
        existing: documentNodes,
        edges: documentEdges,
        currentDocument: currentBoardDocument(),
      });
      if (!plan) {
        showToast('Нельзя создать ещё один референс на этой карточке.');
        return;
      }
      castReferenceSpawnReservationsRef.current.add(castNodeId);
      takeSnapshot(`cast:reference:${castNodeId}:${plan.nodes[1]!.id}`);
      const nextNodes = [...nodesRef.current, ...(plan.nodes as unknown as Node[])];
      const nextEdges = [
        ...edgesRef.current,
        ...plan.edges.map((edge) => ({ ...edge, type: 'typed', animated: true }) as Edge),
      ];
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      const projected = documentGraphCacheRef.current!.update(nextNodes, nextEdges);
      boardStateRef.current = {
        nodes: projected.documentNodes,
        edges: projected.documentEdges,
        tray: trayRef.current,
      };
      setNodes((current) => [...current, ...(plan.nodes as unknown as Node[])]);
      setEdges((current) => [
        ...current,
        ...plan.edges.map((edge) => ({ ...edge, type: 'typed', animated: true }) as Edge),
      ]);
      showToast('Черновик референса создан — отредактируйте промпт и запустите кадр.');
    },
    [imageModel, modelLocked, models, planTier, setEdges, setNodes, showToast, takeSnapshot],
  );

  const appendCastReference = useCallback(
    (shotId: string) => {
      const shot = nodesRef.current.find((node) => node.id === shotId);
      const rawResultUrl = shot?.data && (shot.data as Record<string, unknown>)['resultUrl'];
      // Narrowed once, here: the dedupe ref below stores it, and an `unknown`
      // would silently widen that ref's type instead of failing at the source.
      const resultUrl = typeof rawResultUrl === 'string' ? rawResultUrl : undefined;
      const previousUrl = castReferenceAppendReservationsRef.current.get(shotId);
      if (previousUrl && typeof resultUrl === 'string' && previousUrl === resultUrl) {
        const originId = (shot?.data as Record<string, unknown> | undefined)?.['originCastNodeId'];
        const cast = nodesRef.current.find((node) => node.id === originId);
        const imageUrls = Array.isArray(cast?.data['imageUrls']) ? cast.data['imageUrls'] : [];
        if (imageUrls.includes(resultUrl)) {
          showToast('Этот референс уже добавлен в объект.');
          return;
        }
        castReferenceAppendReservationsRef.current.delete(shotId);
      }
      const currentState = rfStore.getState();
      const currentResult = appendCastReferenceToGraph({
        nodes: currentState.nodes,
        edges: currentState.edges,
        shotId,
        modelForNode: (node) =>
          node.type === 'generate' ? modelForNode(node.data as unknown as GenerateData) : undefined,
        currentDocument: currentBoardDocument(),
      });
      if (!currentResult.ok) {
        showToast(currentResult.reason);
        return;
      }
      setNodes((current) => {
        const currentEdges = rfStore.getState().edges;
        nodesRef.current = current;
        edgesRef.current = currentEdges;
        const result = appendCastReferenceToGraph({
          nodes: current,
          edges: currentEdges,
          shotId,
          modelForNode: (node) =>
            node.type === 'generate'
              ? modelForNode(node.data as unknown as GenerateData)
              : undefined,
          currentDocument: currentBoardDocument(),
        });
        castReferenceAppendEffectRef.current = { shotId, resultUrl, result };
        return result.ok ? (result.nodes as unknown as Node[]) : current;
      });
    },
    [modelForNode, rfStore, setNodes, showToast],
  );

  useEffect(() => {
    const pending = castReferenceAppendEffectRef.current;
    if (!pending) return;
    castReferenceAppendEffectRef.current = null;
    if (!pending.result.ok) {
      showToast(pending.result.reason);
      return;
    }
    if (typeof pending.resultUrl === 'string') {
      castReferenceAppendReservationsRef.current.set(pending.shotId, pending.resultUrl);
    }
    takeSnapshot(`cast:append:${pending.shotId}:${pending.resultUrl ?? uid()}`);
    nodesRef.current = pending.result.nodes as unknown as Node[];
    edgesRef.current = pending.result.edges as unknown as Edge[];
    const projected = documentGraphCacheRef.current!.update(nodesRef.current, edgesRef.current);
    boardStateRef.current = {
      nodes: projected.documentNodes,
      edges: projected.documentEdges,
      tray: trayRef.current,
    };
    setEdges(edgesRef.current);
    showToast('Выбранный дубль добавлен в объект.');
  }, [nodes, setEdges, showToast, takeSnapshot]);

  /* ---- drag-to-empty-canvas connect menu (Runway pattern) ---- */
  const connectFrom = useRef<{
    nodeId: string | null;
    handleId: string | null;
    handleType: 'source' | 'target';
  } | null>(null);
  const [dropMenu, setDropMenu] = useState<{
    x: number;
    y: number;
    flow: { x: number; y: number };
    offers: DropOffer[];
    from: { nodeId: string; handleId: string | null; handleType: 'source' | 'target' };
  } | null>(null);

  const onConnectStart = useCallback(
    (
      _e: unknown,
      p: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null },
    ) => {
      connectFrom.current = p.handleType
        ? { nodeId: p.nodeId, handleId: p.handleId, handleType: p.handleType }
        : null;
    },
    [],
  );

  const connectionValidation = useCallback(
    (connection: Connection | Edge) =>
      connectionPolicy.validate({
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target: connection.target,
        targetHandle: connection.targetHandle,
      }),
    [connectionPolicy],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, conn: FinalConnectionState) => {
      const from = connectFrom.current;
      connectFrom.current = null;
      if (!from || !from.nodeId) return;
      if (conn?.isValid) return; // a real edge landed on a handle — no menu
      const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!pt) return;
      // React Flow normally keeps `toHandle` for an invalid drop, but a fast
      // pointer-up can finish between its last proximity sample and the DOM
      // hit-test. Recover the handle directly under the pointer so a rejected
      // connection always explains itself instead of silently opening the
      // empty-canvas menu.
      const hovered = document
        .elementFromPoint(pt.clientX, pt.clientY)
        ?.closest<HTMLElement>('.react-flow__handle');
      const hoveredType = hovered?.classList.contains('source')
        ? 'source'
        : hovered?.classList.contains('target')
          ? 'target'
          : null;
      const hoveredNodeId = hovered?.getAttribute('data-nodeid');
      const toHandle =
        conn.toHandle ??
        (hoveredType && hoveredType !== from.handleType && hoveredNodeId
          ? {
              nodeId: hoveredNodeId,
              id: hovered?.getAttribute('data-handleid') ?? null,
            }
          : null);
      if (toHandle) {
        const attempted: Connection =
          from.handleType === 'source'
            ? {
                source: from.nodeId,
                sourceHandle: from.handleId,
                target: toHandle.nodeId,
                targetHandle: toHandle.id ?? null,
              }
            : {
                source: toHandle.nodeId,
                sourceHandle: toHandle.id ?? null,
                target: from.nodeId,
                targetHandle: from.handleId,
              };
        const validation = connectionValidation(attempted);
        if (!validation.ok) {
          setPortRejection({ x: pt.clientX, y: pt.clientY, reason: validation.reason });
          return;
        }
      }
      const origin = nodesRef.current.find((n) => n.id === from.nodeId);
      if (!origin) return;
      const existingInputs = edgesRef.current
        .filter((edge) => edge.target === origin.id)
        .flatMap((edge) => {
          const source = nodesRef.current.find((node) => node.id === edge.source);
          return source?.type && source.type in BOARD_NODE_REGISTRY
            ? [
                {
                  source: {
                    type: source.type as BoardNodeType,
                    data: source.data,
                  } as Pick<BoardNode, 'type' | 'data'>,
                  sourceHandle: edge.sourceHandle,
                  targetHandle: edge.targetHandle,
                },
              ]
            : [];
        });
      const offers = connectOffers(
        origin,
        from.handleId,
        from.handleType,
        modelForNode,
        existingInputs,
      );
      if (!offers.length) return;
      const flow = rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
      setDropMenu({
        x: pt.clientX,
        y: pt.clientY,
        flow,
        offers,
        from: { nodeId: from.nodeId, handleId: from.handleId, handleType: from.handleType },
      });
    },
    [connectionValidation, modelForNode, rf],
  );

  const addNodeConnected = useCallback(
    (
      offer: DropOffer,
      flowPos: { x: number; y: number },
      from: { nodeId: string; handleId: string | null },
    ) => {
      const currentState = rfStore.getState();
      if (
        currentState.nodes.length + 1 > BOARD_LIMITS.nodes ||
        currentState.edges.length + 1 > BOARD_LIMITS.edges
      ) {
        showToast('Достигнут лимит узлов или связей на борде.');
        return null;
      }
      const id = uid();
      const freePosition = findFreePosition(
        { x: flowPos.x - 120, y: flowPos.y - 40 },
        currentState.nodes.map((n) => n.position),
      );
      // Connect-to-empty is commonly dropped near the bottom toolbar. Keep the
      // whole new node above fixed canvas controls so its editor and handles are
      // usable immediately, at every zoom level.
      const visibleTopLeft = rf.screenToFlowPosition({ x: 20, y: 72 });
      const visibleBottomRight = rf.screenToFlowPosition({
        x: window.innerWidth - 20,
        y: window.innerHeight - 130,
      });
      const node: Node = {
        id,
        type: offer.t,
        width: NODE_W,
        height: NODE_H,
        position: clampNodePosition(
          freePosition,
          { width: NODE_W, height: NODE_H },
          {
            left: visibleTopLeft.x,
            top: visibleTopLeft.y,
            right: visibleBottomRight.x,
            bottom: visibleBottomRight.y,
          },
        ),
        data: { ...(NODE_BASE[offer.t] as AnyData), ...offer.d } as Record<string, unknown>,
      };
      const conn: Connection =
        offer.wire === 'newSource'
          ? {
              source: id,
              sourceHandle: offer.newHandle,
              target: from.nodeId,
              targetHandle: from.handleId,
            }
          : {
              source: from.nodeId,
              sourceHandle: from.handleId,
              target: id,
              targetHandle: offer.newHandle,
            };
      const validationNode = {
        ...node,
        data: dropOfferValidationData(offer, node.data),
      };
      const commitPolicy = createBoardConnectionPolicy({
        nodes: [...currentState.nodes, validationNode],
        edges: currentState.edges,
        modelForNode: (candidate) =>
          candidate.type === 'generate'
            ? modelForNode(candidate.data as unknown as GenerateData)
            : undefined,
      });
      const validation = commitPolicy.validate(conn);
      if (!validation.ok) {
        showToast(validation.reason);
        return null;
      }
      takeSnapshot(`connect:${id}`);
      setNodes((nds) => [...nds, node]);
      setEdges((eds) => addEdge({ ...conn, type: 'typed', animated: true }, eds));
      return id;
    },
    [modelForNode, rf, rfStore, setEdges, setNodes, showToast, takeSnapshot],
  );

  /* ---- connection validation (typed ports) ---- */
  const isValid: IsValidConnection = useCallback(
    (connection: Connection | Edge) => connectionValidation(connection).ok,
    [connectionValidation],
  );
  const onConnect = useCallback(
    (c: Connection) => {
      takeSnapshot();
      setEdges((eds) => addEdge({ ...c, type: 'typed', animated: true }, eds));
    },
    [setEdges, takeSnapshot],
  );
  const removeEdge = useCallback(
    (eid: string) => {
      takeSnapshot();
      setEdges((eds) => eds.filter((e) => e.id !== eid));
    },
    [setEdges, takeSnapshot],
  );
  const onDragStart = useCallback(() => takeSnapshot(), [takeSnapshot]);

  /* ---- run a node (resolve wired inputs, submit, await completion) ---- */
  const pending = useRef(new Map<string, (url: string | null) => void>());
  const resolvingJobsRef = useRef(new Set<string>());
  const jobPollInFlightRef = useRef(new Set<string>());
  const jobBatchStateRef = useRef(new Map<string, BoardJobBatchState>());
  // A video batch submits N POSTs one after another. `status` only turns
  // 'running' once the first is accepted, so without a synchronous guard a
  // second click during that window starts a whole second paid batch.
  const submittingNodesRef = useRef(new Set<string>());
  const selectedBatchResultsRef = useRef(new Map<string, string>());
  const didReconcilePersistedJobsRef = useRef(false);
  const runAllControlRef = useRef<DagRunControl | null>(null);
  const runAllOutputsRef = useRef(new Map<string, string>());
  // What each shot's finished job actually produced, recorded synchronously by
  // `resolveJob`. `resolveRefs` needs it the instant a run returns, which is
  // before React has committed the node's `done` patch — reading `resultKind`
  // off `nodesRef` there would be reading a value that is not there yet.
  const shotResultKindRef = useRef(new Map<string, 'video' | 'image'>());
  // Node id → the jobId that was already in flight when the CURRENT plan was
  // built. Only these may be reused instead of run (see `executeRunAll`).
  const runAllInFlightJobsRef = useRef(new Map<string, string>());
  const isRunning = useCallback((id: string) => {
    const n = nodesRef.current.find((x) => x.id === id);
    return (n?.data as unknown as GenerateData)?.status === 'running';
  }, []);
  const selectResult = useCallback(
    (id: string, url: string) => {
      selectedBatchResultsRef.current.set(id, url);
      // Carry the still that belongs to the chosen take: the storyboard and the
      // overview render `lastFrameUrl`, so leaving it on the previous take makes
      // them print a frame from a clip the user is no longer showing.
      const batch = jobBatchStateRef.current.get(id);
      const owningJobId = batch?.jobIds.find((jobId) =>
        (batch.assetsByJobId.get(jobId) ?? []).includes(url),
      );
      const lastFrameUrl = owningJobId ? batch?.lastFrameByJobId.get(owningJobId) : undefined;
      patch(id, {
        resultUrl: url,
        resultKind: isVideoUrl(url) ? 'video' : 'image',
        ...(lastFrameUrl ? { lastFrameUrl } : {}),
      } as Partial<GenerateData>);
    },
    [patch],
  );

  // Resolve a node's upstream reference sources (running upstream shots
  // first if needed). Cast nodes expand to their stills + motion ref via
  // assembleShotRefs — subject-first, capped, deduped (previz S2).
  const resolveRefs = useCallback(
    async (
      genId: string,
      model: BoardResolvedModelContract,
    ): Promise<{
      images: string[];
      frameImages: BoardCompiledFrameImage[];
      videos: string[];
      casts: CastLike[];
    }> => {
      const incoming = edgesRef.current
        .filter(
          (e) =>
            e.target === genId &&
            (imageHandleIndex(e.targetHandle) !== null ||
              referenceImageHandleIndex(e.targetHandle) !== null),
        )
        .sort(
          (a, b) =>
            (referenceImageHandleIndex(a.targetHandle) ?? imageHandleIndex(a.targetHandle)!) -
            (referenceImageHandleIndex(b.targetHandle) ?? imageHandleIndex(b.targetHandle)!),
        );
      const sources: RefSource[] = [];
      const frameImages: BoardCompiledFrameImage[] = [];
      const casts: CastLike[] = [];
      for (const e of incoming) {
        const src = nodesRef.current.find((n) => n.id === e.source);
        if (!src) continue;
        const slot = imageHandleIndex(e.targetHandle);
        const isReferenceChannel = referenceImageHandleIndex(e.targetHandle) !== null;
        const frameRole =
          !isReferenceChannel && model.imageInput.role === 'frame' && slot !== null
            ? model.imageInput.frameRoles[slot]
            : undefined;
        const addImage = (url: string) => {
          if (frameRole) frameImages.push({ role: frameRole, url });
          else sources.push({ kind: 'image', url });
        };
        // An upstream shot's result goes through ONE classifier whichever route
        // it arrived by — already `done` below, held in the Run All output map,
        // or just returned by an inline run — and that is the same
        // `isVideoShotResult` the price mirror predicts with. Passing the
        // recorded `resultKind` matters: classifying by URL suffix alone reads
        // a video served from an extension-less URL as an image, which is
        // exactly the disagreement that unbinds a submit.
        //
        // Before this, the two later branches called `addImage` unconditionally,
        // so the same graph wired a generated clip as a motion ref when the
        // upstream's `done` patch had landed and as a still (or a first FRAME —
        // an .mp4 in a frame slot) when it had not. No synchronous price mirror
        // can predict a coin flip.
        //
        // NOTE what "motion ref" means today: `assembleShotRefs` below caps
        // motion refs at `model.videoReferenceMax`, and EVERY live model seeds
        // `maxVideoRefs: 0`, so a clip classified here is dropped and reaches no
        // provider at all. This is not clip-to-clip chaining; it is a
        // consistent, priceable classification of something currently discarded.
        const addUpstreamResult = (url: string) => {
          const resultKind = shotResultKindRef.current.get(src.id);
          if (isVideoShotResult({ url, resultKind })) sources.push({ kind: 'video', url });
          else addImage(url);
        };
        if (src.type === 'media') {
          const md = src.data as unknown as MediaData;
          const identified = md.assetId ? assetLifecycle.get(md.assetId) : undefined;
          const sourceUrl = md.assetId
            ? identified?.available
              ? identified.assetUrl
              : ''
            : md.url;
          if (!sourceUrl) continue;
          // a video reference rides as a motion ref (videoUrls), not a still
          if (md.mediaKind === 'video') sources.push({ kind: 'video', url: sourceUrl });
          else addImage(sourceUrl);
        } else if (src.type === 'cast') {
          const cd = src.data as unknown as CastData;
          sources.push({ kind: 'cast', cast: cd });
          casts.push(cd);
        } else if (src.type === 'generate') {
          const sd = src.data as unknown as GenerateData;
          if (sd.status === 'done' && sd.resultUrl) {
            // the chosen take (take-strip) is what rides downstream; a generated
            // clip rides as a motion ref, a generated still as an image ref
            if (isVideoShotResult({ url: sd.resultUrl, resultKind: sd.resultKind }))
              sources.push({ kind: 'video', url: sd.resultUrl });
            else addImage(sd.resultUrl);
          } else if (runAllOutputsRef.current.has(src.id)) {
            addUpstreamResult(runAllOutputsRef.current.get(src.id)!);
          } else {
            const u = await runNodeRef.current(src.id); // run upstream first
            if (u) addUpstreamResult(u);
          }
        }
      }
      const bundle = assembleShotRefs(sources, {
        images: model.referenceImageMax > 0 ? model.referenceImageMax : model.imageInput.max,
        videos: model.videoReferenceMax,
      });
      return { images: bundle.imageUrls, frameImages, videos: bundle.videoUrls, casts };
    },
    [assetLifecycle],
  );

  const runNodeRef = useRef<(id: string) => Promise<string | null>>(async () => null);
  runNodeRef.current = async (id: string): Promise<string | null> => {
    const nodesById = new Map(nodesRef.current.map((candidate) => [candidate.id, candidate]));
    const node = nodesById.get(id);
    if (!node || node.type !== 'generate') return null;
    const diagnostic = nodeDiagnostics.get(id);
    if (diagnostic && !diagnostic.executable) {
      const reason =
        diagnostic.settingIssues[0]?.reason ??
        diagnostic.edgeIssues[0]?.reason ??
        diagnostic.generalIssues[0]?.reason;
      showToast(reason ? `Нельзя запустить: ${reason}` : 'Кадр пока не готов к запуску.');
      return null;
    }
    if (boardGenerateGraphHasCycle(nodesRef.current, edgesRef.current)) {
      showToast('Граф генерации содержит цикл. Удалите одну из связей между кадрами.');
      return null;
    }
    const d = node.data as unknown as GenerateData;
    if (d.status === 'running') {
      const jobIds = d.jobIds?.length ? d.jobIds : d.jobId ? [d.jobId] : [];
      if (jobIds.length === 0) return null;
      return await new Promise<string | null>((resolve) => {
        const outputs = new Map<string, string | null>();
        const finish = () => {
          if (outputs.size !== jobIds.length) return;
          resolve(
            jobIds.map((jobId) => outputs.get(jobId)).find((url): url is string => Boolean(url)) ??
              null,
          );
        };
        for (const jobId of jobIds) {
          pending.current.set(jobId, (url) => {
            outputs.set(jobId, url);
            finish();
          });
        }
      });
    }
    const model = modelForNode(d);
    if (!model) {
      showToast('Для кадра не выбрана доступная модель.');
      return null;
    }
    // P-B2: a saved board can still carry an out-of-plan model (the user
    // downgraded, or the row's tier changed). Stop here instead of spending a
    // round-trip on the server's 403 — «Запустить всё» reaches this path too.
    if (modelLocked(model)) {
      showToast(tierUpsellLabel(model));
      return null;
    }
    const incomingEdges = edgesRef.current.filter((candidate) => candidate.target === id);
    const connections = [];
    for (const edge of incomingEdges) {
      const source = nodesById.get(edge.source);
      if (!source?.type || !(source.type in BOARD_NODE_REGISTRY)) {
        showToast('У кадра есть связь с неизвестным исходным узлом.');
        return null;
      }
      connections.push({
        source: {
          type: source.type as BoardNodeType,
          data: source.data,
        } as Pick<BoardNode, 'type' | 'data'>,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      });
    }
    const semantic = validateBoardConnections({
      target: { type: 'generate', data: node.data } as Pick<BoardNode, 'type' | 'data'>,
      targetModel: model,
      connections,
      requireReady: true,
    });
    if (!semantic.ok) {
      showToast(`Несовместимая связь: ${semantic.reason}`);
      return null;
    }

    const promptText = resolveGeneratePrompt(
      node,
      nodesById,
      incomingEdges.map((edge) => ({
        source: edge.source,
        targetHandle: edge.targetHandle ?? null,
      })),
    );
    const { images, frameImages, videos, casts } = await resolveRefs(id, semantic.model);
    // B-4: the structured grammar leads the prompt for BOTH modes (no-op when
    // unset, so existing boards are unchanged).
    const shotPrompt = buildShotPrompt({ grammar: d.shot, text: promptText });
    // Cast naming convention (no API roles exist): the prompt names the
    // wired персонажи/локации; their stills already lead the ref array.
    const castPrefix = castPromptPrefix(casts);
    const finalPrompt = castPrefix ? `${castPrefix} ${shotPrompt}`.trim() : shotPrompt;
    if (!finalPrompt && images.length === 0 && frameImages.length === 0) {
      showToast('Узлу нужен промпт или входное изображение.');
      return null;
    }
    const compiled = compileBoardGenerationRequest({
      data: d,
      model,
      prompt: finalPrompt || ' ',
      imageUrls: images,
      frameImages,
      videoUrls: videos,
    });
    if (!compiled.ok) {
      showToast(`Нельзя запустить: ${compiled.reason}`);
      return null;
    }
    const params = compiled.request.params;
    // Gateway routing under the operator policy (temp dev widget): `auto`
    // sends video-ref shots to AtlasCloud (only gateway that carries them)
    // and everything else to OpenRouter (cheapest); force modes override.
    const shotRefs = {
      videoUrls: params['videoUrls'] as string[] | undefined,
      audioUrls: params['audioUrls'] as string[] | undefined,
    };
    const policy = gatewayPolicyRef.current;
    const provider = resolveProvider(policy, shotRefs);
    if (willDropVideoRefs(policy, shotRefs)) {
      showToast('OpenRouter не принимает видео-референсы — они будут проигнорированы.');
    }

    // Quote binding, and it FAILS CLOSED. The key comes from the request
    // COMPILED ABOVE, not from whatever the node is showing now, so a hit
    // proves the stored number is this request's price. That closes the window
    // this function opens by design: `d` and `model` were snapshotted before
    // the awaited `resolveRefs`, so the badge may have re-rendered for
    // different settings since — and a badge that moved wrote a different key.
    //
    // A miss is not "we cannot tell" any more. Both quote surfaces publish the
    // key of exactly what they quoted, so no entry for THIS key means this
    // request's price was never put in front of anyone. Submitting anyway would
    // charge an unshown number, which is the whole thing this release exists to
    // stop — so we refuse, leave the shot idle, and pull a fresh quote. In Run
    // All this fails only THIS task: `executeBoardRunPlan` turns a null return
    // into a failed task and leaves descendants blocked, exactly as for any
    // other failure. Pressing «Снять» on a shot whose badge shows a price is
    // unaffected — the node's own run button is disabled while the price is
    // unknown, so a miss there needs a change RACING the click.
    const quoteKey = boardQuoteKey({
      modelId: compiled.request.modelId,
      mode: compiled.model.mode,
      params,
    });
    const expectedCost = nodeQuotesRef.current.read(id, quoteKey);
    if (expectedCost === null) {
      setQuoteRefresh((previous) => ({ ...previous, [id]: (previous[id] ?? 0) + 1 }));
      showToast('Цена кадра не подтверждена — дождитесь цены на карточке и запустите снова.');
      return null;
    }
    // One video shot with count > 1 fans out into that many jobs. `expectedCost`
    // above prices ONE job, and each POST binds to that same per-job number —
    // the batch total is a display concern only (board-generation-batch.ts).
    const requestedJobs = d.mode === 'video' ? Math.max(1, d.count ?? 1) : 1;
    const acceptedJobIds: string[] = [];
    const acceptedResults = new Map<string, string | null>();
    let submissionFinished = false;
    let resolveAccepted: ((url: string | null) => void) | null = null;
    const acceptedCompletion = new Promise<string | null>((resolve) => {
      resolveAccepted = resolve;
    });
    const maybeFinishAccepted = () => {
      if (!submissionFinished || acceptedResults.size !== acceptedJobIds.length) return;
      const output = acceptedJobIds
        .map((jobId) => acceptedResults.get(jobId))
        .find((url): url is string => Boolean(url));
      resolveAccepted?.(selectedBatchResultsRef.current.get(id) ?? output ?? null);
      resolveAccepted = null;
    };
    const registerAcceptedJob = (jobId: string) => {
      acceptedJobIds.push(jobId);
      pending.current.set(jobId, (url) => {
        acceptedResults.set(jobId, url);
        maybeFinishAccepted();
      });
      // Persist after EVERY accepted POST, not once the whole fan-out finishes:
      // each of these is already paid for, and a reload between two POSTs would
      // otherwise leave the board with no record of the jobs it just bought.
      jobBatchStateRef.current.set(id, createBoardJobBatchState(acceptedJobIds));
      patch(id, {
        status: 'running',
        jobId: acceptedJobIds[0],
        ...(acceptedJobIds.length > 1 ? { jobIds: [...acceptedJobIds] } : {}),
        failureMessage: undefined,
        failureAction: undefined,
      } as Partial<GenerateData>);
    };
    const showPartialSubmitFailure = () => {
      showToast(
        `Запущено ${acceptedJobIds.length} из ${requestedJobs} кадров; остальные не запустились.`,
      );
    };

    if (submittingNodesRef.current.has(id)) return null;
    submittingNodesRef.current.add(id);
    try {
      for (let attempt = 0; attempt < requestedJobs; attempt++) {
        let res: Response;
        try {
          res = await withAbortDeadline(`submit:${id}`, BOARD_JOB_NETWORK_TIMEOUT_MS, (signal) =>
            fetch(`${apiUrl}/v1/jobs`, {
              method: 'POST',
              credentials: 'include',
              signal,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                source: 'boards',
                modelId: compiled.request.modelId,
                prompt: compiled.request.prompt,
                params,
                ...(workspaceProjectId ? { projectId: workspaceProjectId } : {}),
                ...(provider ? { provider } : {}),
                expectedCost,
                idempotencyKey: randomKey(),
              }),
            }),
          );
        } catch (error) {
          if (acceptedJobIds.length > 0) {
            showPartialSubmitFailure();
            break;
          }
          showToast(
            error instanceof DagTaskDeadlineError
              ? 'Сервер слишком долго не отвечал — кадр не был запущен.'
              : 'Нет связи с сервером.',
          );
          return null;
        }
        if (res.status === 402) {
          if (acceptedJobIds.length > 0) {
            invalidateBalance();
            showPartialSubmitFailure();
            break;
          }
          showToast('Недостаточно токенов — пополни баланс.');
          invalidateBalance();
          return null;
        }
        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          // `signup_required` is checked BEFORE the partial-batch branch: it is
          // a redirect to sign-up, and swallowing it as "some takes failed"
          // would strand an anonymous user on a board they cannot run.
          if (acceptedJobIds.length > 0 && body?.error !== 'signup_required') {
            showPartialSubmitFailure();
            break;
          }
          if (body?.error === 'signup_required') {
            // Pre-paywall anonymous browsing (2026-07-07): the hard wall — an
            // anonymous session reached the actual credit-spending "Run" call.
            // The board itself already autosaved server-side (anon sessions can
            // create/edit freely), so ?next= just needs to send them back here.
            const next = workspaceProjectId
              ? `/boards/${boardId}?projectId=${encodeURIComponent(workspaceProjectId)}`
              : `/boards/${boardId}`;
            window.location.href = `/login?next=${encodeURIComponent(next)}`;
            return null;
          }
          showToast('Эта модель недоступна на вашем тарифе.');
          return null;
        }
        if (res.status === 409) {
          const body = await res
            .clone()
            .json()
            .catch(() => null);
          if (body?.error === 'quote_stale') {
            // The catalogue moved between the badge's quote and this submit.
            // Nothing was reserved and nothing was charged for THIS take. Takes
            // already accepted keep running — they were bound to the old price
            // and paid at it — but the rest of the batch stops here rather than
            // re-submitting at a price the user has not seen.
            setQuoteRefresh((previous) => ({ ...previous, [id]: (previous[id] ?? 0) + 1 }));
            showToast(
              typeof body.message === 'string' && body.message
                ? body.message
                : 'Цена изменилась — проверьте кадр и запустите снова.',
            );
            if (acceptedJobIds.length > 0) break;
            return null;
          }
        }
        if (!res.ok) {
          if (acceptedJobIds.length > 0) {
            showPartialSubmitFailure();
            break;
          }
          // Capacity caps: explicit RU copy instead of the generic HTTP
          // fallback — nothing was charged, the balance is re-checked.
          const capsBody = (await res.json().catch(() => null)) as {
            error?: string;
            message?: string;
          } | null;
          if (res.status === 429 && capsBody?.error === 'too_many_active_jobs') {
            invalidateBalance();
            showToast(
              'Слишком много активных задач. Дождитесь завершения одной и повторите — ничего не списано.',
            );
            return null;
          }
          if (
            res.status === 503 &&
            (capsBody?.error === 'generation_disabled' ||
              capsBody?.error === 'daily_spend_cap_exceeded')
          ) {
            invalidateBalance();
            showToast(
              typeof capsBody?.message === 'string' && capsBody.message
                ? capsBody.message
                : 'Генерация временно недоступна. Попробуйте позже — ничего не списано.',
            );
            return null;
          }
          showToast(`Не удалось запустить (HTTP ${res.status}).`);
          return null;
        }
        const body = await res.json();
        registerAcceptedJob(body.jobId as string);
        invalidateBalance();
        window.dispatchEvent(new Event(JOB_SUBMITTED_EVENT));
      }
    } finally {
      submittingNodesRef.current.delete(id);
    }

    if (acceptedJobIds.length === 0) return null;
    submissionFinished = true;
    maybeFinishAccepted();
    selectedBatchResultsRef.current.delete(id);
    return await acceptedCompletion;
  };
  const run = useCallback((id: string) => void runNodeRef.current(id), []);

  /* ---- «Снять всё»: pre-run cost preview + DAG execution ---- */
  const openRunAll = useCallback(() => {
    const invalid = graphDiagnostic.nodes.find((diagnostic) => !diagnostic.executable);
    if (invalid) {
      const reason =
        invalid.settingIssues[0]?.reason ??
        invalid.edgeIssues[0]?.reason ??
        invalid.generalIssues[0]?.reason;
      showToast(reason ? `Исправьте кадр: ${reason}` : 'Один из кадров пока не готов.');
      return;
    }
    // The diagnostic above is structural — it has no concept of a plan tier, so a shot
    // whose persisted model the current plan no longer entitles is still `executable`.
    // The sheet would then quote it (the estimate endpoint prices a locked model and
    // answers 200 with `tierAllowed:false` rather than refusing), sum it into the total
    // the user approves, and only refuse it at execution, where `runNodeRef` drops the
    // task. The approved number could never be spent. Same gate the single-shot and
    // mobile paths already run, applied before a total exists to approve.
    const lockedNode = nodesRef.current.find((candidate) => {
      if (candidate.type !== 'generate') return false;
      return modelLocked(modelForNode(candidate.data as unknown as GenerateData));
    });
    if (lockedNode) {
      showToast(
        tierUpsellLabel(modelForNode(lockedNode.data as unknown as GenerateData) ?? undefined),
      );
      return;
    }
    const pn: PlanNode[] = nodesRef.current.map((n) => {
      const d = n.data as unknown as GenerateData;
      return {
        id: n.id,
        type: n.type,
        mode: d?.mode,
        count: d?.count,
        status: d?.status,
        jobId: d?.jobId,
      };
    });
    const pe: PlanEdge[] = edgesRef.current.map((e) => ({
      source: e.source,
      target: e.target,
      targetHandle: e.targetHandle,
    }));
    const requests: Record<string, NodeEstimateRequest | undefined> = {};
    for (const n of pn) {
      if (n.type !== 'generate') continue;
      const node = nodesRef.current.find((candidate) => candidate.id === n.id);
      const d =
        (node?.data as unknown as GenerateData) ?? ({ mode: n.mode ?? 'video' } as GenerateData);
      const model = modelForNode(d);
      const modelContract = resolveBoardModelContract(model);
      const imageRefs = wiredImageRefs({
        nodeId: n.id,
        nodes: nodesRef.current as unknown as BoardQuoteNodeLike[],
        edges: edgesRef.current,
        imageInput: modelContract?.imageInput ?? { role: 'none', max: 0, frameRoles: [] },
        imageReferenceMax: modelContract?.referenceImageMax ?? 0,
        resolveAssetUrl: resolveQuoteAssetUrl,
      });
      requests[n.id] = nodeEstimateRequest({
        mode: d.mode,
        model,
        settings: d,
        count: d.count,
        imageUrls: imageRefs.imageUrls,
        frameImages: imageRefs.frameImages,
        pendingReferenceCount: imageRefs.pendingReferenceCount,
        pendingFrameCount: imageRefs.pendingFrameCount,
        // Same price-relevant reference shape the run will compile — without it
        // the sheet's total silently omits the reference inputs and video-input
        // price steps.
        videoUrls: wiredVideoRefUrls({
          nodeId: n.id,
          nodes: nodesRef.current as unknown as BoardQuoteNodeLike[],
          edges: edgesRef.current,
          videoReferenceMax: resolveBoardModelContract(model)?.videoReferenceMax ?? 0,
          resolveAssetUrl: resolveQuoteAssetUrl,
        }),
      });
    }
    // Each planned shot gets its own server estimate. The sheet never invents a
    // local total: it remains «—» until every addend is quoted.
    setRunAllRequests(requests);
    setRunAllQuotes({});
    const plan = planRunAll(pn, pe);
    // Freeze WHICH job each in-flight shot was waiting on at the moment this
    // plan was priced. `executeRunAll` reuses a finished result only for these,
    // and only while the jobId still matches — see the note there.
    runAllInFlightJobsRef.current = new Map(
      plan.inFlight.flatMap((nodeId) => {
        const jobId = pn.find((candidate) => candidate.id === nodeId)?.jobId;
        return jobId ? [[nodeId, jobId] as const] : [];
      }),
    );
    setRunAllPlan(plan);
  }, [graphDiagnostic.nodes, modelForNode, modelLocked, resolveQuoteAssetUrl, showToast]);

  // The pure scheduler unlocks only dependency-ready shots, runs independent
  // branches with a bounded default of three, and never launches a descendant
  // after its upstream failed. Fresh outputs are held synchronously so a newly
  // unlocked child cannot recursively double-run an upstream before React has
  // committed the upstream node's `done` patch.
  const executeRunAll = useCallback(
    async (plan: RunPlan) => {
      setRunAllPlan(null);
      if (plan.tasks.length === 0) return;
      const control = createDagRunControl();
      trackEvent(PlausibleEvent.boardRunStarted);
      runAllControlRef.current = control;
      runAllOutputsRef.current.clear();
      setRunAllStopping(false);
      setRunningAll(true);
      try {
        const result = await executeBoardRunPlan({
          plan,
          control,
          // A shot that FINISHED while the plan sat on screen is not a new job.
          // `planRunAll` files an already-running shot under `inFlight`, which
          // is deliberately excluded from `items` — so the sheet never quoted
          // it and it is not part of the total the user approved — while still
          // scheduling it as a task. `runNode`'s only wait-branch keys on
          // `status === 'running'`, so once the job lands the shot falls
          // through and gets compiled and SUBMITTED AGAIN: a second charge for
          // a generation nobody approved and was never shown a price for.
          // Reuse the finished result instead. Returning the URL is what the
          // scheduler wants — a truthy return marks the task done and feeds
          // `onOutput`, so descendants still unlock.
          //
          // Scoped to EXACTLY that shot and that job. `status === 'done'` alone
          // is far too wide: every non-done node is a task, and an idle or
          // failed one IS quoted as new work in the approved total, so reusing
          // it because it happened to reach `done` by some other route would
          // silently skip work the user paid for. Only a node the plan filed as
          // in-flight, still carrying the same jobId, qualifies. And only here:
          // a user pressing «Переснять» on a finished shot means it.
          runNode: (id) => {
            const inFlightJobId = runAllInFlightJobsRef.current.get(id);
            const data = nodesRef.current.find((node) => node.id === id)?.data as
              | GenerateData
              | undefined;
            if (
              inFlightJobId !== undefined &&
              data?.status === 'done' &&
              data.resultUrl &&
              data.jobId === inFlightJobId
            ) {
              return Promise.resolve(data.resultUrl);
            }
            return runNodeRef.current(id);
          },
          onOutput: (id, output) => runAllOutputsRef.current.set(id, output),
        });
        const failed = result.tasks.filter((task) => task.status === 'failed').length;
        if (failed > 0) {
          showToast(
            failed === 1
              ? 'Один кадр не завершился; зависимые кадры не запускались.'
              : `${failed} кадра не завершились; зависимые кадры не запускались.`,
          );
        }
      } finally {
        runAllControlRef.current = null;
        runAllOutputsRef.current.clear();
        setRunAllStopping(false);
        setRunningAll(false);
      }
    },
    [showToast],
  );

  const stopRunAll = useCallback(() => {
    if (!runAllControlRef.current || runAllStopping) return;
    runAllControlRef.current.stop();
    setRunAllStopping(true);
    showToast('Новые кадры не запускаются. Уже отправленные задачи останутся в очереди.');
  }, [runAllStopping, showToast]);

  const reportRunAllQuote = useCallback((id: string, quote: RunAllQuote) => {
    // The sheet's own quotes go into the SAME registry the badges write to.
    // Without this the user approves an exact total and the whole plan submits
    // unbound: `executeRunAll` goes through the ordinary `runNode`, which reads
    // the registry — and in overview mode (or for any shot scrolled out of
    // view) React Flow has unmounted every node that would have written one.
    if (quote.key !== null && quote.cost !== null) {
      nodeQuotesRef.current.publish(id, quote.key, quote.cost);
    }
    setRunAllQuotes((previous) => {
      const current = previous[id];
      if (
        current?.cost === quote.cost &&
        current?.refusal?.code === quote.refusal?.code &&
        current?.refusal?.message === quote.refusal?.message &&
        current?.key === quote.key
      ) {
        return previous;
      }
      return { ...previous, [id]: quote };
    });
  }, []);
  const runAllQuotesComplete =
    runAllPlan !== null &&
    runAllPlan.items.every((item) => typeof runAllQuotes[item.id]?.cost === 'number');
  const runAllTotal = runAllQuotesComplete
    ? runAllPlan!.items.reduce((sum, item) => {
        const quote = runAllQuotes[item.id]!;
        // Per-job price × the jobs this shot fans out into: the user approves
        // what will actually be charged, while the registry keeps binding the
        // per-job number each POST carries.
        return sum + quote.cost! * quote.takes;
      }, 0)
    : null;

  // resolve a finished job → set node result + release any awaiter
  const resolveJob = useCallback(
    async (jobId: string, failed: boolean) => {
      const node = nodesRef.current.find((n) => {
        const data = n.data as unknown as GenerateData;
        return data?.jobId === jobId || data?.jobIds?.includes(jobId);
      });
      if (!node) return;
      if (resolvingJobsRef.current.has(jobId)) return;
      resolvingJobsRef.current.add(jobId);
      try {
        const done = pending.current.get(jobId);
        pending.current.delete(jobId);
        const nodeData = node.data as unknown as GenerateData;
        const jobIds = nodeData.jobIds?.length
          ? nodeData.jobIds
          : nodeData.jobId
            ? [nodeData.jobId]
            : [];
        let batch = jobIds.length > 1 ? jobBatchStateRef.current.get(node.id) : undefined;
        if (jobIds.length > 1 && !batch) {
          batch = createBoardJobBatchState(jobIds, nodeData.takes, nodeData.lastFrameUrl);
          jobBatchStateRef.current.set(node.id, batch);
        }
        if (batch?.terminal.has(jobId)) return;
        const jb = await withAbortDeadline(
          `result:${jobId}`,
          BOARD_JOB_NETWORK_TIMEOUT_MS,
          (signal) =>
            fetch(`${apiUrl}/v1/jobs/${jobId}`, { credentials: 'include', signal }).then((r) =>
              r.ok ? r.json() : null,
            ),
        ).catch(() => null);
        const assets: string[] = jb?.resultAssets ?? [];
        const vids = assets.filter(isVideoUrl);
        const stills = assets.filter((a) => !isVideoUrl(a));

        if (batch) {
          const guidance = jobFailureGuidance(jb?.errorCode, jb?.errorMessage);
          const jobFailed = failed || jb?.status === 'failed' || assets.length === 0;
          batch.terminal.add(jobId);
          if (jobFailed) {
            batch.failed.add(jobId);
            batch.failure ??= guidance;
          } else {
            const main = vids[0] ?? assets[0]!;
            batch.successful.add(jobId);
            batch.assetsByJobId.set(jobId, vids);
            batch.mainByJobId.set(jobId, main);
            if (vids[0] && stills[0]) batch.lastFrameByJobId.set(jobId, stills[0]);
          }

          const takes = boardTakesInSubmitOrder(
            batch.jobIds,
            batch.assetsByJobId,
            batch.initialTakes,
          );
          const firstTake = takes[0];
          const firstMain = batch.jobIds
            .map((acceptedJobId) => batch.mainByJobId.get(acceptedJobId))
            .find((url): url is string => Boolean(url));
          const latestNode = nodesRef.current.find((candidate) => candidate.id === node.id);
          const latestData = latestNode?.data as unknown as GenerateData | undefined;
          const selected = selectedBatchResultsRef.current.get(node.id);
          const persistedSelection =
            !selected &&
            batch.initialTakes.length > 0 &&
            latestData?.resultUrl &&
            takes.includes(latestData.resultUrl)
              ? latestData.resultUrl
              : undefined;
          const resultUrl =
            (selected && takes.includes(selected) ? selected : undefined) ??
            persistedSelection ??
            firstTake ??
            firstMain;
          // The still must belong to the take that is actually selected — the
          // storyboard and the overview both render it, so a batch that keeps
          // job 1's frame while showing job 3's clip prints the wrong shot.
          const selectedJobId = resultUrl
            ? batch.jobIds.find((acceptedJobId) =>
                (batch.assetsByJobId.get(acceptedJobId) ?? []).includes(resultUrl),
              )
            : undefined;
          const lastFrameUrl =
            (selectedJobId ? batch.lastFrameByJobId.get(selectedJobId) : undefined) ??
            batch.initialLastFrameUrl ??
            batch.jobIds
              .map((acceptedJobId) => batch.lastFrameByJobId.get(acceptedJobId))
              .find((url): url is string => Boolean(url));
          const allTerminal = batch.terminal.size === batch.jobIds.length;
          const hasAsset = batch.initialTakes.length > 0 || batch.successful.size > 0;

          if (allTerminal && batch.failed.size === batch.jobIds.length && !hasAsset) {
            const failure = batch.failure ?? guidance;
            patch(node.id, {
              status: 'failed',
              failureMessage: failure.message,
              failureAction: failure.action,
            } as Partial<GenerateData>);
          } else {
            patch(node.id, {
              status: allTerminal ? 'done' : 'running',
              ...(resultUrl ? { resultUrl } : {}),
              ...(firstMain ? { resultKind: isVideoUrl(firstMain) ? 'video' : 'image' } : {}),
              takes,
              failureMessage: undefined,
              failureAction: undefined,
              ...(lastFrameUrl ? { lastFrameUrl } : {}),
            } as Partial<GenerateData>);
          }

          // A batch waiter resolves after every accepted job, while its output
          // remains the first successful job in submit order.
          done?.(jobFailed ? null : (batch.mainByJobId.get(jobId) ?? null));
          return;
        }

        if (failed || jb?.status === 'failed') {
          const guidance = jobFailureGuidance(jb?.errorCode, jb?.errorMessage);
          patch(node.id, {
            status: 'failed',
            failureMessage: guidance.message,
            failureAction: guidance.action,
          } as Partial<GenerateData>);
          done?.(null);
          return;
        }
        if (!assets.length) {
          const guidance = jobFailureGuidance(jb?.errorCode, jb?.errorMessage);
          patch(node.id, {
            status: 'failed',
            failureMessage: guidance.message,
            failureAction: guidance.action,
          } as Partial<GenerateData>);
          done?.(null);
          return;
        }
        const main = vids[0] ?? assets[0]!;
        // The shot's takes (video shots: clips only). resultUrl is the chosen
        // "best" take — defaults to the first; the node's take-strip lets the
        // user pick another (B-3).
        const takes =
          node.data && (node.data as unknown as GenerateData).mode === 'video' ? vids : assets;
        const resultKind: 'video' | 'image' = vids[0] ? 'video' : 'image';
        // Recorded BEFORE the awaiter is released: `resolveRefs` classifies the
        // returned result the instant `runNode` resolves, which is earlier than
        // React commits the patch below.
        shotResultKindRef.current.set(node.id, resultKind);
        patch(node.id, {
          status: 'done',
          resultUrl: main,
          resultKind,
          takes,
          failureMessage: undefined,
          failureAction: undefined,
          ...(vids[0] && stills[0] ? { lastFrameUrl: stills[0] } : {}),
        } as Partial<GenerateData>);

        // Generated images and videos stay inside their own card: the take-strip
        // picks the best one and the card itself is the reference you wire
        // downstream. Separate media cards are for attachments (uploads/project
        // media) only — spawning them here duplicates generated results.
        done?.(main);
      } finally {
        resolvingJobsRef.current.delete(jobId);
      }
    },
    [apiUrl, patch],
  );

  useEffect(() => {
    const onJob = (e: Event) => {
      const det = (e as CustomEvent).detail as { jobId: string; status: string };
      if (!det || (det.status !== 'succeeded' && det.status !== 'failed')) return;
      void resolveJob(det.jobId, det.status === 'failed');
    };
    window.addEventListener(JOB_EVENT, onJob);
    return () => window.removeEventListener(JOB_EVENT, onJob);
  }, [resolveJob]);

  // poll fallback for running nodes
  useEffect(() => {
    const hasRunning = nodes.some((n) => (n.data as unknown as GenerateData)?.status === 'running');
    if (!hasRunning) return;
    const t = setInterval(() => {
      for (const n of nodesRef.current) {
        const d = n.data as unknown as GenerateData;
        const jobIds = d?.jobIds?.length ? d.jobIds : d?.jobId ? [d.jobId] : [];
        if (d?.status !== 'running') continue;
        for (const jobId of jobIds) {
          if (jobPollInFlightRef.current.has(jobId)) continue;
          jobPollInFlightRef.current.add(jobId);
          void withAbortDeadline(`poll:${jobId}`, BOARD_JOB_NETWORK_TIMEOUT_MS, (signal) =>
            fetch(`${apiUrl}/v1/jobs/${jobId}`, { credentials: 'include', signal }).then((r) =>
              r.ok ? r.json() : null,
            ),
          )
            .then((b) => {
              if (b?.status === 'succeeded') void resolveJob(jobId, false);
              if (b?.status === 'failed') void resolveJob(jobId, true);
            })
            .catch(() => null)
            .finally(() => jobPollInFlightRef.current.delete(jobId));
        }
      }
    }, 5000);
    return () => clearInterval(t);
  }, [nodes, apiUrl, resolveJob]);

  // Reload recovery: recreate waiters for persisted running job ids. This does
  // not submit anything new; the bounded poll/event paths above reconcile each
  // terminal job and the global tray remains the source of truth after Stop.
  useEffect(() => {
    if (didReconcilePersistedJobsRef.current) return;
    didReconcilePersistedJobsRef.current = true;
    const runningIds = nodesRef.current
      .filter((node) => {
        const data = node.data as unknown as GenerateData;
        return node.type === 'generate' && data.status === 'running' && Boolean(data.jobId);
      })
      .map((node) => node.id);
    if (runningIds.length === 0) return;
    setReconcilingJobs(true);
    void resumePersistedBoardJobs({
      nodeIds: runningIds,
      runNode: (id) => runNodeRef.current(id),
    }).finally(() => setReconcilingJobs(false));
  }, []);

  /* ---- montage tray + studio ---- */
  const toTray = useCallback(
    (id: string) => {
      if (!trayRef.current.includes(id)) takeSnapshot();
      setTray((t) => (t.includes(id) ? t : [...t, id]));
    },
    [takeSnapshot],
  );
  const trayNodes = tray
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is Node => Boolean(n && (n.data as unknown as GenerateData)?.resultUrl));

  function probeDur(url: string): Promise<number> {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      let settled = false;
      const finish = (duration = 5) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        v.onloadedmetadata = null;
        v.onerror = null;
        v.removeAttribute('src');
        v.load();
        resolve(duration);
      };
      const timeout = window.setTimeout(() => finish(), 8_000);
      v.onloadedmetadata = () =>
        finish(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 5);
      v.onerror = () => finish();
      v.src = url;
    });
  }
  // Аниматик (previz S5): the storyboard cut without manual tray work —
  // every rendered video shot in canvas reading order (y, then x, then id).
  function animaticNodes(): Node[] {
    return nodesRef.current
      .filter((n) => {
        const d = n.data as unknown as GenerateData;
        return n.type === 'generate' && d?.resultKind === 'video' && d?.resultUrl;
      })
      .sort(compareBoardReadingOrder);
  }
  async function assemble(list?: Node[], studioProjectId?: string) {
    const picked = list ?? trayNodes;
    if (picked.length === 0 || assembling) return;
    setAssembling(true);
    try {
      const clips = [];
      for (const n of picked) {
        const data = n.data as unknown as GenerateData;
        const url = data.resultUrl!;
        const dur = await probeDur(url);
        clips.push({
          uid: `tl-${n.id}`,
          url,
          ...(data.assetId ? { assetId: data.assetId } : {}),
          dur,
          inSec: 0,
          outSec: dur,
          speed: 1,
          muted: false,
          volumeDb: 0,
          transition: 'cut',
          transitionSec: 0.5,
          filter: 'none',
        });
      }
      const projectHandoff = Boolean(workspaceProjectId);
      const handoffFingerprint = `${studioProjectId ?? 'new'}:${picked
        .map((node) => node.id)
        .join(',')}`;
      let handoffKey = studioHandoffKeysRef.current.get(handoffFingerprint);
      if (!handoffKey) {
        handoffKey = `board-studio-${crypto.randomUUID()}`;
        studioHandoffKeysRef.current.set(handoffFingerprint, handoffKey);
      }
      const response = await fetch(
        projectHandoff
          ? `${apiUrl}/v1/boards/${encodeURIComponent(boardId)}/studio-handoff`
          : `${apiUrl}/v1/studio/project`,
        {
          method: projectHandoff ? 'POST' : 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            projectHandoff
              ? {
                  destination: studioProjectId ? 'studio' : 'new',
                  ...(studioProjectId ? { studioProjectId } : {}),
                  title: `${title.slice(0, 68)} · Монтаж`,
                  clips,
                  idempotencyKey: handoffKey,
                }
              : {
                  timeline: {
                    timeline: clips,
                    texts: [],
                    music: null,
                    voiceover: null,
                    formatId: '9:16',
                  },
                },
          ),
        },
      );
      const saved: unknown = await response.json().catch(() => null);
      if (projectHandoff) {
        if (
          !response.ok ||
          typeof saved !== 'object' ||
          saved === null ||
          !('studioProjectId' in saved) ||
          typeof saved.studioProjectId !== 'string'
        ) {
          throw new Error(`studio_handoff_${response.status}`);
        }
        const handoff = saved as {
          studioProjectId: string;
          created?: boolean;
          replayed?: boolean;
          clipCount?: number;
        };
        studioHandoffKeysRef.current.delete(handoffFingerprint);
        const params = new URLSearchParams({
          projectId: workspaceProjectId!,
          handoff: handoff.replayed ? 'replayed' : handoff.created ? 'created' : 'updated',
          sourceBoardId: boardId,
          clips: String(handoff.clipCount ?? clips.length),
        });
        window.location.href = `/studio/${encodeURIComponent(handoff.studioProjectId)}?${params}`;
        return;
      }
      if (
        !response.ok ||
        typeof saved !== 'object' ||
        saved === null ||
        !('ok' in saved) ||
        saved.ok !== true
      ) {
        throw new Error(`studio_handoff_${response.status}`);
      }
      setStudioKey((k) => k + 1);
      setStudioOpen(true);
    } catch {
      setStudioOpen(false);
      showToast('Не удалось передать монтаж в Studio. Проверьте связь и попробуйте ещё раз.');
    } finally {
      setAssembling(false);
    }
  }

  function requestAssemble(list?: Node[]) {
    const picked = list ?? trayNodes;
    if (picked.length === 0 || assembling) return;
    if (workspaceProjectId) {
      setStudioDestinationNodes([...picked]);
      return;
    }
    void assemble(picked);
  }
  const studioBin = useMemo(
    () =>
      nodes
        .filter(
          (n) =>
            (n.data as unknown as GenerateData)?.resultKind === 'video' &&
            (n.data as unknown as GenerateData)?.resultUrl,
        )
        .map((n) => ({ id: n.id, assetUrl: (n.data as unknown as GenerateData).resultUrl! })),
    [nodes],
  );

  const hasSelection = nodes.some((n) => n.selected);
  const effectiveTool: CanvasTool = spacePan ? 'pan' : tool;
  const zoomSelection = useCallback(() => {
    const sel = nodesRef.current.filter((n) => n.selected);
    if (sel.length) void rf.fitView({ nodes: sel, padding: 0.4, duration: 250 });
  }, [rf]);

  const upload = useCallback((file: File) => uploadMediaFile(apiUrl, file), [apiUrl]);

  const mentionsForPrompt = useCallback(
    (promptId: string): RefMention[] => {
      const downstream = edgesRef.current.find(
        (e) => e.source === promptId && e.targetHandle === 'prompt',
      );
      if (!downstream) return [];
      const target = nodesRef.current.find((n) => n.id === downstream.target);
      if (!target || target.type !== 'generate') return [];

      const incoming = edgesRef.current
        .filter(
          (e) =>
            e.target === target.id &&
            (imageHandleIndex(e.targetHandle) !== null ||
              referenceImageHandleIndex(e.targetHandle) !== null),
        )
        .sort(
          (a, b) =>
            (referenceImageHandleIndex(a.targetHandle) ?? imageHandleIndex(a.targetHandle)!) -
            (referenceImageHandleIndex(b.targetHandle) ?? imageHandleIndex(b.targetHandle)!),
        );
      const sources: MentionSource[] = [];
      for (const e of incoming) {
        const src = nodesRef.current.find((n) => n.id === e.source);
        if (!src) continue;
        if (src.type === 'media') {
          const md = src.data as unknown as MediaData;
          const identified = md.assetId ? assetLifecycle.get(md.assetId) : undefined;
          const sourceUrl = md.assetId
            ? identified?.available
              ? identified.assetUrl
              : ''
            : md.url;
          if (!sourceUrl) continue;
          sources.push(
            md.mediaKind === 'video'
              ? { kind: 'video', url: sourceUrl, label: 'Видео-референс' }
              : { kind: 'image', url: sourceUrl, label: 'Референс' },
          );
        } else if (src.type === 'cast') {
          const cd = src.data as unknown as CastData;
          sources.push({
            kind: 'cast',
            castKind: cd.castKind,
            name: cd.name,
            imageUrls: cd.imageUrls,
            videoUrl: cd.videoUrl,
          });
        } else if (src.type === 'generate') {
          const gd = src.data as unknown as GenerateData;
          if (gd.status === 'done' && gd.resultUrl && gd.resultKind !== 'video') {
            sources.push({ kind: 'image', url: gd.resultUrl, label: 'Результат кадра' });
          }
        }
      }
      return buildRefMentions(sources);
    },
    [assetLifecycle],
  );

  const extractSceneObjects = useCallback(
    async (nid: string): Promise<SceneObjectsResult> => {
      autosave.save();
      const idle = await autosave.waitForIdle({
        timeoutMs: 15_000,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      });
      if (!idle) {
        return {
          objects: [],
          sourceTruncated: false,
          error: 'Не удалось сохранить борд перед разбором.',
        };
      }
      const node = nodesRef.current.find((candidate) => candidate.id === nid);
      if (node?.type !== 'scene') {
        return { objects: [], sourceTruncated: false, error: 'Сцена не найдена.' };
      }
      const data = node.data as unknown as SceneData;
      if (!data.sourceText.trim()) {
        return { objects: [], sourceTruncated: false, error: 'В сцене нет текста для разбора.' };
      }
      const requestTitle = data.title;
      const requestSourceText = data.sourceText;
      try {
        const response = await withAbortDeadline(
          `scene-objects:${nid}`,
          SCENE_OBJECTS_NETWORK_TIMEOUT_MS,
          (signal) =>
            fetch(
              `${apiUrl}/v1/boards/${encodeURIComponent(boardId)}/scenes/${encodeURIComponent(nid)}/objects`,
              {
                method: 'POST',
                credentials: 'include',
                signal,
              },
            ),
        );
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          return {
            objects: [],
            sourceTruncated: false,
            error: sceneObjectsErrorMessage(response.status, body['error']),
          };
        }
        const current = nodesRef.current.find((candidate) => candidate.id === nid);
        const currentData =
          current?.type === 'scene' ? (current.data as unknown as SceneData) : null;
        if (
          !currentData ||
          currentData.title !== requestTitle ||
          currentData.sourceText !== requestSourceText
        ) {
          return {
            objects: [],
            sourceTruncated: false,
            error: 'Сцена изменилась во время разбора — повторите разбор.',
          };
        }
        const projected = projectSceneObjectExtraction(body);
        if (!projected) {
          return {
            objects: [],
            sourceTruncated: false,
            error: 'Сервис вернул некорректный разбор сцены.',
          };
        }
        const merged = mergeSceneObjects({
          existing: currentData.objects,
          extracted: projected.objects,
        });
        if (!merged.ok) {
          return {
            objects: [],
            sourceTruncated: projected.sourceTruncated,
            error: `Нельзя сохранить ${merged.required} объектов: лимит сцены — ${merged.limit}.`,
          };
        }
        const objects = merged.objects;
        // The analysis is already paid for by the platform, but a board that
        // cannot hold the result must say so instead of reporting saved work.
        const sceneUpdate = {
          ...(objects.length ? { objects } : { objects: undefined }),
          objectsSourceHash: projected.objectsSourceHash,
        };
        const document = currentBoardDocument();
        const candidate = validateBoardCommit({
          ...document,
          nodes: document.nodes.map((node) =>
            node.id === nid
              ? { ...node, data: { ...(node.data as object), ...sceneUpdate } }
              : node,
          ),
        });
        if (!candidate.ok) {
          return {
            objects: [],
            sourceTruncated: projected.sourceTruncated,
            error: candidate.reason,
          };
        }
        patch(nid, {
          ...(objects.length ? { objects } : { objects: undefined }),
          objectsSourceHash: projected.objectsSourceHash,
        } as Partial<SceneData>);
        return {
          objects,
          sourceTruncated: projected.sourceTruncated,
          ...(objects.length === 0 ? { error: 'В сцене не найдено пригодных объектов.' } : {}),
        };
      } catch (error) {
        return {
          objects: [],
          sourceTruncated: false,
          error:
            error instanceof DagTaskDeadlineError
              ? 'Разбор сцены занял слишком много времени — попробуйте позже.'
              : 'Разбор сцены не удался — попробуйте позже.',
        };
      }
    },
    [apiUrl, autosave, boardId, patch],
  );

  // AI-промпт: POST the brief + chosen model to the prompt-studio endpoint and
  // store the draft in `text` (the node's output payload). Infers video/image
  // from a wired-downstream shot so the camera-move cue matches the target.
  const draftPrompt = useCallback(
    async (nid: string) => {
      const node = nodesRef.current.find((n) => n.id === nid);
      if (!node) return;
      const d = node.data as unknown as AiPromptData;
      const brief = (d.brief ?? '').trim();
      if (!brief) return;
      // Deliberately NO autosave flush here. Extraction needs one because that
      // route reads the PERSISTED board; this route reads nothing from the board
      // — the context travels in the request body. Gating a paid draft on a save
      // would let a stuck autosave block the purchase for fifteen seconds and
      // then refuse it outright.
      const sceneEdge = edgesRef.current.find(
        (e) => e.target === nid && e.targetHandle === 'scene',
      );
      const sceneNode = sceneEdge && nodesRef.current.find((n) => n.id === sceneEdge.source);
      const sceneContext =
        sceneNode?.type === 'scene' ? buildSceneContext(sceneNode.data as SceneData) : '';
      const downstream = edgesRef.current.find(
        (e) => e.source === nid && e.targetHandle === 'prompt',
      );
      const target = downstream && nodesRef.current.find((n) => n.id === downstream.target);
      const kind =
        target?.type === 'generate'
          ? (target.data as unknown as GenerateData).mode
          : (d.mode ?? 'video');
      const refMentions = mentionsForPrompt(nid).map((m) => ({
        token: m.token,
        kind: m.kind,
        label: m.label,
      }));
      // One node owns one durable paid request until it is known to have
      // succeeded. If the transport drops after the server commits, the next
      // click reuses this key and the API replays the stored draft instead of
      // opening a second charge. Editing the brief/model clears the key.
      const idempotencyKey = aiPromptClaimKey(d.idempotencyKey, randomKey);
      patch(nid, {
        status: 'running',
        view: 'result',
        idempotencyKey,
      } as Partial<AiPromptData>);
      try {
        const res = await fetch(`${apiUrl}/v1/prompt-studio/draft`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            brief,
            kind,
            model: d.model ?? 'claude',
            refMentions,
            sceneContext,
            idempotencyKey,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          // A terminal validation/provider failure closes the server claim and
          // requires a fresh key. A 409 in-progress response is still
          // replay-safe, so retain the key; a later click can recover the
          // completed result. Unknown 409 bodies are kept conservatively too.
          if (!shouldRetainAiPromptClaim({ status: res.status, error: body?.error })) {
            patch(nid, { idempotencyKey: undefined } as Partial<AiPromptData>);
          }
          throw new Error(String(res.status));
        }
        const j = (await res.json()) as { prompt?: string; sceneContext?: string };
        const prompt = (j.prompt ?? '').trim();
        if (!prompt) throw new Error('empty');
        // sceneContext records the context the paid server call actually sent —
        // the SERVER's copy, which may have been trimmed to fit the envelope, not
        // the one computed above. It is never cleared on disconnect or paste, but
        // it IS overwritten on every paid draft, including with nothing: if this
        // call sent no context, a snapshot left over from an earlier draft would
        // claim the model saw something it did not.
        patch(nid, {
          text: prompt,
          status: 'done',
          view: 'result',
          idempotencyKey: undefined,
          sceneContext: j.sceneContext ? j.sceneContext : undefined,
        } as Partial<AiPromptData>);
      } catch {
        patch(nid, { status: 'failed', view: 'brief' } as Partial<AiPromptData>);
      }
    },
    [apiUrl, patch, mentionsForPrompt],
  );

  // Consistency bridge (previz S4): spawn a Seedream keyframe node that takes
  // over the shot's reference wiring and feeds the shot as its first frame —
  // identity from the still, motion from the video model.
  const makeKeyframe = useCallback(
    (shotId: string) => {
      const nodesById = new Map(nodesRef.current.map((node) => [node.id, node]));
      const incomingEdges = edgesRef.current.filter((edge) => edge.target === shotId);
      const shot = nodesById.get(shotId);
      if (!shot || shot.type !== 'generate') return;
      const kfId = uid();
      const plan = planKeyframeBridge(
        shotId,
        kfId,
        edgesRef.current.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
        })),
      );
      if (!plan) {
        showToast('У кадра нет референсов — подключите объект: человека, место или товар.');
        return;
      }
      const d = shot.data as unknown as GenerateData;
      if (d.mode !== 'video') {
        showToast('Ключевой кадр можно вставить только перед видеокадром.');
        return;
      }
      const plannedKeyframeInputs = plan.addEdges.filter((edge) => edge.target === kfId);
      const keyframeInputs = plannedKeyframeInputs.flatMap((edge) => {
        const source = nodesById.get(edge.source);
        return source?.type && source.type in BOARD_NODE_REGISTRY
          ? [
              {
                source: {
                  type: source.type as BoardNodeType,
                  data: source.data,
                } as Pick<BoardNode, 'type' | 'data'>,
                sourceHandle: edge.sourceHandle,
                targetHandle: edge.targetHandle,
              },
            ]
          : [];
      });
      if (keyframeInputs.length !== plannedKeyframeInputs.length) {
        showToast('Один из источников ключевого кадра больше не существует.');
        return;
      }
      // The bridge silently CREATES a node, so it may only pick in-plan models.
      const imageCandidates = [
        ...(imageModel && !modelLocked(imageModel) ? [imageModel] : []),
        ...unlockedModelsForMode(models, 'image', planTier).filter(
          (candidate) => candidate.id !== imageModel?.id,
        ),
      ];
      const keyframeModel = imageCandidates.find(
        (candidate) =>
          validateBoardConnections({
            target: {
              type: 'generate',
              data: boardNodeDefaultData('generate', {
                mode: 'image',
                modelId: candidate.id,
              }),
            } as Pick<BoardNode, 'type' | 'data'>,
            targetModel: candidate,
            connections: keyframeInputs,
          }).ok,
      );
      if (!keyframeModel) {
        showToast('Ни одна доступная модель изображения не принимает этот набор референсов.');
        return;
      }
      const keyframeData = boardNodeDefaultData('generate', {
        mode: 'image',
        modelId: keyframeModel.id,
        prompt: resolveGeneratePrompt(
          shot,
          nodesById,
          incomingEdges.map((edge) => ({
            source: edge.source,
            targetHandle: edge.targetHandle ?? null,
          })),
        ),
      });
      const shotModel = modelForNode(d);
      if (!shotModel) {
        showToast('Для видеокадра не выбрана доступная модель.');
        return;
      }
      const remainingShotInputs = incomingEdges
        .filter((edge) => !plan.removeEdgeIds.includes(edge.id))
        .flatMap((edge) => {
          const source = nodesById.get(edge.source);
          return source?.type && source.type in BOARD_NODE_REGISTRY
            ? [
                {
                  source: {
                    type: source.type as BoardNodeType,
                    data: source.data,
                  } as Pick<BoardNode, 'type' | 'data'>,
                  sourceHandle: edge.sourceHandle,
                  targetHandle: edge.targetHandle,
                },
              ]
            : [];
        });
      const shotValidation = validateBoardConnections({
        target: { type: 'generate', data: shot.data } as Pick<BoardNode, 'type' | 'data'>,
        targetModel: shotModel,
        connections: [
          ...remainingShotInputs,
          {
            source: { type: 'generate', data: keyframeData } as Pick<BoardNode, 'type' | 'data'>,
            sourceHandle: 'out',
            targetHandle: 'images[0]',
          },
        ],
      });
      if (!shotValidation.ok) {
        showToast(`Ключевой кадр несовместим: ${shotValidation.reason}`);
        return;
      }
      takeSnapshot();
      const kfNode: Node = {
        id: kfId,
        type: 'generate',
        position: findFreePosition(
          { x: shot.position.x - 40, y: shot.position.y - 240 },
          nodesRef.current.map((n) => n.position),
        ),
        data: keyframeData,
      };
      setNodes((nds) => [...nds, kfNode]);
      setEdges((eds) => [
        ...eds.filter((e) => !plan.removeEdgeIds.includes(e.id)),
        ...plan.addEdges.map((e) => ({ id: uid(), ...e, type: 'typed', animated: true })),
      ]);
    },
    [
      imageModel,
      modelForNode,
      modelLocked,
      models,
      planTier,
      setNodes,
      setEdges,
      takeSnapshot,
      showToast,
    ],
  );

  const actions: GraphActions = useMemo(
    () => ({
      apiUrl,
      models,
      planTier,
      lockedCtaHref,
      modelForNode,
      requestModelChange,
      diagnosticForNode,
      edgeIssuesFor,
      edgeRoleFor,
      repairNodeSettings,
      swapFrameInputs,
      patch,
      selectResult,
      remove,
      requestFrameDelete,
      removeEdge,
      run,
      running: isRunning,
      toTray,
      upload,
      makeKeyframe,
      draftPrompt,
      extractSceneObjects,
      mentionsForPrompt,
      createShotFromScene,
      promoteSceneObject,
      unlinkSceneObject,
      removeSceneObject,
      focusBoardNode,
      sceneSourceHref,
      sceneShotCount,
      addCastStill,
      removeCastStill,
      generateCastReference,
      appendCastReference,
      assetLifecycleFor: (assetId) => (assetId ? assetLifecycle.get(assetId) : undefined),
      resolveQuoteAssetUrl,
      publishNodeQuote,
      quoteRefreshFor,
    }),
    [
      apiUrl,
      models,
      planTier,
      lockedCtaHref,
      modelForNode,
      requestModelChange,
      diagnosticForNode,
      edgeIssuesFor,
      edgeRoleFor,
      repairNodeSettings,
      swapFrameInputs,
      patch,
      selectResult,
      remove,
      requestFrameDelete,
      removeEdge,
      run,
      isRunning,
      toTray,
      upload,
      makeKeyframe,
      draftPrompt,
      extractSceneObjects,
      mentionsForPrompt,
      createShotFromScene,
      promoteSceneObject,
      unlinkSceneObject,
      removeSceneObject,
      focusBoardNode,
      sceneSourceHref,
      sceneShotCount,
      addCastStill,
      removeCastStill,
      generateCastReference,
      appendCastReference,
      assetLifecycle,
      resolveQuoteAssetUrl,
      publishNodeQuote,
      quoteRefreshFor,
    ],
  );
  const modelChangeEdgeCount = modelChange
    ? new Set(modelChange.impact.edgeIssues.map((issue) => issue.edgeId)).size
    : 0;
  const firstInvalidNode = graphDiagnostic.nodes.find((diagnostic) => !diagnostic.executable);
  const graphInvalidReason = firstInvalidNode
    ? (firstInvalidNode.settingIssues[0]?.reason ??
      firstInvalidNode.edgeIssues[0]?.reason ??
      firstInvalidNode.generalIssues[0]?.reason)
    : undefined;
  const flowNodes = useMemo(
    // The overview canvas deliberately replaces React Flow's node/edge renderers
    // for large fitted boards. Passing empty arrays unmounts their DOM entirely.
    () => (overviewMode ? [] : nodes),
    [nodes, overviewMode],
  );
  const flowEdges = useMemo(() => (overviewMode ? [] : edges), [edges, overviewMode]);
  // A wired prompt node beats the inline `data.prompt`, so the overview labels and
  // the Run All estimate must resolve it rather than read `data.prompt` raw. Built
  // only while one of those two surfaces is open: it is O(N+E), `nodes` changes on
  // every drag frame, and a board holds up to BOARD_LIMITS.nodes shots.
  const promptIndexNeeded = overviewMode || Boolean(runAllPlan);
  const { nodesById, resolvedPrompts } = useMemo(() => {
    const nodesById = new Map<string, Node>();
    const resolvedPrompts = new Map<string, string>();
    if (!promptIndexNeeded) return { nodesById, resolvedPrompts };
    for (const node of documentNodes) nodesById.set(node.id, node);
    const incomingEdgesByTarget = new Map<
      string,
      { source: string; targetHandle: string | null }[]
    >();
    for (const edge of documentEdges) {
      const incoming = { source: edge.source, targetHandle: edge.targetHandle ?? null };
      const existing = incomingEdgesByTarget.get(edge.target);
      if (existing) existing.push(incoming);
      else incomingEdgesByTarget.set(edge.target, [incoming]);
    }
    for (const node of documentNodes) {
      if (node.type !== 'generate') continue;
      resolvedPrompts.set(
        node.id,
        resolveGeneratePrompt(node, nodesById, incomingEdgesByTarget.get(node.id) ?? []),
      );
    }
    return { nodesById, resolvedPrompts };
  }, [documentNodes, documentEdges, promptIndexNeeded]);
  const runAllRerunCount =
    runAllPlan?.items.reduce((count, item) => {
      const data = nodesById.get(item.id)?.data as unknown as GenerateData | undefined;
      return count + ((data?.takes?.length ?? 0) > 0 || Boolean(data?.resultUrl) ? 1 : 0);
    }, 0) ?? 0;
  return (
    <BoardGraphContext.Provider value={actions}>
      <div
        data-testid="board-canvas"
        data-node-count={nodes.length}
        data-edge-count={edges.length}
        className="relative min-h-0 flex-1 w-full bg-[color:var(--color-bg)]"
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onNodeDragStart={onDragStart}
          onSelectionDragStart={onDragStart}
          isValidConnection={isValid}
          connectionMode={ConnectionMode.Loose}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onlyRenderVisibleElements
          defaultEdgeOptions={{ type: 'typed', animated: true }}
          defaultViewport={st.viewport ?? { x: 80, y: 60, zoom: 1 }}
          {...(!st.viewport && (st.nodes?.length ?? 0) > 0
            ? { fitView: true, fitViewOptions: { padding: 0.25, maxZoom: 1 } }
            : {})}
          minZoom={0.25}
          maxZoom={2}
          panOnDrag={effectiveTool === 'pan' ? [0, 1] : [1]}
          selectionOnDrag={effectiveTool === 'select'}
          selectionMode={SelectionMode.Partial}
          onMove={onViewportMove}
          onMoveEnd={onMoveEnd}
          onPaneClick={() => setAddOpen(false)}
          proOptions={{ hideAttribution: true }}
          selectionKeyCode={null}
          multiSelectionKeyCode={['Meta', 'Control']}
          deleteKeyCode={null}
          className={`seed-graph seed-graph--${effectiveTool}`}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={2}
            color="rgba(var(--paper-rgb),0.22)"
          />
          {minimap && (
            <MiniMap
              position="bottom-right"
              style={{
                marginBottom: 64,
                border: '2.5px solid var(--color-line)',
                borderRadius: 'var(--radius-md)',
              }}
              bgColor="var(--color-surface2)"
              maskColor="var(--color-overlay)"
              nodeColor={(n) =>
                n.type === 'generate' ? 'var(--color-accent)' : 'rgba(var(--paper-rgb),0.32)'
              }
              nodeStrokeColor="var(--color-line)"
              nodeStrokeWidth={2}
              pannable
              zoomable
            />
          )}
        </ReactFlow>

        <BoardOverviewCanvas
          visible={overviewMode}
          nodes={nodes}
          edges={edges}
          resolvedPrompts={resolvedPrompts}
        />

        {nodes.length === 0 && (
          <div
            data-testid="board-empty-guide"
            className="pointer-events-none absolute inset-0 z-20 grid place-items-center px-6 pb-36 pt-24 text-center"
          >
            <div className="max-w-[430px]">
              <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-[var(--radius-md)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-[color:var(--color-accent)] shadow-[3px_3px_0_0_var(--color-shadow)]">
                <ImageIcon size={21} aria-hidden />
              </span>
              <h2 className="font-display text-[22px] font-black tracking-tight text-[color:var(--color-fg)]">
                Создайте первый кадр
              </h2>
              <p className="mx-auto mt-2 max-w-[390px] text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                Начни с изображения. Затем протяни связи к промпту и референсам — борд покажет,
                какие входы подходят выбранной модели.
              </p>
              <div className="pointer-events-auto mt-5 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  data-testid="empty-add-image"
                  onClick={() => addNode('generate', { mode: 'image' })}
                  className="press inline-flex items-center gap-2 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2.5 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)]"
                >
                  <Plus size={16} aria-hidden /> Первое изображение
                </button>
                <button
                  type="button"
                  data-testid="empty-open-catalog"
                  onClick={() => setAddOpen(true)}
                  className="press-inset rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 py-2.5 text-[13px] font-semibold text-[color:var(--color-fg)]"
                >
                  Все типы узлов
                </button>
              </div>
            </div>
          </div>
        )}

        {portRejection && (
          <div
            data-testid="port-rejection"
            role="status"
            className="pointer-events-none fixed z-[70] max-w-[280px] rounded-[var(--radius-sm)] border-2 border-[color:var(--color-destructive)] bg-[color:var(--color-surface)] px-2.5 py-1.5 text-[11px] leading-snug text-[color:var(--color-destructive)] shadow-[3px_3px_0_0_var(--color-shadow)]"
            style={{
              left: Math.max(8, Math.min(portRejection.x + 10, window.innerWidth - 292)),
              top: Math.max(8, Math.min(portRejection.y + 10, window.innerHeight - 90)),
            }}
          >
            {portRejection.reason}
          </div>
        )}

        <CanvasRail
          canUndo={historyRef.current.canUndo}
          canRedo={historyRef.current.canRedo}
          onUndo={undo}
          onRedo={redo}
          tool={effectiveTool}
          onTool={setTool}
          minimap={minimap}
          onMinimap={() => setMinimap((v) => !v)}
          hasSelection={hasSelection}
          onZoomSelection={zoomSelection}
          onViewportIntent={() => {
            viewportIntentRef.current = true;
          }}
          onFit={fitBoard}
          onHelp={() => setShortcutsOpen(true)}
        />

        {subsetRequest && (
          <SceneObjectSubsetSheet
            reason={subsetRequest.reason}
            items={subsetRequest.items}
            limits={subsetRequest.limits}
            onCancel={() => {
              sceneShotLockRef.current.delete(subsetRequest.sceneNodeId);
              setSubsetRequest(null);
            }}
            onConfirm={(selectedIds) => {
              const sceneNodeId = subsetRequest.sceneNodeId;
              // Re-planned against the live board: an upload can finish while the
              // sheet is open. A still-overflowing plan refreshes the sheet with
              // live numbers instead of closing it and dropping the selection.
              const plan = planSceneShot(sceneNodeId, selectedIds);
              if (!plan) {
                setSubsetRequest(null);
                return;
              }
              if (!plan.ok && plan.overflow && plan.limits) {
                setSubsetRequest({
                  sceneNodeId,
                  reason: plan.reason,
                  items: plan.overflow,
                  limits: plan.limits,
                });
                return;
              }
              setSubsetRequest(null);
              commitSceneShot(sceneNodeId, plan);
            }}
          />
        )}

        {promotionRequest && (
          <SceneObjectPromotionDialog
            request={promotionRequest.request}
            onCancel={() => setPromotionRequest(null)}
            onConfirm={(castNodeId) => {
              const { sceneNodeId, objectIndex, objectKey } = promotionRequest;
              setPromotionRequest(null);
              applyScenePromotion(sceneNodeId, objectIndex, castNodeId, objectKey);
            }}
          />
        )}

        {detachRequest && (
          <CastPackDetachDialog
            shotCount={detachRequest.shotCount}
            onCancel={() => setDetachRequest(null)}
            onConfirm={() => {
              const { castId, index } = detachRequest;
              setDetachRequest(null);
              commitCastPackPlan(
                castId,
                planCastStillRemove({
                  nodes: nodesRef.current as never,
                  edges: edgesRef.current as never,
                  castId,
                  index,
                }),
                `cast:still-detach:${index}`,
                'Референс удалён, объект отсоединён от кадров.',
              );
            }}
          />
        )}

        {frameDeleteRequest && (
          <div className="fixed inset-0 z-[85] grid place-items-center p-4">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setFrameDeleteRequest(null)}
            />
            <div
              data-testid="frame-delete-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="frame-delete-title"
              className="glass-menu relative w-full max-w-[440px] p-5"
            >
              <h3
                id="frame-delete-title"
                className="font-display text-[19px] text-[color:var(--color-fg)]"
              >
                Удалить рамку?
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                В рамке находится {frameDeleteRequest.childCount} узлов. Выберите, что сделать с их
                содержимым.
              </p>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  data-testid="frame-delete-cancel"
                  onClick={() => setFrameDeleteRequest(null)}
                  className="press-inset rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] px-3 py-1.5 text-[13px] font-semibold"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  data-testid="frame-detach-children"
                  onClick={() => applyFrameDelete(false)}
                  className="press-inset rounded-[var(--radius-sm)] border-2 border-[color:var(--color-accent)] px-3 py-1.5 text-[13px] font-semibold text-[color:var(--color-accent)]"
                >
                  Удалить рамку, оставить содержимое
                </button>
                <button
                  type="button"
                  data-testid="frame-delete-children"
                  onClick={() => applyFrameDelete(true)}
                  className="press rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-destructive)] px-3 py-1.5 text-[13px] font-semibold text-[color:var(--color-destructive-foreground)]"
                >
                  Удалить вместе с содержимым
                </button>
              </div>
            </div>
          </div>
        )}

        {saveConflict && (
          <div className="fixed inset-0 z-[90] grid place-items-center p-4">
            <div className="absolute inset-0 bg-black/65" />
            <div
              data-testid="board-conflict-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="board-conflict-title"
              className="glass-menu relative w-full max-w-[560px] p-5"
            >
              <div className="flex items-start gap-3">
                <StickyNote
                  size={18}
                  className="mt-0.5 shrink-0 text-[color:var(--color-accent)]"
                />
                <div>
                  <h3
                    id="board-conflict-title"
                    className="font-display text-[19px] text-[color:var(--color-fg)]"
                  >
                    Локальная версия не потеряна
                  </h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                    {saveConflict.source === 'conflict'
                      ? 'Этот борд изменила другая вкладка. Автосохранение остановлено, а ваша версия сохранена в этом браузере.'
                      : 'После прошлого сеанса найдена версия, которая не была подтверждена сервером. Выберите, что с ней сделать.'}
                  </p>
                </div>
              </div>

              <div className="mt-4 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 py-2.5 text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                Серверная ревизия: <span className="font-mono">{saveConflict.serverRev}</span> ·
                локальная копия:{' '}
                <span className="font-mono">
                  {new Date(saveConflict.snapshot.savedAt).toLocaleString('ru-RU')}
                </span>
              </div>

              {recoveryError && (
                <p
                  data-testid="board-conflict-error"
                  className="mt-3 rounded-[var(--radius-sm)] bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
                >
                  {recoveryError}
                </p>
              )}

              <div className="mt-5 grid gap-2 sm:grid-cols-3">
                <button
                  type="button"
                  data-testid="board-conflict-reload"
                  disabled={recoveryAction !== null}
                  onClick={reloadServerBoard}
                  className="press-inset rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] px-3 py-2 text-[13px] font-semibold text-[color:var(--color-muted-foreground)] disabled:opacity-50"
                >
                  Загрузить серверную
                </button>
                <button
                  type="button"
                  data-testid="board-conflict-duplicate"
                  disabled={recoveryAction !== null}
                  onClick={() => void duplicateRecoveredBoard()}
                  className="press-inset inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-accent)] px-3 py-2 text-[13px] font-semibold text-[color:var(--color-accent)] disabled:opacity-50"
                >
                  {recoveryAction === 'duplicate' && <Loader2 size={12} className="seed-spin" />}
                  Создать копию
                </button>
                <button
                  type="button"
                  data-testid="board-conflict-overwrite"
                  disabled={recoveryAction !== null}
                  onClick={() => void overwriteServerBoard()}
                  className="press inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-destructive)] px-3 py-2 text-[13px] font-semibold text-[color:var(--color-destructive-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-50"
                >
                  {recoveryAction === 'overwrite' && <Loader2 size={12} className="seed-spin" />}
                  Перезаписать
                </button>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[color:var(--color-faint)]">
                «Загрузить серверную» удалит локальную копию. «Создать копию» сохранит обе версии.
                «Перезаписать» заменит серверный борд только после повторной проверки ревизии.
              </p>
            </div>
          </div>
        )}

        {/* keyboard shortcuts sheet */}
        {shortcutsOpen && (
          <div className="fixed inset-0 z-50 grid place-items-center p-4">
            <div className="absolute inset-0 bg-black/55" onClick={() => setShortcutsOpen(false)} />
            <div
              data-testid="shortcuts-sheet"
              className="glass-menu relative w-full max-w-[420px] p-5"
            >
              <div className="mb-3 flex items-center gap-2">
                <Keyboard size={15} className="text-[color:var(--color-accent)]" />
                <h3 className="font-display text-[18px] text-[color:var(--color-fg)]">
                  Горячие клавиши
                </h3>
                <span className="flex-1" />
                <button
                  onClick={() => setShortcutsOpen(false)}
                  className="text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="space-y-1.5">
                {(
                  [
                    ['Отменить / Вернуть', 'Ctrl+Z / Ctrl+Shift+Z'],
                    ['Дублировать выделение', 'Ctrl+D'],
                    ['Копировать / вставить карточки', 'Ctrl+C / Ctrl+V'],
                    ['Вырезать выделенное', 'Ctrl+X'],
                    ['Выделить всё', 'Ctrl+A'],
                    ['Удалить выделенное', 'Delete / Backspace'],
                    ['Снять выделение / закрыть', 'Esc'],
                    ['Временно рука (панорама)', 'Пробел + тяга'],
                    ['Масштаб', 'Колесо / кнопки рейки'],
                    ['Эта подсказка', '?'],
                  ] as const
                ).map(([label, keys]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between rounded-[var(--radius-sm)] px-2 py-1.5 odd:bg-[color:var(--color-surface2)]"
                  >
                    <span className="text-[13px] text-[color:var(--color-muted-foreground)]">
                      {label}
                    </span>
                    <kbd className="rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)]">
                      {keys}
                    </kbd>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[color:var(--color-faint)]">
                Любое удаление можно отменить (Ctrl+Z) — даже «Выделить всё» и Delete.
              </p>
            </div>
          </div>
        )}

        {modelChange && (
          <div className="fixed inset-0 z-[80] grid place-items-center p-4">
            <div className="absolute inset-0 bg-black/60" onClick={() => setModelChange(null)} />
            <div
              data-testid="model-change-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="model-change-title"
              className="glass-menu relative w-full max-w-[520px] p-5"
            >
              <div className="flex items-start gap-2">
                <Cpu size={16} className="mt-1 shrink-0 text-[color:var(--color-accent)]" />
                <div className="min-w-0 flex-1">
                  <h3
                    id="model-change-title"
                    className="font-display text-[18px] text-[color:var(--color-fg)]"
                  >
                    Смена модели затронет граф
                  </h3>
                  <p className="mt-0.5 text-[13px] text-[color:var(--color-muted-foreground)]">
                    {modelChange.current
                      ? modelDisplayName(modelChange.current)
                      : 'Недоступная текущая модель'}{' '}
                    → {modelDisplayName(modelChange.next)}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Закрыть"
                  onClick={() => setModelChange(null)}
                  className="text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]"
                >
                  <X size={15} />
                </button>
              </div>

              <div className="mt-4 max-h-[300px] space-y-3 overflow-y-auto pr-1">
                {modelChange.impact.edgeIssues.length > 0 && (
                  <section>
                    <p className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-destructive)]">
                      Несовместимые входы · {modelChangeEdgeCount}
                    </p>
                    <ul className="mt-1.5 space-y-1.5">
                      {modelChange.impact.edgeIssues.map((issue) => (
                        <li
                          key={`${issue.edgeId}:${issue.reason}`}
                          className="rounded-[var(--radius-xs)] border border-[rgba(var(--destructive-rgb),0.5)] bg-destructive/10 px-2.5 py-1.5 text-[11px] leading-snug text-[color:var(--color-destructive)]"
                        >
                          {issue.reason}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {modelChange.impact.settingIssues.length > 0 && (
                  <section>
                    <p className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-muted-foreground)]">
                      Настройки · {modelChange.impact.settingIssues.length}
                    </p>
                    <ul className="mt-1.5 space-y-1.5">
                      {modelChange.impact.settingIssues.map((issue) => (
                        <li
                          key={issue.field}
                          className="rounded-[var(--radius-xs)] bg-[color:var(--color-surface2)] px-2.5 py-1.5 text-[11px] leading-snug text-[color:var(--color-muted-foreground)]"
                        >
                          {issue.reason}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>

              <p className="mt-4 text-[11px] leading-relaxed text-[color:var(--color-faint)]">
                Vertov ничего не удалит и не изменит без подтверждения. Операцию можно отменить
                через Ctrl+Z.
              </p>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  data-testid="model-change-cancel"
                  onClick={() => setModelChange(null)}
                  className="press-inset rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] px-3 py-1.5 text-[13px] font-semibold text-[color:var(--color-muted-foreground)]"
                >
                  Отмена
                </button>
                {modelChange.suggestion && (
                  <button
                    type="button"
                    data-testid="model-change-suggestion"
                    onClick={applySuggestedModel}
                    className="press-inset rounded-[var(--radius-sm)] border-2 border-[color:var(--color-accent)] px-3 py-1.5 text-[13px] font-semibold text-[color:var(--color-accent)]"
                  >
                    {modelChange.current?.id === modelChange.suggestion.id
                      ? `Оставить ${modelChange.suggestion.family}`
                      : `Выбрать ${modelDisplayName(modelChange.suggestion)}`}
                  </button>
                )}
                <button
                  type="button"
                  data-testid="model-change-apply"
                  onClick={applyModelChange}
                  className="press rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-destructive)] px-3 py-1.5 text-[13px] font-semibold text-[color:var(--color-destructive-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)]"
                >
                  {modelChangeEdgeCount > 0
                    ? `Удалить связи (${modelChangeEdgeCount}) и сменить`
                    : 'Исправить настройки и сменить'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* toast */}
        {toast && (
          <div
            data-testid="board-toast"
            className="pointer-events-none absolute left-1/2 top-4 z-40 -translate-x-1/2"
          >
            <div className="glass-menu flex items-center gap-2 px-4 py-2 text-[13px] font-medium text-[color:var(--color-fg)]">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" /> {toast}
            </div>
          </div>
        )}

        {/* minimal canvas header — back · project name · save status */}
        <div className="pointer-events-none absolute left-4 top-3 z-30 flex items-center gap-2">
          <div className="glass pointer-events-auto flex items-center gap-1 py-1.5 pl-1.5 pr-3">
            {/* Guests have no project list — back exits to the landing instead
                (guest-CJM decision, 2026-07-09). */}
            <a
              href={
                isAnonymous
                  ? '/'
                  : workspaceProjectId
                    ? `/boards?projectId=${encodeURIComponent(workspaceProjectId)}`
                    : '/boards'
              }
              title={isAnonymous ? 'На главную' : 'К проектам'}
              aria-label={isAnonymous ? 'На главную' : 'К проектам'}
              className="press-inset grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
            >
              <ChevronLeft size={17} />
            </a>
            <input
              value={title}
              data-testid="board-title"
              aria-label="Название борда"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={(e) => saveTitle(e.target.value.trim())}
              className="h-8 w-[clamp(10rem,32vw,28rem)] bg-transparent px-1 text-[13px] font-semibold text-[color:var(--color-fg)] outline-none"
            />
            <span className="w-[92px] shrink-0">
              <SaveIndicator
                state={save.state}
                {...(!saveConflict ? { onRetry: () => autosave.save() } : {})}
              />
            </span>
          </div>
          {/* Temp operator gateway widget (dev only) — decides per-shot
              routing: Авто (video-ref→AtlasCloud, else→OpenRouter) or force. */}
          {devTools && (
            <div
              data-testid="gateway-widget"
              title="DEV · Шлюз генерации: Авто = видео-референс → AtlasCloud, остальное → OpenRouter (дешевле)"
              className="glass pointer-events-auto hidden items-center gap-0.5 p-1 sm:flex"
            >
              <span className="px-2 font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-faint)]">
                Шлюз
              </span>
              {GATEWAY_POLICIES.map((p) => {
                const on = gatewayPolicy === p;
                const label =
                  p === 'auto' ? 'Авто' : p === 'openrouter' ? 'OpenRouter' : 'AtlasCloud';
                return (
                  <button
                    key={p}
                    type="button"
                    data-testid={`gateway-${p}`}
                    aria-pressed={on}
                    onClick={() => changeGatewayPolicy(p)}
                    className={
                      'rounded-[var(--radius-xs)] px-2.5 py-1 text-[11px] font-semibold transition-colors ' +
                      (on
                        ? 'border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                        : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* B-3: linear shot-list review — derived live from the graph, so it
            stays in sync without panning the canvas. */}
        {shotListOpen && (
          <div
            data-testid="shot-list-panel"
            className="glass-menu seed-scroll pointer-events-auto absolute bottom-3 right-3 top-3 z-40 w-[min(360px,calc(100vw-1.5rem))] overflow-y-auto rounded-[var(--radius-md)] p-3"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="label-eyebrow">Шот-лист ({shotList.length})</span>
              <div className="flex items-center gap-1.5">
                {shotList.length > 0 && (
                  <button
                    type="button"
                    data-testid="shotlist-export"
                    onClick={exportStoryboard}
                    title="Экспорт раскадровки (HTML — открыть и распечатать в PDF)"
                    className="press-inset inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border-[1.5px] border-[color:var(--color-line)] px-2.5 text-[11px] font-semibold text-[color:var(--color-muted-foreground)] hover:bg-white/[0.06] hover:text-[color:var(--color-fg)]"
                  >
                    <Film size={12} aria-hidden /> Раскадровка
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShotListOpen(false)}
                  aria-label="Закрыть шот-лист"
                  className="grid h-7 w-7 place-items-center rounded-full text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            {shotList.length === 0 ? (
              <p className="text-[13px] text-[color:var(--color-faint)]">
                Добавь кадры на борд — они появятся здесь списком.
              </p>
            ) : (
              <ol className="space-y-2">
                {shotList.map((s) => (
                  <li
                    key={s.id}
                    data-testid="shot-row"
                    className="rounded-[var(--radius-sm)] border-[1.5px] border-[color:var(--color-line)] p-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-[color:var(--color-fg)]">
                        #{s.shotNumber}
                      </span>
                      <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
                        {s.status === 'done'
                          ? 'Готово'
                          : s.status === 'running'
                            ? 'Генерация…'
                            : s.status === 'failed'
                              ? 'Ошибка'
                              : '—'}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[13px] text-[color:var(--color-fg)]">
                      {s.title}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                      <span>{s.mode === 'video' ? 'Видео' : 'Кадр'}</span>
                      {s.cast.length > 0 && <span>· {s.cast.join(', ')}</span>}
                      {s.locations.length > 0 && <span>· {s.locations.join(', ')}</span>}
                      {s.grammarLabel && (
                        <span data-testid="shot-grammar-label">· {s.grammarLabel}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {/* bottom toolbar — icon-only, the name appears on hover (Higgsfield);
            sits above the montage tray, level with the zoom rail. */}
        <div className="pointer-events-none absolute bottom-[84px] left-[58%] z-30 -translate-x-1/2 max-[1099px]:bottom-[84px] max-[1099px]:left-1/2">
          <div className="glass pointer-events-auto flex items-center gap-1 p-1.5">
            {(
              [
                {
                  id: 'board-add',
                  icon: <Plus size={20} />,
                  label: 'Добавить узел',
                  onClick: () => setAddOpen((v) => !v),
                },
                {
                  id: 'board-shotlist',
                  icon: <ListChecks size={19} />,
                  label: 'Шот-лист',
                  onClick: () => setShotListOpen((v) => !v),
                },
                {
                  id: 'board-history',
                  icon: <Clock3 size={19} />,
                  label: 'История версий',
                  onClick: () => setHistoryOpen((v) => !v),
                },
                {
                  id: 'board-cast',
                  icon: <UserRound size={19} />,
                  label: 'Состав',
                  onClick: () => setCastOpen((v) => !v),
                },
                {
                  id: 'board-export',
                  icon: <Film size={19} />,
                  label: 'Экспорт',
                  onClick: () => setExportOpen((v) => !v),
                },
              ] as const
            ).map((b) => (
              <button
                key={b.id}
                data-testid={b.id}
                onClick={b.onClick}
                aria-label={b.label}
                className={
                  'seed-toolbar-action group press-inset relative grid h-10 w-10 place-items-center rounded-[var(--radius-md)] ' +
                  ('accent' in b && b.accent
                    ? 'text-[color:var(--color-accent)] hover:bg-[color:var(--color-surface2)]'
                    : 'text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]')
                }
              >
                {b.icon}
                <span className="seed-toolbar-tooltip pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-fg)] opacity-0 shadow-[3px_3px_0_0_var(--color-shadow)] transition-opacity duration-100 group-focus-visible:opacity-100 group-hover:opacity-100">
                  {b.label}
                </span>
              </button>
            ))}
            <span className="mx-0.5 h-5 w-[2px] shrink-0 bg-[color:var(--color-line)]" />
            <button
              data-testid="board-run-all"
              aria-label={
                reconcilingJobs
                  ? 'Восстановление задач'
                  : runningAll
                    ? 'Остановить запуск'
                    : 'Снять всё'
              }
              disabled={
                reconcilingJobs ||
                runAllStopping ||
                (!runningAll &&
                  (!nodes.some((n) => n.type === 'generate') || !graphDiagnostic.executable))
              }
              title={
                reconcilingJobs
                  ? 'Проверяем задачи, сохранённые до reload'
                  : runningAll
                    ? runAllStopping
                      ? 'Ожидаем уже отправленные задачи'
                      : 'Не запускать новые кадры'
                    : (graphInvalidReason ?? 'Снять все готовые кадры')
              }
              onClick={runningAll ? stopRunAll : openRunAll}
              className="seed-toolbar-action group press-inset relative grid h-10 w-10 place-items-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)] disabled:pointer-events-none disabled:opacity-40"
            >
              {reconcilingJobs || runAllStopping ? (
                <Loader2 size={19} className="seed-spin" />
              ) : runningAll ? (
                <X size={19} />
              ) : (
                <Play size={19} />
              )}
              <span className="seed-toolbar-tooltip pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-fg)] opacity-0 shadow-[3px_3px_0_0_var(--color-shadow)] transition-opacity duration-100 group-focus-visible:opacity-100 group-hover:opacity-100">
                {reconcilingJobs
                  ? 'Восстанавливаю задачи…'
                  : runningAll
                    ? runAllStopping
                      ? 'Останавливаю…'
                      : 'Остановить запуск'
                    : graphInvalidReason
                      ? 'Исправьте отмеченный кадр'
                      : 'Снять всё'}
              </span>
            </button>
          </div>
        </div>

        <BoardHistoryPanel
          open={historyOpen}
          apiUrl={apiUrl}
          boardId={boardId}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => window.location.reload()}
          onFeedback={showToast}
        />

        {/* add-node menu: search + categories + keep-open (Runway pattern) */}
        {addOpen && (
          <AddNodeMenu
            keepOpen={addKeep}
            onKeepOpenChange={setAddKeep}
            onChoose={chooseCatalogItem}
            onClose={() => setAddOpen(false)}
          />
        )}

        {scenarioPickerOpen && (
          <ScenarioSourcePicker
            apiUrl={apiUrl}
            boardId={boardId}
            workspaceProjectId={workspaceProjectId}
            onClose={() => setScenarioPickerOpen(false)}
            beforeApply={saveBeforeScenarioImport}
            onApplied={applyScenarioBoardState}
          />
        )}

        {projectMediaPickerOpen && workspaceProjectId && (
          <ProjectMediaPicker
            apiUrl={apiUrl}
            projectId={workspaceProjectId}
            onClose={() => setProjectMediaPickerOpen(false)}
            onChoose={(media) => {
              addNode('media', {
                url: media.assetUrl,
                mediaKind: media.kind,
                assetId: media.id,
              });
              setProjectMediaPickerOpen(false);
              showToast('Материал проекта добавлен на борд.');
            }}
          />
        )}

        {studioDestinationNodes && workspaceProjectId && (
          <StudioDestinationDialog
            apiUrl={apiUrl}
            projectId={workspaceProjectId}
            clipCount={studioDestinationNodes.length}
            busy={assembling}
            onClose={() => setStudioDestinationNodes(false)}
            onChoose={(studioProjectId) =>
              void assemble(studioDestinationNodes, studioProjectId ?? undefined)
            }
          />
        )}

        {/* connect menu: dropped a wire on empty canvas → offer the node that
            legally belongs on the other end (Runway's drag-to-create). */}
        {dropMenu && (
          <>
            {/* dismiss on a fresh press (not the drag's trailing click, which
                would close the menu the instant it opens). */}
            <div className="fixed inset-0 z-40" onMouseDown={() => setDropMenu(null)} />
            <div
              data-testid="connect-menu"
              className="glass-menu absolute z-50 w-52 p-1.5"
              style={{
                left: Math.max(8, Math.min(dropMenu.x, window.innerWidth - 220)),
                top: Math.max(8, Math.min(dropMenu.y, window.innerHeight - 220)),
              }}
            >
              <p className="px-2.5 pb-1 pt-1 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-faint)]">
                Соединить с…
              </p>
              {dropMenu.offers.map((o) => (
                <button
                  key={o.key}
                  data-testid={`connect-add-${o.key}`}
                  onClick={() => {
                    addNodeConnected(o, dropMenu.flow, dropMenu.from);
                    setDropMenu(null);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px] text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface2)]"
                >
                  <span className="text-[color:var(--color-accent)]">{catalogIcon(o.icon)}</span>
                  <span className="flex-1">{o.label}</span>
                  {o.hint && (
                    <span className="text-[11px] text-[color:var(--color-faint)]">{o.hint}</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}

        <BoardExportMenu
          open={exportOpen}
          apiUrl={apiUrl}
          boardId={boardId}
          assembling={assembling}
          animaticCount={animaticNodes().length}
          onClose={() => setExportOpen(false)}
          onAnimatic={() => requestAssemble(animaticNodes())}
          onFeedback={showToast}
        />

        {/* Состав сцены — cast panel (previz S2) */}
        {castOpen && (
          <CastPanel
            apiUrl={apiUrl}
            nodes={nodes}
            onClose={() => setCastOpen(false)}
            onJump={(nid) => {
              void rf.fitView({ nodes: [{ id: nid }], duration: 300, maxZoom: 1.3 });
            }}
            onSpawn={(d) => addNode('cast', d)}
            onSaved={(nid, characterId) => patch(nid, { characterId } as Partial<CastData>)}
            showToast={showToast}
          />
        )}

        {/* «Снять всё» cost preview */}
        {runAllPlan && (
          <div className="fixed inset-0 z-50 grid place-items-center p-4">
            <div className="absolute inset-0 bg-black/55" onClick={() => setRunAllPlan(null)} />
            <div
              data-testid="run-all-dialog"
              className="glass-menu relative w-full max-w-[440px] p-5"
            >
              <div className="mb-1 flex items-center gap-2">
                <Play size={15} className="text-[color:var(--color-accent)]" />
                <h3 className="font-display text-[18px] text-[color:var(--color-fg)]">Снять всё</h3>
              </div>
              {runAllPlan.order.length === 0 ? (
                <p className="mt-2 text-[13px] text-[color:var(--color-muted-foreground)]">
                  {runAllPlan.reused.length > 0
                    ? 'Все кадры уже сняты — снимать нечего.'
                    : 'На борде нет кадров для съёмки.'}
                </p>
              ) : (
                <>
                  <p className="mb-3 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                    Запущу {runAllPlan.items.length}{' '}
                    {runAllPlan.items.length === 1 ? 'новый кадр' : 'новых кадра/ов'} по
                    зависимостям. Проверьте смету перед запуском.
                  </p>
                  {runAllRerunCount > 0 && (
                    <p
                      data-testid="run-all-rerun-warning"
                      className="mb-3 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]"
                    >
                      Перезапуск заменит дубли у {runAllRerunCount}{' '}
                      {plural(runAllRerunCount, ['кадра', 'кадров', 'кадров'])}
                    </p>
                  )}
                  <div className="seed-scroll max-h-[240px] overflow-y-auto rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)]">
                    {runAllPlan.items.map((it, i) => {
                      const nodePrompt = resolvedPrompts.get(it.id)?.trim();
                      return (
                        <RunAllQuoteRow
                          key={it.id}
                          apiUrl={apiUrl}
                          prompt={nodePrompt}
                          item={it}
                          index={i}
                          request={runAllRequests[it.id]}
                          onQuote={reportRunAllQuote}
                        />
                      );
                    })}
                  </div>
                  {runAllPlan.reused.length > 0 && (
                    <p className="mt-2 text-[11px] text-[color:var(--color-faint)]">
                      {runAllPlan.reused.length} готовых кадра/ов будут использованы повторно
                      (бесплатно).
                    </p>
                  )}
                  {runAllPlan.inFlight.length > 0 && (
                    <p className="mt-2 text-[11px] text-[color:var(--color-faint)]">
                      {runAllPlan.inFlight.length} уже запущенных кадра/ов будут дожданы после
                      reload без повторной оплаты.
                    </p>
                  )}
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-[13px] text-[color:var(--color-muted-foreground)]">
                      Итого:{' '}
                      <span
                        data-testid="run-all-total"
                        className="tnum inline-flex items-center gap-0.5 font-semibold text-[color:var(--color-fg)]"
                      >
                        <TokenStar size={12} />
                        {runAllTotal ?? '—'}
                      </span>
                    </span>
                    <div className="flex gap-2">
                      <button
                        data-testid="run-all-cancel"
                        onClick={() => setRunAllPlan(null)}
                        className="inline-flex h-9 items-center rounded-[var(--radius-md)] border-2 border-[color:var(--color-line)] px-4 text-[13px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
                      >
                        Отмена
                      </button>
                      <button
                        data-testid="run-all-confirm"
                        disabled={!runAllQuotesComplete}
                        onClick={() => runAllQuotesComplete && void executeRunAll(runAllPlan)}
                        className="glass-accent inline-flex h-9 items-center gap-2 px-4 text-[13px] font-semibold disabled:opacity-40"
                      >
                        <Play size={14} /> Запустить
                        <span className="inline-flex items-center gap-0.5">
                          <TokenStar size={12} />
                          {runAllTotal ?? '—'}
                        </span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* montage tray */}
        <div
          data-testid="montage-tray"
          className="absolute inset-x-0 bottom-0 z-30 border-t-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)] px-4 py-2.5"
        >
          <div className="flex items-center gap-3">
            <span className="label-eyebrow shrink-0">Монтаж</span>
            <div className="seed-scroll flex min-h-[44px] flex-1 items-center gap-1.5 overflow-x-auto">
              {trayNodes.length === 0 ? (
                <span className="text-[13px] text-[color:var(--color-faint)]">
                  «В монтаж» на готовом видео-узле — соберём ролик
                </span>
              ) : (
                trayNodes.map((n, i) => (
                  <span key={n.id} className="group relative shrink-0">
                    <video
                      src={`${assetSrc((n.data as unknown as GenerateData).resultUrl)}#t=0.1`}
                      muted
                      preload="metadata"
                      className="h-11 w-[72px] rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] object-cover"
                    />
                    <span className="absolute left-1 top-0.5 font-mono text-[11px] font-bold text-white/80">
                      {i + 1}
                    </span>
                    <button
                      onClick={() => {
                        takeSnapshot();
                        setTray((t) => t.filter((x) => x !== n.id));
                      }}
                      className="absolute -right-1 -top-1 hidden h-4 w-4 place-items-center rounded-[var(--radius-xs)] border-[1.5px] border-[color:var(--color-line)] bg-black/80 text-white/80 hover:text-destructive group-hover:grid touch:grid"
                    >
                      <X size={8} />
                    </button>
                  </span>
                ))
              )}
            </div>
            <button
              data-testid="board-assemble"
              disabled={trayNodes.length === 0 || assembling}
              onClick={() => requestAssemble()}
              className="glass-accent inline-flex h-10 shrink-0 items-center gap-2 px-5 text-[13px] font-semibold disabled:opacity-40"
            >
              {assembling ? <Loader2 size={15} className="seed-spin" /> : <Film size={15} />}
              Монтировать{trayNodes.length > 0 ? ` (${trayNodes.length})` : ''}
            </button>
          </div>
        </div>

        <BoardStudioSheet
          open={studioOpen}
          title={title}
          studioKey={studioKey}
          initialClips={studioBin}
          apiUrl={apiUrl}
          onClose={() => setStudioOpen(false)}
        />
      </div>
    </BoardGraphContext.Provider>
  );
}

export function BoardClient(props: {
  boardId: string;
  initialTitle: string;
  initialState: Record<string, unknown>;
  workspaceProjectId: string | null;
  models: ModelRow[];
  planTier: string | null;
  lockedCtaHref: string;
  apiUrl: string;
  devTools?: boolean;
  isAnonymous?: boolean;
}) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
