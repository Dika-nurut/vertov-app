'use client';

import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { validateSredaFolderName } from '@seed/shared/sreda-folders';
import { mediaDisplayTitle } from '@seed/shared/media-title';
import { assetSrc } from '@/lib/asset-src';
import { SearchLauncher } from '@/components/search/SearchLauncher';
import {
  runDeskUploadBatch,
  type DeskUploadDestination,
  type DeskUploadFile,
  type UploadedAssetReceipt,
} from '@/lib/desk-upload';
import { deskBatchStatusCopy, deskUploadErrorCopy } from '@/lib/desk-upload-copy';
import { DeskIcon } from './DeskIcons';
import styles from './desk.module.css';
import { deskOverflowLinks, type DeskTruncation } from '@/lib/desk-overflow';
import { SredaFolderBrowser } from './SredaFolderBrowser';
import {
  folderChildren,
  folderMoveTargets,
  folderMutationError,
  type FolderPayload,
} from './folder-model';
import {
  moveDeskItem,
  resolveDeskLayout,
  type DeskLayoutBounds,
  type DeskLayoutPoint,
} from '@/lib/desk-layout';
import { clampDeskWindowPosition } from '@/lib/desk-window-bounds';
import { handleModalKeyDown } from '@/lib/modal-focus';
import {
  PROJECT_PRODUCT_DESTINATIONS,
  isResolvableProjectProduct,
  projectListHref,
  projectResolverHref,
  type ProjectProduct,
} from '@/lib/project-product-destinations';

interface ProjectPayload {
  id: string;
  title: string;
  productionFormat: { aspect: string; note?: string };
  primaryScriptId: string | null;
  rooms: { scenario: number; boards: number; studio: number; assets: number };
}

interface DeskAsset {
  id: string;
  assetUrl: string;
  thumbnailUrl: string | null;
  kind: 'image' | 'video' | 'audio';
  title: string | null;
  originalName: string | null;
  sourceLine?: string;
  mimeType: string | null;
  createdAt: string;
  usage?: string[];
}

interface RecentDeskAsset extends DeskAsset {
  addedAt: string;
}

interface DeskDocument {
  type: 'script' | 'board' | 'studio';
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  href: string;
}

type DeskSurfaceItem =
  | { type: 'media'; id: string; sortAt: string; asset: DeskAsset }
  | (DeskDocument & { type: 'script' | 'board' | 'studio'; sortAt: string });

interface DeskItemsPayload {
  items: DeskSurfaceItem[];
  apps: {
    scenario: Array<DeskDocument & { type: 'script' }>;
    boards: Array<DeskDocument & { type: 'board' }>;
    studio: Array<DeskDocument & { type: 'studio' }>;
  };
  truncated: DeskTruncation;
  retention: { mode: string; reminder: string | null };
}

interface DeskLayoutPayload {
  revision: number;
  positions: Array<{
    itemKind: 'system' | 'folder' | 'media' | 'script' | 'board' | 'studio';
    itemId: string;
    x: number;
    y: number;
  }>;
}

type DeskWindow =
  | { key: string; kind: 'recents'; name: string; items: RecentDeskAsset[]; loading: boolean }
  | {
      key: string;
      kind: 'folder';
      folderId: string;
      name: string;
      items: DeskAsset[];
      loading: boolean;
      error: string | null;
    }
  | { key: string; kind: 'frames'; name: string; items: DeskAsset[]; loading: false };

type DragPayload =
  | { kind: 'asset'; asset: DeskAsset; fromFolderId?: string; fromFolderName?: string }
  | { kind: 'external'; files: File[] };

interface UploadBatch {
  id: string;
  files: File[];
  destination: DeskUploadDestination;
  label: string;
  completed: number;
  total: number;
  status: 'running' | 'done' | 'failed' | 'rejected' | 'cancelled';
  message?: string;
  destinationId?: string | null;
  receipts?: UploadedAssetReceipt[];
  controller: AbortController;
}

interface AssetReferenceUsage {
  type: string;
  refId: string;
}

interface Receipt {
  message: string;
  retentionReminder?: string | null;
  destination?: string;
  folderId?: string;
  usages?: AssetReferenceUsage[];
  undo?: () => Promise<void>;
}

interface ApiErrorDetail {
  error?: string;
  revision?: number;
  count?: number;
  limit?: number;
  currentVersion?: number;
  childFolders?: number;
  placements?: number;
  usages?: AssetReferenceUsage[];
}

type FolderAction =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'rename'; folder: FolderPayload }
  | { kind: 'move'; folder: FolderPayload; targetId: string | null }
  | { kind: 'delete'; folder: FolderPayload };

const cx = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

const iconPositionStyle = (point?: DeskLayoutPoint) =>
  point ? { left: point.x, top: point.y } : undefined;

const MENU_VIEWPORT_GAP = 8;

/**
 * Keep a fixed-position desk menu fully inside the viewport. Raw pointer
 * coordinates leave a menu opened near the right/bottom edge partly
 * unreachable (most visible at 1280×720), so the measured box is nudged back
 * in after render instead of being positioned blind.
 */
function clampMenuToViewport(node: HTMLElement, x: number, y: number): void {
  const rect = node.getBoundingClientRect();
  const maxLeft = Math.max(MENU_VIEWPORT_GAP, window.innerWidth - rect.width - MENU_VIEWPORT_GAP);
  const maxTop = Math.max(MENU_VIEWPORT_GAP, window.innerHeight - rect.height - MENU_VIEWPORT_GAP);
  node.style.left = `${Math.max(MENU_VIEWPORT_GAP, Math.min(x, maxLeft))}px`;
  node.style.top = `${Math.max(MENU_VIEWPORT_GAP, Math.min(y, maxTop))}px`;
}

/** Menu items in DOM order — the roving-focus ring for arrow-key navigation. */
function menuItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

/**
 * The keyboard contract shared by both desk context menus (the folder menu and
 * the generic desk menu): arrows plus Home/End rove the focus ring, Escape and
 * Tab dismiss. Each menu supplies its own `close`, which owns where focus goes
 * back to — the folder icon that opened it, or the desk plane.
 */
function handleMenuKeyDown(
  event: React.KeyboardEvent<HTMLMenuElement>,
  close: (restoreFocus: boolean) => void,
): void {
  if (event.key === 'Escape' || event.key === 'Tab') {
    // Tab would otherwise leak focus back into the desk behind an open menu.
    event.preventDefault();
    event.stopPropagation();
    close(true);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = menuItems(event.currentTarget);
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : current === -1
          ? event.key === 'ArrowDown'
            ? 0
            : items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok || body === null) {
    const detail = body as ApiErrorDetail | null;
    const error = new Error(detail?.error ?? `http_${response.status}`) as Error & {
      status?: number;
      detail?: typeof detail;
    };
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  return body;
}

const ASSET_USAGE_LABELS: Record<string, string> = {
  studio_clip: 'Студия',
  board_node: 'Борды',
};

function regularBatchFiles(batch: UploadBatch): File[] {
  if (!batch.receipts) return batch.files;
  return batch.files.filter((_file, index) => !batch.receipts?.[index]?.reused);
}

function duplicateBatchFiles(
  batch: UploadBatch,
): Array<{ file: File; receipt: UploadedAssetReceipt }> {
  if (!batch.receipts) return [];
  return batch.files.flatMap((file, index) => {
    const receipt = batch.receipts?.[index];
    return receipt?.reused ? [{ file, receipt }] : [];
  });
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'только что';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  return `${Math.floor(hours / 24)} дн`;
}

function assetLabel(asset: DeskAsset): string {
  return mediaDisplayTitle(asset);
}

function fileTypeBadge(
  name: string | null | undefined,
  mimeType: string | null | undefined,
): string {
  const extension = name?.split('.').pop();
  if (extension && extension !== name && extension.length <= 5) return extension.toUpperCase();
  if (mimeType?.startsWith('image/')) return 'IMG';
  if (mimeType?.startsWith('video/')) return 'VID';
  if (mimeType?.startsWith('audio/')) return 'AUD';
  return 'FILE';
}

function ghostVisual(payload: DragPayload): {
  icon: 'image' | 'play' | 'music' | 'upload';
  badge: string;
} {
  if (payload.kind === 'asset') {
    return {
      icon:
        payload.asset.kind === 'image'
          ? 'image'
          : payload.asset.kind === 'video'
            ? 'play'
            : 'music',
      badge: fileTypeBadge(payload.asset.originalName, payload.asset.mimeType),
    };
  }
  const file = payload.files[0];
  return {
    icon: file?.type.startsWith('image/')
      ? 'image'
      : file?.type.startsWith('video/')
        ? 'play'
        : file?.type.startsWith('audio/')
          ? 'music'
          : 'upload',
    badge: fileTypeBadge(file?.name, file?.type),
  };
}

function FolderArt({ stamp }: { stamp?: 'recents' | 'frames' }) {
  return (
    <span className={styles.folderArt}>
      <span className={styles.folderGlyph}>
        <DeskIcon name={stamp === 'recents' ? 'clock' : stamp === 'frames' ? 'image' : 'folder'} />
      </span>
      {stamp && (
        <span className={styles.folderStamp}>
          <DeskIcon name={stamp === 'recents' ? 'clock' : 'image'} />
        </span>
      )}
    </span>
  );
}

function FileArt({
  kind,
  asset,
}: {
  kind: 'media' | 'script' | 'board' | 'studio';
  asset?: DeskAsset;
}) {
  const stamp =
    kind === 'script'
      ? 'SCN'
      : kind === 'board'
        ? 'BRD'
        : kind === 'studio'
          ? 'EDT'
          : asset?.kind === 'video'
            ? 'VID'
            : asset?.kind === 'audio'
              ? 'AUD'
              : 'IMG';
  return (
    <span className={styles.fileArt}>
      <span className={styles.fileShape}>
        {kind === 'media' && asset?.kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assetSrc(asset.thumbnailUrl ?? asset.assetUrl)} alt="" />
        ) : kind === 'media' && asset?.kind === 'video' && asset.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assetSrc(asset.thumbnailUrl)} alt="" />
        ) : (
          <DeskIcon
            name={
              kind === 'script'
                ? 'document'
                : kind === 'board'
                  ? 'boardFile'
                  : kind === 'studio'
                    ? 'video'
                    : asset?.kind === 'video'
                      ? 'play'
                      : 'music'
            }
          />
        )}
        {kind === 'media' && asset?.kind === 'video' && asset.thumbnailUrl && (
          <span className={styles.playOverlay}>
            <DeskIcon name="play" />
          </span>
        )}
      </span>
      <span className={cx(styles.typeStamp, styles[`type${stamp}`])}>{stamp}</span>
    </span>
  );
}

