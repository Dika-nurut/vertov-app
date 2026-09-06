'use client';

import { useEffect, useRef, useState } from 'react';
import { useReactFlow, useViewport, type Edge, type Node } from '@xyflow/react';
import {
  ChevronDown,
  ChevronRight,
  Clapperboard,
  FileText,
  Hand,
  Image as ImageIcon,
  Keyboard,
  LayoutGrid,
  Map as MapIcon,
  MapPin,
  Maximize,
  MousePointer2,
  Redo2,
  Scan,
  StickyNote,
  Type,
  Undo2,
  UserRound,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from '@/components/ui/icons';
import { assetSrc } from '@/lib/asset-src';
import {
  CAST_KIND_LABEL,
  CAST_NODE_LABEL,
  CAST_NODE_LABEL_GENITIVE_PLURAL,
} from '../../../lib/cast';
import type {
  BoardAiPromptData,
  BoardCastData,
  BoardGenerateData,
  BoardMediaData,
  BoardNoteData,
  BoardPromptData,
  BoardSceneData,
  BoardTextData,
  BoardFrameData,
} from '@seed/shared/board-contract';
import { nodeTypes } from './BoardNodes';

type PromptData = BoardPromptData;
type AiPromptData = BoardAiPromptData;
type NoteData = BoardNoteData;
type SceneData = BoardSceneData;
type MediaData = BoardMediaData;
type CastData = BoardCastData;
type GenerateData = BoardGenerateData;
type TextData = BoardTextData;
type FrameData = BoardFrameData;
type AnyData =
  | PromptData
  | AiPromptData
  | NoteData
  | SceneData
  | MediaData
  | GenerateData
  | CastData
  | TextData
  | FrameData;

/* ------------------------------------------------------------------ *
 *  Canvas rail (Higgsfield's bottom-left pill groups): tools, undo/
 *  redo, fit/minimap, zoom. Lives in its own component so the zoom %
 *  readout (useViewport re-renders on every pan/zoom frame) never
 *  re-renders the board itself.
 * ------------------------------------------------------------------ */
export type CanvasTool = 'pan' | 'select';

function overviewLabel(node: Node): string {
  const raw = node.data as Record<string, unknown>;
  if (node.type === 'generate')
    return raw['mode'] === 'image' ? 'Кадр · изображение' : 'Кадр · видео';
  if (node.type === 'prompt') return 'Промпт';
  if (node.type === 'aiprompt') return 'AI-промпт';
  if (node.type === 'media') return 'Референс';
  if (node.type === 'cast') {
    const kindLabel =
      raw['castKind'] === 'location'
        ? CAST_KIND_LABEL.location
        : raw['castKind'] === 'product'
          ? CAST_KIND_LABEL.product
          : CAST_KIND_LABEL.character;
    return `${CAST_NODE_LABEL} · ${kindLabel}`;
  }
  if (node.type === 'scene') return 'Сцена';
  if (node.type === 'text') return 'Текст';
  if (node.type === 'frame') return 'Рамка';
  return 'Заметка';
}

function overviewTitle(
  node: Node,
  label: string,
  resolvedPrompts: ReadonlyMap<string, string>,
): string {
  const raw = node.data as Record<string, unknown>;
  const named = raw['title'] ?? raw['name'];
  if (typeof named === 'string' && named.trim()) return named;
  const text =
    (node.type === 'generate' ? resolvedPrompts.get(node.id) : raw['prompt']) ??
    raw['text'] ??
    raw['content'] ??
    raw['brief'];
  if (typeof text === 'string' && text.trim()) return text;
  if (node.type === 'media' && typeof raw['url'] === 'string' && raw['url']) {
    try {
      return decodeURIComponent(new URL(raw['url']).pathname.split('/').pop() || label);
    } catch {
      return raw['url'];
    }
  }
  return label;
}

function overviewThumbnail(node: Node): string | undefined {
  const raw = node.data as Record<string, unknown>;
  if (node.type === 'generate') {
    return raw['resultKind'] === 'video'
      ? (raw['lastFrameUrl'] as string | undefined)
      : ((raw['resultUrl'] ?? raw['lastFrameUrl']) as string | undefined);
  }
  if (node.type === 'media' && raw['mediaKind'] === 'image') return raw['url'] as string;
  if (node.type === 'cast') return (raw['imageUrls'] as string[] | undefined)?.[0];
  return undefined;
}

function truncateCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  cache: Map<string, string>,
): string {
  const cacheKey = `${context.font}\u0000${maxWidth}\u0000${text}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  let truncated = text;
  if (context.measureText(text).width > maxWidth) {
    let start = 0;
    let end = text.length;
    while (start < end) {
      const middle = Math.ceil((start + end) / 2);
      if (context.measureText(`${text.slice(0, middle)}…`).width <= maxWidth) start = middle;
      else end = middle - 1;
    }
    truncated = `${text.slice(0, start)}…`;
  }

  if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, truncated);
  return truncated;
}

type ThumbnailCacheEntry =
  | { status: 'loading'; image: HTMLImageElement }
  | { status: 'loaded'; image: HTMLImageElement }
  | { status: 'failed' };

type CanvasColors = {
  edge: string;
  done: string;
  running: string;
  failed: string;
  generate: string;
  node: string;
  label: string;
  title: string;
  selected: string;
};

function overviewCanvasColors(canvas: HTMLCanvasElement): CanvasColors {
  const styles = window.getComputedStyle(canvas);
  const rgba = (token: string, alpha: number) =>
    `rgba(${styles.getPropertyValue(token).trim()}, ${alpha})`;
  return {
    edge: rgba('--paper-rgb', 0.34),
    done: rgba('--positive-rgb', 0.88),
    running: rgba('--accent-rgb', 0.9),
    failed: rgba('--destructive-rgb', 0.9),
    generate: rgba('--accent-rgb', 0.72),
    node: rgba('--paper-rgb', 0.38),
    label: rgba('--paper-rgb', 0.98),
    title: rgba('--paper-rgb', 0.78),
    selected: styles.getPropertyValue('--color-accent').trim(),
  };
}

export function BoardOverviewCanvas({
  visible,
  nodes,
  edges,
  resolvedPrompts,
}: {
  visible: boolean;
  nodes: readonly Node[];
  edges: readonly Edge[];
  resolvedPrompts: ReadonlyMap<string, string>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCacheRef = useRef(new Map<string, ThumbnailCacheEntry>());
  const textCacheRef = useRef(new Map<string, string>());
  const colorsRef = useRef<CanvasColors | null>(null);
  const { x, y, zoom } = useViewport();

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const viewportRect = canvas.getBoundingClientRect();
    const isVisible = (node: Node) => {
      const width = node.width ?? node.measured?.width ?? 240;
      const height = node.height ?? node.measured?.height ?? 260;
      return (
        node.position.x + width >= -x / zoom &&
        node.position.x <= (viewportRect.width - x) / zoom &&
        node.position.y + height >= -y / zoom &&
        node.position.y <= (viewportRect.height - y) / zoom
      );
    };
    const activeThumbnailUrls = new Set(
      nodes.flatMap((node) => {
        if (!isVisible(node)) return [];
        const thumbnailUrl = overviewThumbnail(node);
        return thumbnailUrl ? [thumbnailUrl] : [];
      }),
    );
    for (const thumbnailUrl of imageCacheRef.current.keys()) {
      if (!activeThumbnailUrls.has(thumbnailUrl)) imageCacheRef.current.delete(thumbnailUrl);
    }
    const thumbnailCacheLimit = Math.min(256, Math.max(64, activeThumbnailUrls.size));
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      const colors = (colorsRef.current ??= overviewCanvasColors(canvas));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      context.save();
      context.translate(x, y);
      context.scale(zoom, zoom);

      const byId = new Map(nodes.map((node) => [node.id, node]));
      context.strokeStyle = colors.edge;
      context.lineWidth = 1.2 / zoom;
      for (const edge of edges) {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        if (!source || !target) continue;
        const sourceWidth = source.width ?? source.measured?.width ?? 240;
        const sourceHeight = source.height ?? source.measured?.height ?? 260;
        const targetHeight = target.height ?? target.measured?.height ?? 260;
        context.beginPath();
        context.moveTo(source.position.x + sourceWidth, source.position.y + sourceHeight / 2);
        context.lineTo(target.position.x, target.position.y + targetHeight / 2);
        context.stroke();
      }

      for (const node of nodes) {
        const width = node.width ?? node.measured?.width ?? 240;
        const height = node.height ?? node.measured?.height ?? 260;
        const status = (node.data as Record<string, unknown>)['status'];
        context.fillStyle =
          status === 'done'
            ? colors.done
            : status === 'running'
              ? colors.running
              : status === 'failed'
                ? colors.failed
                : node.type === 'generate'
                  ? colors.generate
                  : colors.node;
        context.fillRect(node.position.x, node.position.y, width, height);
        const thumbnailUrl = isVisible(node) ? overviewThumbnail(node) : undefined;
        const thumbnail = thumbnailUrl ? imageCacheRef.current.get(thumbnailUrl) : undefined;
        if (thumbnail?.status === 'loaded') {
          context.drawImage(thumbnail.image, node.position.x + 10, node.position.y + 10, 72, 54);
        } else if (thumbnailUrl && !thumbnail && imageCacheRef.current.size < thumbnailCacheLimit) {
          const image = new Image();
          image.onload = () => {
            const current = imageCacheRef.current.get(thumbnailUrl);
            if (current?.status !== 'loading' || current.image !== image) return;
            imageCacheRef.current.set(thumbnailUrl, { status: 'loaded', image });
            draw();
          };
          image.onerror = () => {
            const current = imageCacheRef.current.get(thumbnailUrl);
            if (current?.status === 'loading' && current.image === image) {
              imageCacheRef.current.set(thumbnailUrl, { status: 'failed' });
            }
          };
          imageCacheRef.current.set(thumbnailUrl, { status: 'loading', image });
          image.src = assetSrc(thumbnailUrl);
        }
        const textX = node.position.x + (thumbnailUrl ? 92 : 12);
        const textWidth = Math.max(20, node.position.x + width - textX - 12);
        const label = overviewLabel(node);
        context.fillStyle = colors.label;
        context.font = '700 20px ui-monospace, monospace';
        context.fillText(
          truncateCanvasText(context, label, textWidth, textCacheRef.current),
          textX,
          node.position.y + 31,
        );
        context.fillStyle = colors.title;
        context.font = '500 16px system-ui, sans-serif';
        context.fillText(
          truncateCanvasText(
            context,
            overviewTitle(node, label, resolvedPrompts),
            textWidth,
            textCacheRef.current,
          ),
          textX,
          node.position.y + 54,
        );
        if (node.selected) {
          context.strokeStyle = colors.selected;
          context.lineWidth = 4 / zoom;
          context.strokeRect(node.position.x, node.position.y, width, height);
        }
      }
      context.restore();
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [visible, nodes, edges, resolvedPrompts, x, y, zoom]);

  if (!visible) return null;
  return (
    <canvas
      ref={canvasRef}
      data-testid="board-overview-canvas"
      className="pointer-events-none absolute inset-0 z-[5] h-full w-full"
      aria-hidden
    />
  );
}

/* ------------------------------------------------------------------ *
 *  Add-node catalog — searchable, categorized (Runway's add menu
 *  pattern: search + categories + «keep open to add multiple»).
 * ------------------------------------------------------------------ */
interface CatalogItem {
  t: keyof typeof nodeTypes;
  testid: string;
  label: string;
  hint?: string;
  keywords: string;
  icon:
    | 'video'
    | 'image'
    | 'prompt'
    | 'aiprompt'
    | 'media'
    | 'note'
    | 'scene'
    | 'character'
    | 'location'
    | 'text'
    | 'frame';
  d: Partial<AnyData>;
}
const NODE_CATALOG: { category: string; items: CatalogItem[] }[] = [
  {
    category: 'Быстрые',
    items: [
      {
        t: 'generate',
        testid: 'add-generate',
        label: 'Кадр · видео',
        hint: 'Seedance',
        keywords: 'кадр видео video shot generate генерация клип сцена',
        icon: 'video',
        d: { mode: 'video' },
      },
      {
        t: 'generate',
        testid: 'add-generate-image',
        label: 'Кадр · картинка',
        hint: 'Seedream',
        keywords: 'кадр картинка изображение image still фото generate генерация',
        icon: 'image',
        d: { mode: 'image' },
      },
      {
        t: 'prompt',
        testid: 'add-prompt',
        label: 'Промпт',
        hint: 'текст',
        keywords: 'промпт prompt текст text описание',
        icon: 'prompt',
        d: {},
      },
      {
        t: 'aiprompt',
        testid: 'add-aiprompt',
        label: 'AI-промпт',
        hint: 'Claude/GPT',
        keywords: 'ai промпт prompt claude gpt gemini нейросеть генератор промпта бриф',
        icon: 'aiprompt',
        d: {},
      },
    ],
  },
  {
    category: 'Референсы',
    items: [
      {
        t: 'media',
        testid: 'add-media',
        label: 'Референс',
        hint: 'загрузка',
        keywords: 'референс reference изображение upload загрузить медиа',
        icon: 'media',
        d: {},
      },
    ],
  },
  {
    category: 'Утилиты',
    items: [
      {
        t: 'scene',
        testid: 'add-scene',
        label: 'Сцена',
        hint: 'из сценария',
        keywords: 'сцена scene сценарий screenplay source источник',
        icon: 'scene',
        d: {},
      },
      {
        t: 'note',
        testid: 'add-note',
        label: 'Заметка',
        keywords: 'заметка note sticky стикер комментарий',
        icon: 'note',
        d: {},
      },
      {
        t: 'text',
        testid: 'add-text',
        label: 'Текст',
        hint: 'аннотация',
        keywords: 'текст text annotation заметка комментарий подпись',
        icon: 'text',
        d: {},
      },
      {
        t: 'frame',
        testid: 'add-frame',
        label: 'Рамка',
        hint: 'группа',
        keywords: 'рамка frame группа секция organizer',
        icon: 'frame',
        d: {},
      },
    ],
  },
];

export function catalogIcon(kind: CatalogItem['icon']) {
  switch (kind) {
    case 'video':
      return <Clapperboard size={13} />;
    case 'image':
    case 'media':
      return <ImageIcon size={13} />;
    case 'prompt':
      return <Type size={13} />;
    case 'aiprompt':
      return <Wand2 size={13} />;
    case 'note':
      return <StickyNote size={13} />;
    case 'scene':
      return <FileText size={13} />;
    case 'character':
      return <UserRound size={13} />;
    case 'location':
      return <MapPin size={13} />;
    case 'text':
      return <Type size={13} />;
    case 'frame':
      return <LayoutGrid size={13} />;
  }
}

/* ------------------------------------------------------------------ *
 *  «Состав сцены» — the previz cast panel (S2): every Персонаж/Локация
 *  on the board in one list; jump to a node, save a character to the
 *  «Персонажи» library, or drop a saved one onto the board.
 * ------------------------------------------------------------------ */
interface SavedCharacter {
  id: string;
  name: string;
  imageUrls: string[];
}

export function CastPanel({
  apiUrl,
  nodes,
  onClose,
  onJump,
  onSpawn,
  onSaved,
  showToast,
}: {
  apiUrl: string;
  nodes: Node[];
  onClose: () => void;
  onJump: (nodeId: string) => void;
  onSpawn: (d: Partial<CastData>) => void;
  onSaved: (nodeId: string, characterId: string) => void;
  showToast: (m: string) => void;
}) {
  const casts = nodes.filter((n) => n.type === 'cast');
  const [saved, setSaved] = useState<SavedCharacter[] | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function loadSaved() {
    setSavedOpen((v) => !v);
    if (saved) return;
    try {
      const res = await fetch(`${apiUrl}/v1/characters`, { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { items: SavedCharacter[] };
      setSaved(body.items);
    } catch {
      showToast('Не удалось загрузить сохранённых людей.');
      setSaved([]);
    }
  }

  async function saveCharacter(nodeId: string, d: CastData) {
    setBusyId(nodeId);
    try {
      const res = await fetch(`${apiUrl}/v1/characters`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: d.name.trim(), imageUrls: d.imageUrls.slice(0, 4) }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const row = (await res.json()) as { id: string };
      onSaved(nodeId, row.id);
      setSaved(null); // refetch next open
      showToast('Сохранено в Персонажи.');
    } catch {
      showToast('Не удалось сохранить человека.');
    } finally {
      setBusyId(null);
    }
  }

  const sorted = [...casts].sort((a, b) => {
    const order = { character: 0, product: 1, location: 2 } as const;
    const ka = order[(a.data as unknown as CastData).castKind];
    const kb = order[(b.data as unknown as CastData).castKind];
    return ka - kb;
  });

  return (
    <div
      data-testid="cast-panel"
      className="glass-menu absolute right-4 top-16 z-40 flex w-72 flex-col p-2"
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        <UserRound size={12} className="text-[color:var(--color-accent)]" />
        <span className="flex-1 font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Состав сцены
        </span>
        <button
          onClick={onClose}
          className="text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]"
        >
          <X size={12} />
        </button>
      </div>
      <div className="seed-scroll max-h-[300px] overflow-y-auto">
        {sorted.length === 0 && (
          <p className="px-1.5 py-3 text-[11px] leading-snug text-[color:var(--color-faint)]">
            На борде пока нет {CAST_NODE_LABEL_GENITIVE_PLURAL}. Добавьте их через «Узел» — и
            подключайте к кадрам, чтобы герой, место и товар не менялись от кадра к кадру.
          </p>
        )}
        {sorted.map((n) => {
          const d = n.data as unknown as CastData;
          const isChar = d.castKind === 'character';
          const isProduct = d.castKind === 'product';
          const castKindLabel = CAST_KIND_LABEL[d.castKind];
          return (
            <div
              key={n.id}
              className="group/cast flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1.5 hover:bg-[color:var(--color-surface2)]"
            >
              <button
                onClick={() => onJump(n.id)}
                className="flex flex-1 items-center gap-2 text-left"
                data-testid={`cast-row-${n.id}`}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/40">
                  {d.imageUrls[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={assetSrc(d.imageUrls[0])}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : isChar ? (
                    <UserRound size={13} className="text-[color:var(--color-faint)]" />
                  ) : isProduct ? (
                    <ImageIcon size={13} className="text-[color:var(--color-faint)]" />
                  ) : (
                    <MapPin size={13} className="text-[color:var(--color-faint)]" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-[color:var(--color-fg)]">
                    {d.name.trim() || (isChar ? 'Без имени' : 'Без названия')}
                  </span>
                  <span className="block text-[11px] text-[color:var(--color-faint)]">
                    {castKindLabel.toLowerCase()} · {d.imageUrls.length} кадр.
                    {d.videoUrl ? ' · движение' : ''}
                  </span>
                </span>
              </button>
              {isChar && !d.characterId && d.name.trim() && d.imageUrls.length > 0 && (
                <button
                  title="Сохранить в Персонажи"
                  data-testid={`cast-save-${n.id}`}
                  disabled={busyId === n.id}
                  onClick={() => void saveCharacter(n.id, d)}
                  className="rounded-[var(--radius-xs)] border-2 border-[color:var(--color-accent)] px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-accent)] opacity-0 transition-opacity hover:bg-[color:var(--color-accent)] hover:text-[color:var(--color-primary-foreground)] group-hover/cast:opacity-100 touch:opacity-100"
                >
                  {busyId === n.id ? '…' : 'Сохранить'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        data-testid="cast-from-saved"
        onClick={() => void loadSaved()}
        className="mt-1 border-t-2 border-[color:var(--color-line)] px-1.5 pb-0.5 pt-2 text-left text-[11px] font-semibold text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
      >
        <span className="inline-flex items-center gap-1">
          Из сохранённых
          {savedOpen ? (
            <ChevronDown size={11} aria-hidden />
          ) : (
            <ChevronRight size={11} aria-hidden />
          )}
        </span>
      </button>
      {savedOpen && (
        <div className="seed-scroll max-h-[160px] overflow-y-auto">
          {saved === null ? (
            <p className="px-1.5 py-2 text-[11px] text-[color:var(--color-faint)]">Загружаю…</p>
          ) : saved.length === 0 ? (
            <p className="px-1.5 py-2 text-[11px] text-[color:var(--color-faint)]">
              Сохранённых людей пока нет.
            </p>
          ) : (
            saved.map((c) => (
              <button
                key={c.id}
                data-testid={`cast-saved-${c.id}`}
                onClick={() =>
                  onSpawn({
                    castKind: 'character',
                    name: c.name,
                    imageUrls: c.imageUrls,
                    characterId: c.id,
                  })
                }
                className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1.5 text-left hover:bg-[color:var(--color-surface2)]"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-black/40">
                  {c.imageUrls[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={assetSrc(c.imageUrls[0])}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <UserRound size={12} className="text-[color:var(--color-faint)]" />
                  )}
                </span>
                <span className="truncate text-[13px] text-[color:var(--color-fg)]">{c.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function filterCatalog(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return NODE_CATALOG;
  return NODE_CATALOG.map((g) => ({
    category: g.category,
    items: g.items.filter(
      (it) => it.label.toLowerCase().includes(q) || it.keywords.toLowerCase().includes(q),
    ),
  })).filter((g) => g.items.length > 0);
}

export function CanvasRail({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  tool,
  onTool,
  minimap,
  onMinimap,
  hasSelection,
  onZoomSelection,
  onViewportIntent,
  onFit,
  onHelp,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  tool: CanvasTool;
  onTool: (t: CanvasTool) => void;
  minimap: boolean;
  onMinimap: () => void;
  hasSelection: boolean;
  onZoomSelection: () => void;
  onViewportIntent: () => void;
  onFit: () => void;
  onHelp: () => void;
}) {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const btn =
    'press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)] disabled:pointer-events-none disabled:opacity-30';
  const btnOn =
    'press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]';
  const pill = 'glass pointer-events-auto flex items-center gap-0.5 p-1';
  return (
    <div
      data-testid="rail-tools"
      className="pointer-events-none absolute bottom-[84px] left-4 right-4 z-30 flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-1.5 max-[1099px]:bottom-[148px] sm:right-auto sm:max-w-none sm:flex-nowrap sm:gap-2"
    >
      <div className={pill}>
        <button
          data-testid="tool-pan"
          title="Рука: двигать холст"
          onClick={() => onTool('pan')}
          className={tool === 'pan' ? btnOn : btn}
        >
          <Hand size={13} />
        </button>
        <button
          data-testid="tool-select"
          title="Выделение: рамка по холсту; Space временно включает руку"
          onClick={() => onTool('select')}
          className={tool === 'select' ? btnOn : btn}
        >
          <MousePointer2 size={13} />
        </button>
      </div>
      <div className={pill}>
        <button
          data-testid="rail-undo"
          title="Отменить (Ctrl+Z)"
          disabled={!canUndo}
          onClick={onUndo}
          className={btn}
        >
          <Undo2 size={13} />
        </button>
        <button
          data-testid="rail-redo"
          title="Вернуть (Ctrl+Shift+Z)"
          disabled={!canRedo}
          onClick={onRedo}
          className={btn}
        >
          <Redo2 size={13} />
        </button>
      </div>
      <div className={pill}>
        <button data-testid="rail-fit" title="К содержимому" onClick={onFit} className={btn}>
          <Maximize size={13} />
        </button>
        <button
          data-testid="rail-zoom-selection"
          title="К выделенному"
          disabled={!hasSelection}
          onClick={() => {
            onViewportIntent();
            onZoomSelection();
          }}
          className={btn}
        >
          <Scan size={13} />
        </button>
        <button
          data-testid="rail-minimap"
          title="Миникарта"
          onClick={onMinimap}
          className={minimap ? btnOn : btn}
        >
          <MapIcon size={13} />
        </button>
      </div>
      <div className={pill}>
        <button
          data-testid="rail-zoom-out"
          title="Отдалить"
          onClick={() => {
            onViewportIntent();
            void rf.zoomOut({ duration: 120 });
          }}
          className={btn}
        >
          <ZoomOut size={13} />
        </button>
        <button
          data-testid="rail-zoom-level"
          title="Сбросить масштаб"
          onClick={() => {
            onViewportIntent();
            void rf.zoomTo(1, { duration: 150 });
          }}
          className="tnum h-7 min-w-[40px] rounded-[var(--radius-sm)] px-1 text-center text-[11px] font-semibold text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          data-testid="rail-zoom-in"
          title="Приблизить"
          onClick={() => {
            onViewportIntent();
            void rf.zoomIn({ duration: 120 });
          }}
          className={btn}
        >
          <ZoomIn size={13} />
        </button>
      </div>
      <div className={pill}>
        <button
          data-testid="rail-help"
          title="Горячие клавиши (?)"
          onClick={onHelp}
          className={btn}
        >
          <Keyboard size={13} />
        </button>
      </div>
    </div>
  );
}