const DOCK_LINKS = Object.entries(PROJECT_PRODUCT_DESTINATIONS) as Array<
  [ProjectProduct, (typeof PROJECT_PRODUCT_DESTINATIONS)[ProjectProduct]]
>;

const DESK_GUIDANCE_DISMISSED_KEY = 'sreda:desk-guidance-dismissed';

/** Bound on self-healing layout retries. Each conflict raises our revision above
 *  the server's, so one retry normally settles it; the cap only exists so two
 *  tabs saving in lockstep cannot spin. */
const LAYOUT_CONFLICT_RETRY_LIMIT = 5;

export function DeskClient({ projectId, apiUrl }: { projectId: string; apiUrl: string }) {
  const base = apiUrl.replace(/\/$/, '');
  const [project, setProject] = useState<ProjectPayload | null>(null);
  const [folders, setFolders] = useState<FolderPayload[]>([]);
  const [recents, setRecents] = useState<RecentDeskAsset[]>([]);
  const [surfaceItems, setSurfaceItems] = useState<DeskSurfaceItem[]>([]);
  const [retentionReminder, setRetentionReminder] = useState<string | null>(null);
  const [truncated, setTruncated] = useState<DeskTruncation>({
    media: false,
    scenario: false,
    boards: false,
    studio: false,
  });
  const overflowLinks = deskOverflowLinks(truncated, projectId);
  const [windows, setWindows] = useState<DeskWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [bounceGhost, setBounceGhost] = useState<DragPayload | null>(null);
  const [folderDragId, setFolderDragId] = useState<string | null>(null);
  const [folderAction, setFolderAction] = useState<FolderAction | null>(null);
  const [folderActionError, setFolderActionError] = useState<string | null>(null);
  const [folderActionName, setFolderActionName] = useState('');
  const [pendingNewFolder, setPendingNewFolder] = useState<DragPayload | 'empty' | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [batches, setBatches] = useState<UploadBatch[]>([]);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [layoutPositions, setLayoutPositions] = useState<Record<string, DeskLayoutPoint>>({});
  const [layoutBounds, setLayoutBounds] = useState<DeskLayoutBounds>({ width: 1, height: 1 });
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{
    folder: FolderPayload;
    x: number;
    y: number;
  } | null>(null);
  const folderMenuRef = useRef<HTMLMenuElement>(null);
  const deskMenuRef = useRef<HTMLMenuElement>(null);
  // The element that opened the folder menu, so Escape/dismiss can hand focus
  // back where it came from (a desktop context menu never strands focus).
  const folderMenuTriggerRef = useRef<HTMLElement | null>(null);
  const folderActionRef = useRef<HTMLFormElement>(null);
  const newFolderRef = useRef<HTMLFormElement>(null);
  // Where focus came from when a desk dialog opened. Without it, cancel /
  // submit / Escape unmount the dialog with focus inside and drop it on <body>.
  const deskDialogOpenerRef = useRef<HTMLElement | null>(null);
  const [windowPositions, setWindowPositions] = useState<
    Record<string, { left: number; top: number }>
  >({});
  // Live folder-window nodes, so an open window can be measured and re-clamped
  // when the viewport shrinks under it.
  const windowNodes = useRef(new Map<string, HTMLElement>());
  const [credits, setCredits] = useState<number | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [showDeskGuidance, setShowDeskGuidance] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const deskRef = useRef<HTMLElement>(null);
  const planeRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layoutPositionsRef = useRef<Record<string, DeskLayoutPoint>>({});
  const layoutDirtyRef = useRef(new Map<string, DeskLayoutPoint>());
  const layoutTimerRef = useRef<number | null>(null);
  const layoutRevisionRef = useRef(0);
  const layoutConflictRetriesRef = useRef(0);
  /** How many layout writes are in flight. A boolean cannot describe two:
   *  the unload flush deliberately bypasses the guard, so it can overlap a
   *  normal one, and whichever finishes first would clear a shared flag while
   *  the other is still out — re-opening the overlap this guard exists to close. */
  const layoutInFlightRef = useRef(0);
  const layoutSentRevisionRef = useRef(new Map<string, number>());
  const windowsRef = useRef<DeskWindow[]>([]);
  const movingWindow = useRef<{ key: string; offsetX: number; offsetY: number } | null>(null);

  const endpoint = useCallback((path: string) => `${base}${path}`, [base]);

  useEffect(() => {
    try {
      setShowDeskGuidance(window.localStorage.getItem(DESK_GUIDANCE_DISMISSED_KEY) !== '1');
    } catch {
      // Keep the brief available when private browsing disallows storage.
      setShowDeskGuidance(true);
    }
  }, []);

  const dismissDeskGuidance = useCallback(() => {
    setShowDeskGuidance(false);
    try {
      window.localStorage.setItem(DESK_GUIDANCE_DISMISSED_KEY, '1');
    } catch {
      // The current visit still respects dismissal.
    }
  }, []);

  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    layoutPositionsRef.current = layoutPositions;
  }, [layoutPositions]);

  const loadUsages = useCallback(
    async (assets: DeskAsset[]): Promise<DeskAsset[]> => {
      if (assets.length === 0) return assets;
      try {
        const payload = await apiJson<{ usages: Record<string, string[]> }>(
          endpoint('/v1/assets/usage'),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ assetIds: assets.map((asset) => asset.id) }),
          },
        );
        return assets.map((asset) => ({ ...asset, usage: payload.usages[asset.id] ?? [] }));
      } catch {
        return assets;
      }
    },
    [endpoint],
  );

  const loadFolderItems = useCallback(
    async (folderId: string): Promise<DeskAsset[]> => {
      const payload = await apiJson<{ items: Array<{ asset: DeskAsset }> }>(
        endpoint(`/v1/folders/${encodeURIComponent(folderId)}/assets?limit=50`),
      );
      return loadUsages(payload.items.map((item) => item.asset));
    },
    [endpoint, loadUsages],
  );

  const refreshDesk = useCallback(async () => {
    const encoded = encodeURIComponent(projectId);
    const openFolderWindows = windowsRef.current.filter(
      (window): window is Extract<DeskWindow, { kind: 'folder' }> => window.kind === 'folder',
    );
    const [
      projectPayload,
      folderPayload,
      recentPayload,
      deskPayload,
      layoutPayload,
      folderWindowPayloads,
    ] = await Promise.all([
      apiJson<ProjectPayload>(endpoint(`/v1/projects/${encoded}`)),
      apiJson<{ folders: FolderPayload[] }>(endpoint(`/v1/projects/${encoded}/folders`)),
      apiJson<{ items: RecentDeskAsset[] }>(endpoint(`/v1/projects/${encoded}/recents?limit=100`)),
      apiJson<DeskItemsPayload>(endpoint(`/v1/projects/${encoded}/desk-items`)),
      apiJson<DeskLayoutPayload>(endpoint(`/v1/projects/${encoded}/desk-layout`)),
      Promise.all(
        openFolderWindows.map(async (window) => {
          try {
            return [window.key, await loadFolderItems(window.folderId)] as const;
          } catch {
            return null;
          }
        }),
      ),
    ]);
    const enrichedRecents = (await loadUsages(recentPayload.items)) as RecentDeskAsset[];
    const looseMedia = deskPayload.items
      .filter((item): item is Extract<DeskSurfaceItem, { type: 'media' }> => item.type === 'media')
      .map((item) => item.asset);
    const enrichedLooseMedia = new Map(
      (await loadUsages(looseMedia)).map((asset) => [asset.id, asset]),
    );
    const folderItemsByKey = new Map(
      folderWindowPayloads.filter(
        (entry): entry is readonly [string, DeskAsset[]] => entry !== null,
      ),
    );
    setProject(projectPayload);
    setFolders(folderPayload.folders);
    setRecents(enrichedRecents);
    setSurfaceItems(
      deskPayload.items.map((item) =>
        item.type === 'media'
          ? { ...item, asset: enrichedLooseMedia.get(item.id) ?? item.asset }
          : item,
      ),
    );
    setLayoutPositions(
      Object.fromEntries(
        layoutPayload.positions.map((position) => [
          `${position.itemKind}:${position.itemId}`,
          { x: position.x, y: position.y },
        ]),
      ),
    );
    layoutRevisionRef.current = Math.max(layoutRevisionRef.current, layoutPayload.revision);
    setLayoutLoaded(true);
    setRetentionReminder(deskPayload.retention.reminder);
    if (deskPayload.truncated) setTruncated(deskPayload.truncated);
    setWindows((current) =>
      current.flatMap((window) => {
        if (window.kind === 'recents') return { ...window, items: enrichedRecents, loading: false };
        if (window.kind === 'folder') {
          const currentFolder = folderPayload.folders.find(
            (folder) => folder.id === window.folderId,
          );
          if (!currentFolder) return [];
          if (folderItemsByKey.has(window.key)) {
            return {
              ...window,
              name: currentFolder.name,
              items: folderItemsByKey.get(window.key)!,
              loading: false,
              error: null,
            };
          }
        }
        return window;
      }),
    );
    void apiJson<{ available: number }>(endpoint('/v1/credits/balance'))
      .then((balance) => setCredits(balance.available))
      .catch(() => setCredits(null));
  }, [endpoint, loadFolderItems, loadUsages, projectId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    refreshDesk()
      .catch((error) => {
        if (alive) setLoadError(error instanceof Error ? error.message : 'desk_unavailable');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [refreshDesk]);

  const itemKeys = useMemo(
    () => [
      'system:recents',
      'system:frames',
      ...folders.map((folder) => `folder:${folder.id}`),
      ...surfaceItems.map((item) => `${item.type}:${item.id}`),
    ],
    [folders, surfaceItems],
  );

  const flushLayout = useCallback(
    async (keepalive = false) => {
      if (layoutTimerRef.current !== null) {
        window.clearTimeout(layoutTimerRef.current);
        layoutTimerRef.current = null;
      }
      const pending = [...layoutDirtyRef.current.entries()];
      if (pending.length === 0) return;
      // Never let two flushes overlap. Each takes the next revision number as it
      // starts, so if an earlier one arrives at the server LAST it is a stale
      // write, gets the 200 no-op, and its points — which the newer batch never
      // carried — vanish with nothing thrown to requeue them. That is the same
      // silent loss this whole fix exists to remove, one level up. Leave the
      // points queued and let the timer take them after the flight lands.
      // `keepalive` is the unload path: there is no "later", so it proceeds.
      if (layoutInFlightRef.current > 0 && !keepalive) {
        layoutTimerRef.current = window.setTimeout(() => void flushLayout(), 350);
        return;
      }
      layoutInFlightRef.current += 1;
      layoutDirtyRef.current.clear();
      const revision = layoutRevisionRef.current + 1;
      layoutRevisionRef.current = revision;
      for (const [key] of pending) layoutSentRevisionRef.current.set(key, revision);
      const positions = pending.map(([key, point]) => {
        const separator = key.indexOf(':');
        return {
          itemKind: key.slice(0, separator),
          itemId: key.slice(separator + 1),
          x: point.x,
          y: point.y,
        };
      });
      try {
        await apiJson(endpoint(`/v1/projects/${encodeURIComponent(projectId)}/desk-layout`), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revision, positions }),
          keepalive,
        });
        layoutConflictRetriesRef.current = 0;
      } catch (error) {
        const requestError = error as Error & { status?: number; detail?: ApiErrorDetail };
        const conflictRevision = requestError.detail?.revision;
        const conflicted =
          requestError.status === 409 &&
          requestError.detail?.error === 'layout_rev_conflict' &&
          typeof conflictRevision === 'number';
        if (conflicted) {
          layoutRevisionRef.current = Math.max(layoutRevisionRef.current, conflictRevision);
        }
        for (const [key, point] of pending) {
          if (
            layoutSentRevisionRef.current.get(key) === revision &&
            !layoutDirtyRef.current.has(key)
          ) {
            layoutDirtyRef.current.set(key, point);
          }
        }
        // Retry ONLY a revision conflict, and only a bounded number of times.
        // A conflict is self-healing: we have just adopted the server's number,
        // so the next flush is strictly greater and wins. Any other failure —
        // API down, offline — must NOT re-arm a 350ms timer forever; that is an
        // unbounded retry loop with a receipt flashing on every pass. Those keep
        // the old behaviour: the points stay queued and go out with the next
        // move, or with the keepalive flush on unload.
        if (conflicted && layoutConflictRetriesRef.current < LAYOUT_CONFLICT_RETRY_LIMIT) {
          layoutConflictRetriesRef.current += 1;
          if (layoutTimerRef.current !== null) window.clearTimeout(layoutTimerRef.current);
          layoutTimerRef.current = window.setTimeout(() => void flushLayout(), 350);
          return;
        }
        setReceipt({ message: 'Не удалось сохранить расположение значков' });
      } finally {
        layoutInFlightRef.current = Math.max(0, layoutInFlightRef.current - 1);
      }
    },
    [endpoint, projectId],
  );

  const queueLayout = useCallback(
    (positions: Record<string, DeskLayoutPoint>) => {
      for (const [key, point] of Object.entries(positions)) {
        layoutDirtyRef.current.set(key, point);
      }
      if (layoutTimerRef.current !== null) window.clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = window.setTimeout(() => void flushLayout(), 350);
    },
    [flushLayout],
  );

  useEffect(() => {
    const plane = planeRef.current;
    if (!plane) return;
    const update = () =>
      setLayoutBounds({
        width: Math.max(108, plane.clientWidth - 80),
        height: Math.max(110, plane.clientHeight - 180),
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(plane);
    return () => observer.disconnect();
  }, [loading]);

  useEffect(() => {
    if (!layoutLoaded || itemKeys.length === 0 || layoutBounds.width <= 1) return;
    const resolved = resolveDeskLayout(itemKeys, layoutPositionsRef.current, layoutBounds);
    const changed = Object.fromEntries(
      Object.entries(resolved).filter(([key, point]) => {
        const previous = layoutPositionsRef.current[key];
        return !previous || previous.x !== point.x || previous.y !== point.y;
      }),
    );
    layoutPositionsRef.current = resolved;
    setLayoutPositions(resolved);
    if (Object.keys(changed).length > 0) queueLayout(changed);
  }, [itemKeys, layoutBounds, layoutLoaded, queueLayout]);

  useEffect(() => {
    const flush = () => void flushLayout(true);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      void flushLayout(true);
    };
  }, [flushLayout]);

  const placeDeskIcon = useCallback(
    (key: string, clientX: number, clientY: number) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const next = moveDeskItem(
        key,
        { x: clientX - rect.left - 54, y: clientY - rect.top - 55 },
        layoutPositionsRef.current,
        layoutBounds,
      );
      const moved = next[key];
      if (!moved) return;
      layoutPositionsRef.current = next;
      setLayoutPositions(next);
      queueLayout({ [key]: moved });
    },
    [layoutBounds, queueLayout],
  );

  const moveSelectedWithKeyboard = useCallback(
    (key: string, event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (
        !event.altKey ||
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      ) {
        return;
      }
      event.preventDefault();
      const current = layoutPositionsRef.current[key] ?? { x: 0, y: 0 };
      const delta = {
        x: event.key === 'ArrowLeft' ? -126 : event.key === 'ArrowRight' ? 126 : 0,
        y: event.key === 'ArrowUp' ? -136 : event.key === 'ArrowDown' ? 136 : 0,
      };
      const next = moveDeskItem(
        key,
        { x: current.x + delta.x, y: current.y + delta.y },
        layoutPositionsRef.current,
        layoutBounds,
      );
      const moved = next[key];
      if (!moved) return;
      layoutPositionsRef.current = next;
      setLayoutPositions(next);
      queueLayout({ [key]: moved });
    },
    [layoutBounds, queueLayout],
  );

  // Close either desk menu on any pointer press that lands outside a menu. Icons
  // stop click propagation, so relying on the plane's onClick alone would leave
  // the menu open when the user clicks another icon. Capture-phase so it beats
  // the icons' own handlers; menu items keep working because presses inside
  // `[data-desk-menu]` are ignored here (the item's own onClick runs the action).
  useEffect(() => {
    if (!folderMenu && !contextMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest('[data-desk-menu]')) return;
      setFolderMenu(null);
      setContextMenu(null);
      folderMenuTriggerRef.current = null;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [folderMenu, contextMenu]);

  // Both desk menus are positioned from raw pointer/anchor coordinates, so they
  // are pulled back inside the viewport once the browser has measured them.
  useLayoutEffect(() => {
    if (folderMenu && folderMenuRef.current) {
      clampMenuToViewport(folderMenuRef.current, folderMenu.x, folderMenu.y);
    }
  }, [folderMenu]);

  useLayoutEffect(() => {
    if (contextMenu && deskMenuRef.current) {
      clampMenuToViewport(deskMenuRef.current, contextMenu.x, contextMenu.y);
    }
  }, [contextMenu]);

  // A context menu takes focus so it can be driven entirely from the keyboard.
  useEffect(() => {
    if (!folderMenu || !folderMenuRef.current) return;
    menuItems(folderMenuRef.current)[0]?.focus();
  }, [folderMenu]);

  useEffect(() => {
    if (!contextMenu || !deskMenuRef.current) return;
    menuItems(deskMenuRef.current)[0]?.focus();
  }, [contextMenu]);

  const openFolderMenu = useCallback(
    (folder: FolderPayload, x: number, y: number, trigger: HTMLElement | null) => {
      folderMenuTriggerRef.current = trigger;
      setSelectedKey(`folder:${folder.id}`);
      setContextMenu(null);
      setFolderMenu({ folder, x, y });
    },
    [],
  );

  // Dismissing without choosing an action hands focus back to the icon. Choosing
  // an action does NOT restore it — that action's own dialog or window takes
  // focus, and stealing it back would fight their autofocus.
  const closeFolderMenu = useCallback((restoreFocus: boolean) => {
    setFolderMenu(null);
    const trigger = folderMenuTriggerRef.current;
    folderMenuTriggerRef.current = null;
    if (restoreFocus) {
      trigger?.focus();
      return;
    }
    // The action's own dialog takes focus next; remember the icon it came from
    // so closing that dialog can hand focus back rather than stranding it.
    deskDialogOpenerRef.current = trigger;
  }, []);

  // The generic desk menu is anchored to the plane, so dismissing it hands focus
  // back there. Running an action does not restore focus, for the same reason as
  // the folder menu: the dialog or file picker it opens owns focus next.
  const closeDeskMenu = useCallback((restoreFocus: boolean) => {
    setContextMenu(null);
    if (restoreFocus) planeRef.current?.focus();
  }, []);

  const onFolderMenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLMenuElement>) => handleMenuKeyDown(event, closeFolderMenu),
    [closeFolderMenu],
  );

  const onDeskMenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLMenuElement>) => handleMenuKeyDown(event, closeDeskMenu),
    [closeDeskMenu],
  );

  // Desktop convention: Enter (and Space) opens the selected icon, exactly like a
  // double click. Every desk object shares this so keyboard users can open media,
  // documents and system folders — not just user folders. Anything else falls
  // through to the Alt+Arrow move handler.
  const openSelectedWithKeyboard = useCallback(
    (key: string, open: () => void, event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        open();
        return;
      }
      // Media, document and system icons have no object menu, and pointer
      // right-click on them is already suppressed. Swallow the keyboard
      // equivalent too, or it bubbles to the plane and opens the unrelated
      // generic desk menu at a fixed position — the opposite of the mouse.
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      moveSelectedWithKeyboard(key, event);
    },
    [moveSelectedWithKeyboard],
  );

  const restoreDeskDialogFocus = useCallback(() => {
    const opener = deskDialogOpenerRef.current;
    deskDialogOpenerRef.current = null;
    window.requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
      else planeRef.current?.focus();
    });
  }, []);

  const closeFolderAction = useCallback(() => {
    setFolderAction(null);
    setFolderActionError(null);
    restoreDeskDialogFocus();
  }, [restoreDeskDialogFocus]);

  const closeNewFolderPrompt = useCallback(() => {
    setPendingNewFolder(null);
    restoreDeskDialogFocus();
  }, [restoreDeskDialogFocus]);

  // Keep every open folder window reachable when the viewport shrinks under it
  // (a resize can strand a window that was legally placed a moment earlier).
  useEffect(() => {
    const reclamp = () => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setWindowPositions((current) => {
        const next = { ...current };
        let changed = false;
        for (const [key, node] of windowNodes.current) {
          if (!node.isConnected) continue;
          const position = current[key] ?? { left: node.offsetLeft, top: node.offsetTop };
          const clamped = clampDeskWindowPosition(
            position,
            { width: node.offsetWidth, height: node.offsetHeight },
            viewport,
          );
          if (clamped.left === position.left && clamped.top === position.top) continue;
          next[key] = clamped;
          changed = true;
        }
        return changed ? next : current;
      });
    };
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const openWindow = useCallback(
    async (kind: DeskWindow['kind'], id?: string, name?: string) => {
      const key = kind === 'folder' ? `folder:${id}` : kind;
      setWindows((current) => {
        const existing = current.find((window) => window.key === key);
        if (existing) return [...current.filter((window) => window.key !== key), existing];
        if (kind === 'recents') {
          return [...current, { key, kind, name: 'Недавние', items: recents, loading: false }];
        }
        if (kind === 'folder') {
          return [
            ...current,
            { key, kind, folderId: id!, name: name!, items: [], loading: true, error: null },
          ];
        }
        return [
          ...current,
          {
            key,
            kind,
            name: 'Кадры',
            items: [],
            loading: false,
          },
        ];
      });
      if (kind !== 'folder' || !id) return;
      try {
        const items = await loadFolderItems(id);
        setWindows((current) =>
          current.map((window) =>
            window.key === key && window.kind === 'folder'
              ? { ...window, items, loading: false }
              : window,
          ),
        );
      } catch {
        setWindows((current) =>
          current.map((window) =>
            window.key === key && window.kind === 'folder'
              ? {
                  ...window,
                  loading: false,
                  error: 'Проверьте соединение и повторите попытку',
                }
              : window,
          ),
        );
      }
    },
    [loadFolderItems, recents],
  );

  const closeWindow = (key: string) =>
    setWindows((current) => current.filter((window) => window.key !== key));

  const finishDrag = useCallback(() => {
    setDrag(null);
    setActiveTarget(null);
  }, []);

  const leaveDropTarget = (event: React.DragEvent, key: string) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setActiveTarget((current) => (current === key ? null : current));
  };

  const missDrop = useCallback(() => {
    if (drag) setBounceGhost(drag);
    finishDrag();
    window.setTimeout(() => setBounceGhost(null), 420);
  }, [drag, finishDrag]);

  const runBatch = useCallback(
    async (files: File[], destination: DeskUploadDestination) => {
      const controller = new AbortController();
      const id = crypto.randomUUID();
      const label =
        destination.kind === 'folder'
          ? destination.name
          : destination.kind === 'new-folder'
            ? destination.name
            : 'На стол';
      setBatches((current) => [
        ...current,
        {
          id,
          files,
          destination,
          label,
          completed: 0,
          total: files.length,
          status: 'running',
          controller,
        },
      ]);
      try {
        const result = await runDeskUploadBatch({
          apiUrl: base,
          projectId,
          files: files as DeskUploadFile[],
          destination,
          signal: controller.signal,
          onProgress: (completed, total) =>
            setBatches((current) =>
              current.map((batch) => (batch.id === id ? { ...batch, completed, total } : batch)),
            ),
        });
        if (result.rejected.length > 0) {
          setShelfOpen(true);
          setBatches((current) =>
            current.map((batch) =>
              batch.id === id
                ? {
                    ...batch,
                    status: 'rejected',
                    message: `${result.rejected.length} отклонено: ${result.rejected.map((item) => `${item.name} — ${item.reason}`).join('; ')}`,
                  }
                : batch,
            ),
          );
          return;
        }
        setBatches((current) =>
          current.map((batch) =>
            batch.id === id
              ? {
                  ...batch,
                  status: 'done',
                  completed: files.length,
                  destinationId: result.destinationId,
                  receipts: result.receipts,
                }
              : batch,
          ),
        );
        const duplicateCount = result.receipts.filter((item) => item.reused).length;
        setReceipt({
          message:
            duplicateCount > 0
              ? `Готово · уже были в библиотеке: ${duplicateCount}`
              : 'Материалы загружены',
          destination: label,
          retentionReminder,
          ...(result.destinationId ? { folderId: result.destinationId } : {}),
        });
        await refreshDesk();
        window.setTimeout(
          () =>
            setBatches((current) =>
              current.filter((batch) => batch.id !== id || batch.status !== 'done'),
            ),
          5500,
        );
      } catch (error) {
        const cancelled = controller.signal.aborted;
        setShelfOpen(true);
        setBatches((current) =>
          current.map((batch) =>
            batch.id === id
              ? {
                  ...batch,
                  status: cancelled ? 'cancelled' : 'failed',
                  message: cancelled ? 'Загрузка отменена' : deskUploadErrorCopy(error),
                }
              : batch,
          ),
        );
        // Earlier files in a sequential batch may already be durable when a
        // later upload fails or the user cancels. Reconcile every open desk
        // surface so those successful receipts do not stay invisible.
        await refreshDesk().catch(() => {});
      }
    },
    [base, projectId, refreshDesk, retentionReminder],
  );

  const placeAsset = useCallback(
    async (
      asset: DeskAsset,
      folder: Pick<FolderPayload, 'id' | 'name'>,
      source?: { folderId: string; name: string },
    ) => {
      await apiJson(endpoint(`/v1/assets/${encodeURIComponent(asset.id)}/placements`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: folder.id, fromFolderId: source?.folderId }),
      });
      setReceipt({
        message: source ? 'Перемещено в папку' : 'Добавлено в папку',
        destination: folder.name,
        folderId: folder.id,
      });
      await refreshDesk();
    },
    [endpoint, refreshDesk],
  );

  const handleTargetDrop = useCallback(
    async (event: React.DragEvent, folder: FolderPayload) => {
      event.preventDefault();
      event.stopPropagation();
      const currentDrag =
        drag?.kind === 'external'
          ? { kind: 'external' as const, files: Array.from(event.dataTransfer.files) }
          : drag;
      finishDrag();
      if (!currentDrag) return;
      try {
        if (currentDrag.kind === 'asset') {
          await placeAsset(
            currentDrag.asset,
            folder,
            currentDrag.fromFolderId && currentDrag.fromFolderName
              ? { folderId: currentDrag.fromFolderId, name: currentDrag.fromFolderName }
              : undefined,
          );
        } else if (currentDrag.files.length > 0) {
          await runBatch(currentDrag.files, {
            kind: 'folder',
            folderId: folder.id,
            name: folder.name,
          });
        }
      } catch (error) {
        const detail = (error as Error & { detail?: { error?: string; limit?: number } }).detail;
        setReceipt({
          message:
            detail?.error === 'retention_quota_exceeded'
              ? `Лимит сохранённых материалов: ${detail.limit ?? 'исчерпан'}`
              : 'Не удалось разместить материал',
        });
      }
    },
    [drag, finishDrag, placeAsset, runBatch],
  );

  const confirmNewFolder = async () => {
    const validated = validateSredaFolderName(newFolderName);
    if (!validated.ok) {
      setReceipt({ message: validated.message });
      return;
    }
    const name = validated.name;
    if (!pendingNewFolder) return;
    const payload = pendingNewFolder;
    closeNewFolderPrompt();
    if (payload === 'empty') {
      try {
        const folder = await apiJson<FolderPayload>(
          endpoint(`/v1/projects/${encodeURIComponent(projectId)}/folders`),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          },
        );
        setReceipt({ message: 'Папка создана', destination: folder.name, folderId: folder.id });
        await refreshDesk();
      } catch {
        setReceipt({ message: 'Не удалось создать папку' });
      }
      return;
    }
    if (payload.kind === 'external') {
      await runBatch(payload.files, { kind: 'new-folder', name });
      return;
    }
    try {
      const result = await apiJson<{ folder: FolderPayload }>(
        endpoint(`/v1/assets/${encodeURIComponent(payload.asset.id)}/placements/new-folder`),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, name }),
        },
      );
      setReceipt({
        message: 'Папка создана с материалом',
        destination: result.folder.name,
        folderId: result.folder.id,
      });
      await refreshDesk();
    } catch {
      setReceipt({ message: 'Не удалось создать папку с материалом' });
    }
  };

  const navigateFolderWindow = useCallback(
    async (windowKey: string, folder: FolderPayload) => {
      setWindows((current) =>
        current.map((candidate) =>
          candidate.key === windowKey && candidate.kind === 'folder'
            ? {
                ...candidate,
                folderId: folder.id,
                name: folder.name,
                items: [],
                loading: true,
                error: null,
              }
            : candidate,
        ),
      );
      try {
        const items = await loadFolderItems(folder.id);
        setWindows((current) =>
          current.map((candidate) =>
            candidate.key === windowKey &&
            candidate.kind === 'folder' &&
            candidate.folderId === folder.id
              ? { ...candidate, items, loading: false, error: null }
              : candidate,
          ),
        );
      } catch {
        setWindows((current) =>
          current.map((candidate) =>
            candidate.key === windowKey &&
            candidate.kind === 'folder' &&
            candidate.folderId === folder.id
              ? {
                  ...candidate,
                  loading: false,
                  error: 'Проверьте соединение и повторите попытку',
                }
              : candidate,
          ),
        );
      }
    },
    [loadFolderItems],
  );

  const moveFolder = async (sourceId: string, parentId: string | null) => {
    const source = folders.find((folder) => folder.id === sourceId);
    if (!source || source.parentId === parentId || source.id === parentId) return;
    try {
      await apiJson<FolderPayload>(endpoint(`/v1/folders/${encodeURIComponent(source.id)}`), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentId, expectedVersion: source.version }),
      });
      await refreshDesk();
      setReceipt({
        message: parentId ? 'Папка перемещена' : 'Папка возвращена на стол проекта',
        ...((parentId ? folders.find((folder) => folder.id === parentId)?.name : project?.title)
          ? {
              destination: parentId
                ? folders.find((folder) => folder.id === parentId)!.name
                : project!.title,
            }
          : {}),
      });
    } catch (error) {
      await refreshDesk();
      const detail = (error as Error & { detail?: ApiErrorDetail }).detail;
      setReceipt({ message: folderMutationError(detail?.error) });
    }
  };

  const beginFolderAction = (action: FolderAction) => {
    // The context-menu path already recorded the folder icon; a folder-window
    // toolbar button is still mounted, so it can be read from the document.
    if (!deskDialogOpenerRef.current && document.activeElement instanceof HTMLElement) {
      deskDialogOpenerRef.current = document.activeElement;
    }
    setFolderAction(action);
    setFolderActionError(null);
    setFolderActionName(action.kind === 'rename' ? action.folder.name : '');
  };

  const submitFolderAction = async () => {
    if (!folderAction) return;
    setFolderActionError(null);
    try {
      if (folderAction.kind === 'create') {
        const validated = validateSredaFolderName(folderActionName);
        if (!validated.ok) {
          setFolderActionError(validated.message);
          return;
        }
        await apiJson<FolderPayload>(
          endpoint(`/v1/projects/${encodeURIComponent(projectId)}/folders`),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: validated.name, parentId: folderAction.parentId }),
          },
        );
        setReceipt({ message: 'Вложенная папка создана', destination: validated.name });
      } else if (folderAction.kind === 'rename') {
        const validated = validateSredaFolderName(folderActionName);
        if (!validated.ok) {
          setFolderActionError(validated.message);
          return;
        }
        await apiJson<FolderPayload>(
          endpoint(`/v1/folders/${encodeURIComponent(folderAction.folder.id)}`),
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: validated.name,
              expectedVersion: folderAction.folder.version,
            }),
          },
        );
        setReceipt({ message: 'Папка переименована', destination: validated.name });
      } else if (folderAction.kind === 'move') {
        await apiJson<FolderPayload>(
          endpoint(`/v1/folders/${encodeURIComponent(folderAction.folder.id)}`),
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              parentId: folderAction.targetId,
              expectedVersion: folderAction.folder.version,
            }),
          },
        );
        setReceipt({ message: 'Папка перемещена' });
      } else {
        const nonEmpty = folderAction.folder.count > 0 || folderAction.folder.childCount > 0;
        const query = new URLSearchParams({
          expectedVersion: String(folderAction.folder.version),
          ...(nonEmpty ? { recursive: 'true' } : {}),
        });
        await apiJson(
          endpoint(`/v1/folders/${encodeURIComponent(folderAction.folder.id)}?${query.toString()}`),
          { method: 'DELETE' },
        );
        setReceipt({
          message: nonEmpty
            ? 'Папка и вложенные папки удалены · материалы остались в проекте'
            : 'Папка удалена · материалы остались в проекте',
        });
      }
      closeFolderAction();
      await refreshDesk();
    } catch (error) {
      const detail = (error as Error & { detail?: ApiErrorDetail }).detail;
      setFolderActionError(folderMutationError(detail?.error));
      if (detail?.error === 'stale_folder' || detail?.error === 'not_found') {
        await refreshDesk().catch(() => {});
      }
    }
  };

  const handleFolderDrop = (event: React.DragEvent, parentId: string | null) => {
    const sourceId =
      folderDragId || event.dataTransfer.getData('application/x-sreda-folder') || null;
    if (!sourceId) return;
    event.preventDefault();
    event.stopPropagation();
    setFolderDragId(null);
    void moveFolder(sourceId, parentId);
  };

  const removePlacement = async (
    asset: DeskAsset,
    window: Extract<DeskWindow, { kind: 'folder' }>,
  ) => {
    await apiJson(
      endpoint(
        `/v1/assets/${encodeURIComponent(asset.id)}/placements/${encodeURIComponent(window.folderId)}`,
      ),
      {
        method: 'DELETE',
      },
    );
    setWindows(
      (current) =>
        current.map((candidate) =>
          candidate.key === window.key
            ? { ...candidate, items: candidate.items.filter((item) => item.id !== asset.id) }
            : candidate,
        ) as DeskWindow[],
    );
    setReceipt({
      message: 'Убрано из папки',
      destination: window.name,
      undo: async () => {
        await placeAsset(asset, { id: window.folderId, name: window.name });
        await openWindow('folder', window.folderId, window.name);
      },
    });
    await refreshDesk();
  };

  const deleteAsset = async (asset: DeskAsset) => {
    try {
      await apiJson(endpoint(`/v1/assets/${encodeURIComponent(asset.id)}`), { method: 'DELETE' });
      setWindows(
        (current) =>
          current.map((window) => ({
            ...window,
            items: window.items.filter((item) => item.id !== asset.id),
          })) as DeskWindow[],
      );
      setRecents((current) => current.filter((item) => item.id !== asset.id));
      await refreshDesk();
      setReceipt({
        message: 'Материал удалён',
        undo: async () => {
          await apiJson(endpoint(`/v1/assets/${encodeURIComponent(asset.id)}/restore`), {
            method: 'POST',
          });
          await refreshDesk();
        },
      });
    } catch (error) {
      const detail = (error as Error & { detail?: ApiErrorDetail }).detail;
      setReceipt({
        message: detail?.count
          ? `Нельзя удалить: используется в ${detail.count} местах`
          : 'Не удалось удалить материал',
        ...(detail?.usages ? { usages: detail.usages } : {}),
      });
    }
  };

  const onDeskDragEnter = (event: React.DragEvent) => {
    if (event.dataTransfer.types.includes('Files') && drag?.kind !== 'asset') {
      setDrag({ kind: 'external', files: [] });
      if (!(event.target as HTMLElement).closest('[data-desk-object], [data-desk-window]')) {
        setActiveTarget('desk');
      }
    }
  };

  const handleDeskDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const layoutKey = event.dataTransfer.getData('application/x-sreda-desk-layout');
    if (layoutKey) {
      event.stopPropagation();
      placeDeskIcon(layoutKey, event.clientX, event.clientY);
      setFolderDragId(null);
      finishDrag();
      return;
    }
    if (folderDragId || event.dataTransfer.getData('application/x-sreda-folder')) {
      handleFolderDrop(event, null);
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0 && drag?.kind !== 'asset') {
      finishDrag();
      void runBatch(files, { kind: 'unfiled' });
      return;
    }
    const assetId = event.dataTransfer.getData('application/x-sreda-asset');
    if (assetId) {
      const asset =
        (drag?.kind === 'asset' && drag.asset.id === assetId ? drag.asset : null) ??
        recents.find((item) => item.id === assetId) ??
        surfaceItems.find(
          (item): item is Extract<DeskSurfaceItem, { type: 'media' }> =>
            item.type === 'media' && item.asset.id === assetId,
        )?.asset;
      if (asset) {
        setBounceGhost({ kind: 'asset', asset });
        finishDrag();
        window.setTimeout(() => setBounceGhost(null), 420);
        return;
      }
    }
    missDrop();
  };

  const openRecentsWindow = useCallback(() => {
    const openedAt = new Date().toISOString();
    window.localStorage.setItem(`sreda:recents-opened:${projectId}`, openedAt);
    void openWindow('recents');
  }, [openWindow, projectId]);

  const ghostPayload = drag ?? bounceGhost;

  const openMedia = useCallback(
    (asset: DeskAsset) => {
      window.location.assign(
        `/workspace/${encodeURIComponent(projectId)}/media/${encodeURIComponent(asset.id)}`,
      );
    },
    [projectId],
  );

  const renderAssetGrid = (deskWindow: Extract<DeskWindow, { kind: 'folder' | 'recents' }>) => (
    <div className={styles.assetGrid}>
      {deskWindow.items.map((asset) => (
        <article
          className={styles.assetCard}
          draggable
          key={asset.id}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-sreda-asset', asset.id);
            setDrag(
              deskWindow.kind === 'folder'
                ? {
                    kind: 'asset',
                    asset,
                    fromFolderId: deskWindow.folderId,
                    fromFolderName: deskWindow.name,
                  }
                : { kind: 'asset', asset },
            );
            setPointer({ x: event.clientX, y: event.clientY });
          }}
          onDragEnd={finishDrag}
          data-testid={`asset-card-${asset.id}`}
        >
          <button
            className={styles.assetPreview}
            type="button"
            aria-label={`Открыть ${assetLabel(asset)}`}
            data-testid={`asset-preview-${asset.id}`}
            onDoubleClick={() => openMedia(asset)}
            // Tab reaches this control, so Enter/Space must open the asset.
            // Handled on keydown (not onClick) so a single POINTER click keeps
            // doing nothing — double click stays the pointer gesture.
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
              event.preventDefault();
              openMedia(asset);
            }}
          >
            {asset.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={assetSrc(asset.thumbnailUrl ?? asset.assetUrl)} alt="" />
            ) : asset.kind === 'video' ? (
              <video src={`${assetSrc(asset.assetUrl)}#t=0.1`} muted preload="metadata" />
            ) : (
              <DeskIcon name="music" />
            )}
          </button>
          <b>{assetLabel(asset)}</b>
          <span>
            {relativeTime(
              deskWindow.kind === 'recents' && 'addedAt' in asset ? asset.addedAt : asset.createdAt,
            )}{' '}
            · {asset.sourceLine ?? 'материал проекта'}
          </span>
          <span className={styles.usageLine}>
            Где используется: {asset.usage?.length ? asset.usage.join(' · ') : 'нигде'}
          </span>
          <div className={styles.assetActions}>
            <button type="button" onClick={() => openMedia(asset)}>
              Открыть
            </button>
            {deskWindow.kind === 'folder' && (
              <button type="button" onClick={() => void removePlacement(asset, deskWindow)}>
                Убрать из папки
              </button>
            )}
            <button type="button" onClick={() => void deleteAsset(asset)}>
              Удалить материал
            </button>
          </div>
        </article>
      ))}
    </div>
  );

  if (loading) return <main className={styles.centerState}>СОБИРАЕМ СТОЛ…</main>;
  if (loadError || !project) {
    return (
      <main className={styles.centerState}>
        <span>СТОЛ НЕДОСТУПЕН · {loadError ?? 'ПРОЕКТ НЕ НАЙДЕН'}</span>
        <Link href="/workspace">К проектам</Link>
      </main>
    );
  }

  return (
    <main
      ref={deskRef}
      className={cx(styles.desk, drag && styles.dragging, bounceGhost && styles.bounce)}
      data-testid="workspace-desk"
      onDragEnter={onDeskDragEnter}
      onDragOverCapture={(event) => {
        if (!drag && !event.dataTransfer.types.includes('application/x-sreda-desk-layout')) return;
        event.preventDefault();
        setPointer({ x: event.clientX, y: event.clientY });
      }}
      onDrop={handleDeskDrop}
      onDragLeave={(event) => {
        if (!deskRef.current?.contains(event.relatedTarget as Node | null)) finishDrag();
      }}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        // The dock keeps its native menu. Match buttons as well as links: the
        // resolving tiles are submit buttons now, and an `a`-only escape hatch
        // silently started suppressing their menu too.
        if (target.closest('[data-dock] a, [data-dock] button')) return;
        event.preventDefault();
        // A folder icon opens its own menu (handled on the icon, which stops
        // propagation); any other right-click dismisses it.
        setFolderMenu(null);
        if (target.closest('[data-desk-object], [data-desk-window]')) {
          setContextMenu(null);
          return;
        }
        if (target.closest('[data-desk-plane]')) {
          setContextMenu({ x: event.clientX, y: event.clientY });
          return;
        }
        setContextMenu(null);
      }}
    >
      <header className={styles.menubar}>
        {/* Owner ruling 2026-07-27: Среда is an OS, so you leave it by shutting
            it down, not through a side door. This is the ONLY way out, and it
            goes all the way out — to the site, not to the project list. The
            project list is part of Среда, reached from home's «Среда» tab. */}
        <Link className={styles.exitButton} href="/" data-testid="desk-exit">
          <DeskIcon name="exit" /> ВЫЙТИ
        </Link>
        <span className={styles.menuSeparator} aria-hidden="true" />
        <span className={styles.projectName}>{project.title}</span>
        <span className={styles.menuRight}>
          <SearchLauncher
            apiUrl={apiUrl}
            projectId={projectId}
            projectTitle={project.title}
            className={styles.deskSearch}
          />
          <span className={styles.credits}>
            {credits === null ? '—' : credits.toLocaleString('ru-RU')} КР
          </span>
          <div className={styles.shelfWrap}>
            {batches.length > 0 && (
              <button
                type="button"
                className={styles.shelfButton}
                data-testid="upload-shelf"
                onClick={() => setShelfOpen((value) => !value)}
              >
                <span className={styles.progressRing}>
                  {batches.some((batch) => batch.status === 'running') ? '↥' : '✓'}
                </span>
                {batches.filter((batch) => batch.status === 'running').length || batches.length}
              </button>
            )}
            {shelfOpen && batches.length > 0 && (
              <div className={styles.shelfPanel} data-testid="upload-shelf-panel">
                <div className={styles.shelfTitle}>ПОЛКА ЗАГРУЗОК</div>
                {batches.map((batch) => {
                  const regularFiles = regularBatchFiles(batch);
                  const duplicateFiles = duplicateBatchFiles(batch);
                  return (
                    <div className={styles.batchRow} key={batch.id}>
                      <div>
                        {regularFiles.length > 0 && (
                          <b>{regularFiles.map((file) => file.name).join(', ')}</b>
                        )}
                        {duplicateFiles.map(({ file, receipt }, index) => (
                          <span className={styles.batchReceipt} key={`${file.name}:${index}`}>
                            {file.name} — {receipt.receipt}
                          </span>
                        ))}
                        <span>
                          {batch.label} ·{' '}
                          {batch.status === 'running'
                            ? `${batch.completed}/${batch.total}`
                            : (batch.message ?? deskBatchStatusCopy(batch.status))}
                        </span>
                      </div>
                      <div className={styles.batchActions}>
                        {batch.status === 'running' && (
                          <button type="button" onClick={() => batch.controller.abort()}>
                            Отменить
                          </button>
                        )}
                        {(batch.status === 'failed' || batch.status === 'cancelled') && (
                          <button
                            type="button"
                            onClick={() => void runBatch(batch.files, batch.destination)}
                          >
                            Повторить
                          </button>
                        )}
                        {batch.destinationId && (
                          <button
                            type="button"
                            onClick={() =>
                              void openWindow('folder', batch.destinationId!, batch.label)
                            }
                          >
                            Открыть
                          </button>
                        )}
                        {batch.status === 'done' && batch.destination.kind === 'unfiled' && (
                          <button type="button" onClick={openRecentsWindow}>
                            Открыть
                          </button>
                        )}
                      </div>
                      <span
                        className={styles.progressBar}
                        style={{ width: `${(batch.completed / Math.max(1, batch.total)) * 100}%` }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <time className={styles.clock}>
            {new Intl.DateTimeFormat('ru-RU', {
              weekday: 'short',
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            }).format(clock)}
          </time>
        </span>
      </header>
      <input
        ref={fileInput}
        className={styles.hiddenInput}
        type="file"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) void runBatch(files, { kind: 'unfiled' });
        }}
      />

      <section
        ref={planeRef}
        className={styles.plane}
        data-desk-plane
        aria-label="Рабочий стол проекта"
        onClick={() => {
          setSelectedKey(null);
          setContextMenu(null);
          setFolderMenu(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setContextMenu(null);
            closeFolderMenu(true);
            return;
          }
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            setContextMenu({ x: 48, y: 92 });
          }
        }}
        tabIndex={0}
      >
        <div className={styles.watermark} aria-hidden="true">
          <span>VERTOV</span>
          <small>{project.title}</small>
        </div>
        {showDeskGuidance && (
          <aside
            className={styles.deskGuidance}
            aria-label="Коротко о столе проекта"
            data-testid="desk-first-run-guide"
          >
            <p>
              <b>Недавние</b> — последние добавленные материалы, <b>Кадры</b> — все материалы
              проекта. Внизу док: он открывает приложения проекта.
            </p>
            <button type="button" onClick={dismissDeskGuidance}>
              Понятно
            </button>
          </aside>
        )}
        {overflowLinks.length > 0 && (
          <aside
            className={styles.overflowNotices}
            aria-label="Продолжение списков проекта"
            data-testid="desk-overflow-notices"
          >
            {overflowLinks.map((link) => (
              <Link key={link.key} href={link.href} data-testid={`desk-overflow-${link.key}`}>
                Показаны первые 500 · Все в «{link.label}» →
              </Link>
            ))}
          </aside>
        )}
        <div
          ref={surfaceRef}
          className={styles.surfaceGrid}
          aria-label="Файлы и папки. Alt и стрелки перемещают выбранный значок."
          data-testid="desk-items"
        >
          <button
            type="button"
            className={cx(
              styles.deskIcon,
              styles.invalidTarget,
              selectedKey === 'recents' && styles.selected,
            )}
            onClick={(event) => {
              event.stopPropagation();
              setSelectedKey('recents');
            }}
            onDoubleClick={openRecentsWindow}
            draggable
            onDragStart={(event) =>
              event.dataTransfer.setData('application/x-sreda-desk-layout', 'system:recents')
            }
            onKeyDown={(event) =>
              openSelectedWithKeyboard('system:recents', openRecentsWindow, event)
            }
            style={iconPositionStyle(layoutPositions['system:recents'])}
            data-testid="recent-folder"
            data-desk-object
          >
            <FolderArt stamp="recents" />
            <span className={styles.iconLabel}>Недавние</span>
          </button>
          <button
            type="button"
            className={cx(
              styles.deskIcon,
              styles.invalidTarget,
              selectedKey === 'frames' && styles.selected,
            )}
            onClick={(event) => {
              event.stopPropagation();
              setSelectedKey('frames');
            }}
            onDoubleClick={() => void openWindow('frames')}
            draggable
            onDragStart={(event) =>
              event.dataTransfer.setData('application/x-sreda-desk-layout', 'system:frames')
            }
            onKeyDown={(event) =>
              openSelectedWithKeyboard('system:frames', () => void openWindow('frames'), event)
            }
            style={iconPositionStyle(layoutPositions['system:frames'])}
            data-testid="frames-folder"
            data-desk-object
          >
            <FolderArt stamp="frames" />
            <span className={styles.iconLabel}>Кадры</span>
          </button>
          {folderChildren(folders, null).map((folder) => (
            <button
              type="button"
              key={folder.id}
              draggable
              className={cx(
                styles.deskIcon,
                styles.validTarget,
                selectedKey === `folder:${folder.id}` && styles.selected,
                activeTarget === folder.id && styles.targetHot,
              )}
              onClick={(event) => {
                event.stopPropagation();
                setSelectedKey(`folder:${folder.id}`);
              }}
              onDoubleClick={() => void openWindow('folder', folder.id, folder.name)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('application/x-sreda-folder', folder.id);
                event.dataTransfer.setData(
                  'application/x-sreda-desk-layout',
                  `folder:${folder.id}`,
                );
                setFolderDragId(folder.id);
              }}
              onDragEnd={() => setFolderDragId(null)}
              onDragEnter={() => setActiveTarget(folder.id)}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => leaveDropTarget(event, folder.id)}
              onDrop={(event) => {
                if (folderDragId || event.dataTransfer.getData('application/x-sreda-folder')) {
                  handleFolderDrop(event, folder.id);
                  return;
                }
                void handleTargetDrop(event, folder);
              }}
              onKeyDown={(event) => {
                if (event.key === 'F2') {
                  event.preventDefault();
                  beginFolderAction({ kind: 'rename', folder });
                  return;
                }
                // Keyboard equivalent of a right click. Stop propagation so the
                // plane does not also open the generic desk menu behind it.
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault();
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  openFolderMenu(folder, rect.left + 12, rect.bottom - 8, event.currentTarget);
                  return;
                }
                openSelectedWithKeyboard(
                  `folder:${folder.id}`,
                  () => void openWindow('folder', folder.id, folder.name),
                  event,
                );
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openFolderMenu(folder, event.clientX, event.clientY, event.currentTarget);
              }}
              aria-haspopup="menu"
              aria-expanded={folderMenu?.folder.id === folder.id}
              style={iconPositionStyle(layoutPositions[`folder:${folder.id}`])}
              data-testid={`folder-target-${folder.id}`}
              data-desk-object
            >
              <FolderArt />
              <span className={styles.iconLabel}>{folder.name}</span>
            </button>
          ))}
          {surfaceItems.map((item) => {
            if (item.type === 'media') {
              const asset = item.asset;
              return (
                <button
                  type="button"
                  className={cx(
                    styles.deskIcon,
                    styles.surfaceItem,
                    styles.invalidTarget,
                    selectedKey === `media:${item.id}` && styles.selected,
                  )}
                  key={`media:${item.id}`}
                  draggable
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedKey(`media:${item.id}`);
                  }}
                  onDoubleClick={() => openMedia(asset)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData('application/x-sreda-asset', asset.id);
                    event.dataTransfer.setData(
                      'application/x-sreda-desk-layout',
                      `media:${item.id}`,
                    );
                    setDrag({ kind: 'asset', asset });
                    setPointer({ x: event.clientX, y: event.clientY });
                  }}
                  onDragEnd={finishDrag}
                  onKeyDown={(event) =>
                    openSelectedWithKeyboard(`media:${item.id}`, () => openMedia(asset), event)
                  }
                  style={iconPositionStyle(layoutPositions[`media:${item.id}`])}
                  data-testid={`desk-item-media-${item.id}`}
                  data-desk-object
                >
                  <FileArt kind="media" asset={asset} />
                  <span className={styles.iconLabel}>{assetLabel(asset)}</span>
                </button>
              );
            }
            return (
              <button
                type="button"
                className={cx(
                  styles.deskIcon,
                  styles.surfaceItem,
                  styles.invalidTarget,
                  selectedKey === `${item.type}:${item.id}` && styles.selected,
                )}
                key={`${item.type}:${item.id}`}
                draggable
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedKey(`${item.type}:${item.id}`);
                }}
                onDoubleClick={() =>
                  window.location.assign(`${item.href}?projectId=${encodeURIComponent(projectId)}`)
                }
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(
                    'application/x-sreda-desk-layout',
                    `${item.type}:${item.id}`,
                  );
                }}
                onKeyDown={(event) =>
                  openSelectedWithKeyboard(
                    `${item.type}:${item.id}`,
                    () =>
                      window.location.assign(
                        `${item.href}?projectId=${encodeURIComponent(projectId)}`,
                      ),
                    event,
                  )
                }
                style={iconPositionStyle(layoutPositions[`${item.type}:${item.id}`])}
                data-testid={`desk-item-${item.type}-${item.id}`}
                data-desk-object
              >
                <FileArt kind={item.type} />
                <span className={styles.iconLabel}>{item.title}</span>
              </button>
            );
          })}
        </div>

        <p className={styles.teaching} data-testid="empty-teaching">
          Перетащите файлы сюда ·{' '}
          <button type="button" onClick={() => fileInput.current?.click()}>
            Выбрать файлы
          </button>
        </p>

        {contextMenu && (
          <menu
            ref={deskMenuRef}
            className={styles.contextMenu}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
            aria-label="Действия на столе"
            onKeyDown={onDeskMenuKeyDown}
            data-testid="desk-context-menu"
            data-desk-menu
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                setPendingNewFolder('empty');
                setNewFolderName('');
              }}
            >
              <DeskIcon name="folder" /> Новая папка
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                fileInput.current?.click();
              }}
            >
              <DeskIcon name="upload" /> Добавить файлы…
            </button>
          </menu>
        )}

        {folderMenu && (
          <menu
            ref={folderMenuRef}
            className={styles.contextMenu}
            style={{ left: folderMenu.x, top: folderMenu.y }}
            role="menu"
            aria-label={`Действия с папкой «${folderMenu.folder.name}»`}
            onKeyDown={onFolderMenuKeyDown}
            data-testid="folder-context-menu"
            data-desk-menu
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const folder = folderMenu.folder;
                // Unlike the dialog actions, the window it opens takes no
                // focus of its own — hand focus back to the folder icon rather
                // than dropping it on <body>.
                closeFolderMenu(true);
                void openWindow('folder', folder.id, folder.name);
              }}
            >
              <DeskIcon name="folderOpen" /> Открыть
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="folder-menu-rename"
              onClick={() => {
                const folder = folderMenu.folder;
                closeFolderMenu(false);
                beginFolderAction({ kind: 'rename', folder });
              }}
            >
              <DeskIcon name="pen" /> Переименовать
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const folder = folderMenu.folder;
                closeFolderMenu(false);
                beginFolderAction({ kind: 'create', parentId: folder.id });
              }}
            >
              <DeskIcon name="folder" /> Новая вложенная папка
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const folder = folderMenu.folder;
                closeFolderMenu(false);
                beginFolderAction({ kind: 'move', folder, targetId: folder.parentId ?? null });
              }}
            >
              <DeskIcon name="network" /> Переместить…
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.contextMenuDanger}
              onClick={() => {
                const folder = folderMenu.folder;
                closeFolderMenu(false);
                beginFolderAction({ kind: 'delete', folder });
              }}
            >
              <DeskIcon name="close" /> Удалить папку
            </button>
          </menu>
        )}
      </section>

      <nav className={styles.dock} aria-label="Приложения" data-dock>
        {DOCK_LINKS.map(([key, app]) => {
          const tile = (
            <>
              <span className={styles.dockTip}>{app.name}</span>
              <DeskIcon name={app.icon} />
            </>
          );
          // Resolving a tile creates a document when the project has none, so it
          // must not be a GET — a state-changing GET gets prefetched, retried,
          // crawled and restored. The known cost: these three tiles are buttons,
          // so middle-click / ctrl-click no longer opens them in a new tab. An
          // <a href> that POSTs on click would be worse, because the middle-click
          // would then silently open the list instead of the work.
          if (isResolvableProjectProduct(key)) {
            return (
              <form
                key={key}
                className={styles.dockForm}
                action={projectResolverHref(key, projectId)}
                method="post"
              >
                <button
                  type="submit"
                  className={styles.dockTile}
                  aria-label={app.name}
                  data-testid={`dock-${key}`}
                >
                  {tile}
                </button>
              </form>
            );
          }
          return (
            <a
              key={key}
              href={projectListHref(key, projectId)}
              className={styles.dockTile}
              aria-label={app.name}
              data-testid={`dock-${key}`}
            >
              {tile}
            </a>
          );
        })}
      </nav>

      {drag?.kind === 'external' && activeTarget === 'desk' && (
        <div className={styles.deskDropHint} data-testid="desk-drop-target">
          <DeskIcon name="upload" />
          <b>НА СТОЛ</b>
          <span>Загрузить без папки</span>
        </div>
      )}

      {windows.map((deskWindow, index) => (
        <section
          key={deskWindow.key}
          ref={(node) => {
            if (node) windowNodes.current.set(deskWindow.key, node);
            else windowNodes.current.delete(deskWindow.key);
          }}
          className={cx(
            styles.folderWindow,
            deskWindow.kind === 'folder' && styles.validTarget,
            activeTarget === deskWindow.key && styles.targetHot,
            deskWindow.kind !== 'folder' && styles.invalidTarget,
          )}
          style={
            windowPositions[deskWindow.key] ?? {
              left: 440 + index * 34,
              top: 112 + index * 28,
            }
          }
          onDragEnter={() => deskWindow.kind === 'folder' && setActiveTarget(deskWindow.key)}
          onDragOver={(event) => deskWindow.kind === 'folder' && event.preventDefault()}
          onDragLeave={(event) => leaveDropTarget(event, deskWindow.key)}
          onDrop={(event) => {
            if (deskWindow.kind !== 'folder') return;
            if (folderDragId || event.dataTransfer.getData('application/x-sreda-folder')) {
              handleFolderDrop(event, deskWindow.folderId);
              return;
            }
            const folder = folders.find((item) => item.id === deskWindow.folderId);
            if (folder) void handleTargetDrop(event, folder);
          }}
          data-testid={`folder-window-${deskWindow.key}`}
          data-desk-window
        >
          <header
            className={styles.windowBar}
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest('button')) return;
              const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
              if (!bounds) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              movingWindow.current = {
                key: deskWindow.key,
                offsetX: event.clientX - bounds.left,
                offsetY: event.clientY - bounds.top,
              };
            }}
            onPointerMove={(event) => {
              const moving = movingWindow.current;
              if (moving?.key !== deskWindow.key) return;
              const node = event.currentTarget.parentElement;
              if (!node) return;
              const next = clampDeskWindowPosition(
                { left: event.clientX - moving.offsetX, top: event.clientY - moving.offsetY },
                { width: node.offsetWidth, height: node.offsetHeight },
                { width: window.innerWidth, height: window.innerHeight },
              );
              setWindowPositions((current) => ({ ...current, [deskWindow.key]: next }));
            }}
            onPointerUp={(event) => {
              if (movingWindow.current?.key !== deskWindow.key) return;
              event.currentTarget.releasePointerCapture(event.pointerId);
              movingWindow.current = null;
            }}
          >
            <DeskIcon name={deskWindow.kind === 'recents' ? 'clock' : 'folderOpen'} />
            {deskWindow.name}
            <span>
              {deskWindow.kind === 'recents'
                ? '· АВТО-ПАПКА'
                : deskWindow.kind === 'folder'
                  ? `· ${deskWindow.items.length} ФАЙЛОВ`
                  : '· СИСТЕМНЫЙ ВИД'}
            </span>
            <button type="button" onClick={() => closeWindow(deskWindow.key)} aria-label="Закрыть">
              <DeskIcon name="close" />
            </button>
          </header>
          {deskWindow.kind === 'frames' ? (
            <div className={styles.windowEmpty}>Выбранные дубли появятся здесь по сценам.</div>
          ) : deskWindow.kind === 'folder' ? (
            (() => {
              const currentFolder = folders.find((folder) => folder.id === deskWindow.folderId);
              if (!currentFolder) {
                return (
                  <div className={styles.folderError} role="alert">
                    Папка уже удалена или недоступна
                  </div>
                );
              }
              return (
                <SredaFolderBrowser
                  projectTitle={project.title}
                  folder={currentFolder}
                  folders={folders}
                  loading={deskWindow.loading}
                  error={deskWindow.error}
                  hasAssets={deskWindow.items.length > 0}
                  activeTarget={activeTarget}
                  onProjectRoot={() => closeWindow(deskWindow.key)}
                  onNavigate={(folder) => void navigateFolderWindow(deskWindow.key, folder)}
                  onCreate={() => beginFolderAction({ kind: 'create', parentId: currentFolder.id })}
                  onRename={(folder) => beginFolderAction({ kind: 'rename', folder })}
                  onMove={() =>
                    beginFolderAction({
                      kind: 'move',
                      folder: currentFolder,
                      targetId: currentFolder.parentId,
                    })
                  }
                  onDelete={() => beginFolderAction({ kind: 'delete', folder: currentFolder })}
                  onRetry={() => void navigateFolderWindow(deskWindow.key, currentFolder)}
                  onFolderDragStart={(event, folder) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-sreda-folder', folder.id);
                    setFolderDragId(folder.id);
                  }}
                  onFolderDragEnd={() => {
                    setFolderDragId(null);
                    setActiveTarget(null);
                  }}
                  onFolderDragEnter={(folder) => setActiveTarget(folder.id)}
                  onFolderDrop={(event, target) => handleFolderDrop(event, target.id)}
                >
                  {deskWindow.items.length > 0 ? renderAssetGrid(deskWindow) : null}
                </SredaFolderBrowser>
              );
            })()
          ) : deskWindow.loading ? (
            <div className={styles.windowEmpty}>ЧИТАЕМ ПАПКУ…</div>
          ) : deskWindow.items.length === 0 ? (
            <div className={styles.windowEmpty}>Пока пусто</div>
          ) : (
            renderAssetGrid(deskWindow)
          )}
          {drag && deskWindow.kind !== 'folder' && (
            <span className={styles.windowReason}>АВТО · РУКАМИ НЕЛЬЗЯ</span>
          )}
        </section>
      ))}

      {ghostPayload &&
        (() => {
          const visual = ghostVisual(ghostPayload);
          return (
            <div
              className={styles.dragGhost}
              style={{ left: pointer.x + 18, top: pointer.y + 18 }}
              data-testid="drag-verb"
            >
              <span className={styles.ghostFile}>
                <span className={styles.ghostFileFold} aria-hidden="true" />
                <DeskIcon name={visual.icon} />
                <small className={styles.ghostType}>{visual.badge}</small>
              </span>
              <span className={styles.ghostVerb}>
                {ghostPayload.kind === 'external' ? 'Загрузить' : 'Добавить в папку'}
              </span>
              <b className={styles.ghostName}>
                {ghostPayload.kind === 'asset'
                  ? assetLabel(ghostPayload.asset)
                  : `${ghostPayload.files.length || '…'} ФАЙЛОВ`}
              </b>
            </div>
          );
        })()}

      {/* The pointer half of the modality the two prompts below claim with
          `aria-modal`. Swallowing mousedown keeps focus inside the dialog
          instead of dropping it on <body>; there is no click-to-dismiss, so an
          accidental outside click cannot lose a half-typed folder name. */}
      {(folderAction || pendingNewFolder) && (
        <div
          className={styles.promptScrim}
          aria-hidden="true"
          data-testid="desk-dialog-scrim"
          onMouseDown={(event) => event.preventDefault()}
        />
      )}

      {folderAction && (
        <form
          ref={folderActionRef}
          className={styles.namePrompt}
          role="dialog"
          aria-modal="true"
          aria-labelledby="folder-action-title"
          data-testid={`folder-action-${folderAction.kind}`}
          onKeyDown={(event) =>
            handleModalKeyDown(event, folderActionRef.current, closeFolderAction)
          }
          onSubmit={(event) => {
            event.preventDefault();
            void submitFolderAction();
          }}
        >
          <label id="folder-action-title" htmlFor="folder-action-value">
            {folderAction.kind === 'create'
              ? 'НОВАЯ ВЛОЖЕННАЯ ПАПКА'
              : folderAction.kind === 'rename'
                ? 'ПЕРЕИМЕНОВАТЬ ПАПКУ'
                : folderAction.kind === 'move'
                  ? 'КУДА ПЕРЕМЕСТИТЬ ПАПКУ'
                  : 'УДАЛИТЬ ПАПКУ'}
          </label>
          {folderAction.kind === 'create' || folderAction.kind === 'rename' ? (
            <input
              id="folder-action-value"
              autoFocus
              value={folderActionName}
              onChange={(event) => {
                setFolderActionName(event.target.value);
                setFolderActionError(null);
              }}
              maxLength={100}
              aria-invalid={folderActionError ? true : undefined}
            />
          ) : folderAction.kind === 'move' ? (
            <select
              id="folder-action-value"
              autoFocus
              value={folderAction.targetId ?? '__project_root__'}
              onChange={(event) =>
                setFolderAction({
                  ...folderAction,
                  targetId: event.target.value === '__project_root__' ? null : event.target.value,
                })
              }
            >
              {folderMoveTargets(folders, folderAction.folder.id).map((target) => (
                <option
                  key={target?.id ?? '__project_root__'}
                  value={target?.id ?? '__project_root__'}
                >
                  {target ? target.name : `Стол проекта · ${project.title}`}
                </option>
              ))}
            </select>
          ) : (
            <p className={styles.folderDeleteWarning}>
              {folderAction.folder.childCount > 0 || folderAction.folder.count > 0
                ? `Будут удалены эта папка, ${folderAction.folder.childCount} вложенных папок и размещения файлов. Сами материалы останутся в библиотеке проекта.`
                : 'Папка пуста. Сами материалы останутся в библиотеке проекта.'}
            </p>
          )}
          {folderActionError && (
            <p className={styles.folderActionError} role="alert">
              {folderActionError}
            </p>
          )}
          <div>
            <button
              type="submit"
              disabled={
                (folderAction.kind === 'create' || folderAction.kind === 'rename') &&
                !folderActionName.trim()
              }
            >
              {folderAction.kind === 'delete' ? 'Удалить папку' : 'Сохранить'}
            </button>
            <button type="button" onClick={closeFolderAction}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {pendingNewFolder && (
        <form
          ref={newFolderRef}
          className={styles.namePrompt}
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-folder-title"
          data-testid="new-folder-prompt"
          onKeyDown={(event) =>
            handleModalKeyDown(event, newFolderRef.current, closeNewFolderPrompt)
          }
          onSubmit={(event) => {
            event.preventDefault();
            void confirmNewFolder();
          }}
        >
          <label id="new-folder-title" htmlFor="new-folder-name">
            НАЗВАНИЕ НОВОЙ ПАПКИ
          </label>
          <input
            id="new-folder-name"
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            maxLength={100}
          />
          <div>
            <button type="submit" disabled={!newFolderName.trim()}>
              {pendingNewFolder === 'empty' ? 'Создать' : 'Создать с файлом'}
            </button>
            <button type="button" onClick={closeNewFolderPrompt}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {receipt && (
        <aside className={styles.receipt} data-testid="desk-receipt">
          <div className={styles.receiptCopy}>
            <b>{receipt.message}</b>
            {receipt.retentionReminder && (
              <span className={styles.retentionReminder} data-testid="retention-reminder">
                {receipt.retentionReminder}
              </span>
            )}
            {receipt.usages?.map((usage) => (
              <span
                className={styles.usageLine}
                data-testid="delete-refusal-usage"
                key={`${usage.type}:${usage.refId}`}
              >
                {ASSET_USAGE_LABELS[usage.type] ?? usage.type} · {usage.refId}
              </span>
            ))}
          </div>
          {receipt.destination && (
            <span className={styles.destinationBadge}>{receipt.destination}</span>
          )}
          {receipt.folderId && (
            <button
              type="button"
              onClick={() =>
                void openWindow('folder', receipt.folderId!, receipt.destination ?? 'Папка')
              }
            >
              Открыть
            </button>
          )}
          {receipt.undo && (
            <button
              type="button"
              onClick={() => void receipt.undo?.().then(() => setReceipt(null))}
            >
              Отменить
            </button>
          )}
          <button type="button" onClick={() => setReceipt(null)} aria-label="Закрыть">
            <DeskIcon name="close" />
          </button>
        </aside>
      )}

      {/* HackerNoon Pixel Icon Library, CC BY 4.0 — inline SVGs adapted from the approved v12 desk mock. */}
      <small className={styles.attribution}>HackerNoon Pixel Icons · CC BY 4.0</small>
    </main>
  );
}
