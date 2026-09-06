'use client';

import { createContext, useContext, useEffect, useRef } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Clapperboard,
  Film,
  FileText,
  Image as ImageIcon,
  MapPin,
  Play,
  Sparkles,
  StickyNote,
  Type,
  LayoutGrid,
  User,
} from '@/components/ui/icons';
import { assetSrc } from '@/lib/asset-src';
import { withProjectContext } from '@/lib/project-context';
import type {
  AiPromptData,
  CastData,
  GenerateData,
  MediaData,
  NoteData,
  PromptData,
  SceneData,
  FrameData,
  TextData,
} from './types';
import { isVideoUrl } from './types';

/**
 * Read-oriented node cards for the MOBILE board. These are a SEPARATE,
 * simplified rendering of the same node data the desktop canvas uses — no inline
 * editors, no resize handles, no hover affordances; just a legible card you can
 * pan around and tap. A contextual action may launch an already-prepared shot;
 * editing stays desktop-only. Distinct from the desktop node components.
 */

/**
 * React Flow node components take no props of their own, so the already
 * validated workspace context reaches the source link this way. Without it the
 * mobile link drops `?projectId=…` that the desktop link preserves.
 */
export const MobileBoardProjectContext = createContext<string | null>(null);

const STATUS_LABEL: Record<string, string> = {
  idle: 'не снят',
  running: 'идёт…',
  done: 'готово',
  failed: 'ошибка',
};
const STATUS_CLASS: Record<string, string> = {
  idle: 'text-[color:var(--color-faint)]',
  running: 'text-[color:var(--color-accent)]',
  done: 'text-[color:var(--color-accent2)]',
  failed: 'text-[color:var(--color-destructive)]',
};

function ResultVideo(props: React.ComponentProps<'video'>) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || typeof IntersectionObserver === 'undefined') return;
    // This is a controlled player, not an autoplay preview: only pause when it
    // leaves view, never resume it or change its current playback position.
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

function port(side: 'left' | 'right', type: 'target' | 'source') {
  return (
    <Handle
      type={type}
      position={side === 'left' ? Position.Left : Position.Right}
      isConnectable={false}
      className="!h-2 !w-2 !border-2 !border-[color:var(--color-line)] !bg-[color:var(--color-surface2)]"
    />
  );
}

function Shell({
  selected,
  label,
  icon,
  width = 150,
  children,
  ports = true,
}: {
  selected?: boolean;
  label: string;
  icon: React.ReactNode;
  width?: number;
  children: React.ReactNode;
  ports?: boolean;
}) {
  return (
    <div
      style={{ width }}
      className={
        'overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] bg-[color:var(--color-surface)] shadow-[3px_3px_0_0_var(--color-shadow)] ' +
        (selected
          ? 'border-[color:var(--color-accent)] shadow-[3px_3px_0_0_var(--color-accent)]'
          : 'border-[color:var(--color-line)]')
      }
    >
      {ports && port('left', 'target')}
      <div className="flex items-center gap-1.5 border-b-2 border-[color:var(--color-line)] px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.05em] text-[color:var(--color-muted-foreground)]">
        {icon}
        {label}
      </div>
      {children}
      {ports && port('right', 'source')}
    </div>
  );
}

const ICON = { sz: 11 } as const;

export function PromptNode({ data, selected }: NodeProps) {
  const d = data as unknown as PromptData;
  return (
    <Shell selected={selected} label="Промпт" icon={<StickyNote size={ICON.sz} />}>
      <p className="line-clamp-3 px-2 py-1.5 text-[11px] leading-snug text-[color:var(--color-fg)]">
        {d.text || <span className="text-[color:var(--color-faint)]">Пустой промпт</span>}
      </p>
    </Shell>
  );
}

export function AiPromptNode({ data, selected }: NodeProps) {
  const d = data as unknown as AiPromptData;
  const body = d.view === 'result' && d.text ? d.text : d.brief;
  return (
    <Shell selected={selected} label="AI-промпт" icon={<Sparkles size={ICON.sz} />}>
      <p className="line-clamp-3 px-2 py-1.5 text-[11px] leading-snug text-[color:var(--color-fg)]">
        {body || <span className="text-[color:var(--color-faint)]">Бриф пуст</span>}
      </p>
    </Shell>
  );
}

export function NoteNode({ data, selected }: NodeProps) {
  const d = data as unknown as NoteData;
  return (
    <Shell selected={selected} label="Заметка" icon={<StickyNote size={ICON.sz} />} ports={false}>
      <p className="line-clamp-4 px-2 py-1.5 text-[11px] leading-snug text-[color:var(--color-fg)]">
        {d.text || <span className="text-[color:var(--color-faint)]">Заметка</span>}
      </p>
    </Shell>
  );
}

export function TextNode({ data, selected }: NodeProps) {
  const d = data as unknown as TextData;
  const size = d.size === 'l' ? 'text-[16px]' : d.size === 's' ? 'text-[11px]' : 'text-[13px]';
  return (
    <Shell
      selected={selected}
      label="Текст"
      icon={<Type size={ICON.sz} />}
      ports={false}
      width={178}
    >
      <p className={`px-2 py-2 leading-snug text-[color:var(--color-fg)] ${size}`}>
        {d.text || <span className="text-[color:var(--color-faint)]">Пустой текст</span>}
      </p>
    </Shell>
  );
}

export function FrameNode({ data, selected }: NodeProps) {
  const d = data as unknown as FrameData;
  return (
    <Shell
      selected={selected}
      label="Рамка"
      icon={<LayoutGrid size={ICON.sz} />}
      ports={false}
      width={220}
    >
      <div className="min-h-[86px] bg-[rgba(var(--accent-rgb),0.08)] px-2 py-2">
        <p className="font-display text-[13px] font-black text-[color:var(--color-fg)]">
          {d.title || 'Рамка'}
        </p>
        <p className="mt-1 text-[11px] uppercase tracking-wide text-[color:var(--color-faint)]">
          Группа борда · только чтение
        </p>
      </div>
    </Shell>
  );
}

export function SceneNode({ data, selected }: NodeProps) {
  const d = data as unknown as SceneData;
  const projectId = useContext(MobileBoardProjectContext);
  const sourceHref = d.sourceScriptId
    ? projectId
      ? withProjectContext(`/scenario/${encodeURIComponent(d.sourceScriptId)}`, projectId)
      : `/scenario/${encodeURIComponent(d.sourceScriptId)}`
    : null;
  return (
    <Shell
      selected={selected}
      label="Сцена"
      icon={<FileText size={ICON.sz} />}
      ports={false}
      width={178}
    >
      <div data-testid="mobile-scene-node" className="px-2 py-1.5">
        <p className="truncate text-[11px] font-semibold text-[color:var(--color-fg)]">
          {d.title || 'Без заголовка'}
        </p>
        {d.synopsis && (
          <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-[color:var(--color-muted-foreground)]">
            {d.synopsis}
          </p>
        )}
        <p className="mt-1 font-mono text-[11px] uppercase text-[color:var(--color-faint)]">
          {d.sourceStatus === 'removed' ? 'удалена в сценарии' : `сцена ${d.sourceOrdinal ?? '—'}`}
        </p>
        {sourceHref && (
          <a
            href={sourceHref}
            className="nodrag mt-1 block font-mono text-[11px] uppercase text-[color:var(--color-accent)] underline"
          >
            Сценарий · сцена {d.sourceOrdinal ?? '—'}
          </a>
        )}
      </div>
    </Shell>
  );
}

export function MediaNode({ data, selected }: NodeProps) {
  const d = data as unknown as MediaData;
  const isVid = d.mediaKind === 'video' || (d.url && isVideoUrl(d.url));
  return (
    <Shell
      selected={selected}
      label={isVid ? 'Видео' : 'Изображение'}
      icon={isVid ? <Film size={ICON.sz} /> : <ImageIcon size={ICON.sz} />}
    >
      <div className="relative grid aspect-video place-items-center bg-[color:var(--color-bg)]">
        {d.url && !isVid ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assetSrc(d.url)} alt="" className="h-full w-full object-cover" />
        ) : isVid && d.url ? (
          <>
            <video
              src={assetSrc(d.url)}
              muted
              playsInline
              preload="metadata"
              className="h-full w-full object-cover"
            />
            <Play size={18} className="absolute text-white/90" />
          </>
        ) : (
          <ImageIcon size={18} className="text-white/25" />
        )}
      </div>
    </Shell>
  );
}

export function CastNode({ data, selected }: NodeProps) {
  const d = data as unknown as CastData;
  const cover = d.imageUrls?.[0];
  return (
    <Shell
      selected={selected}
      label={d.castKind === 'location' ? 'Локация' : 'Персонаж'}
      icon={d.castKind === 'location' ? <MapPin size={ICON.sz} /> : <User size={ICON.sz} />}
      width={138}
    >
      <div className="flex items-center gap-2 px-2 py-2">
        <span className="h-8 w-8 shrink-0 overflow-hidden rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)]">
          {cover && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={assetSrc(cover)} alt="" className="h-full w-full object-cover" />
          )}
        </span>
        <span className="truncate text-[13px] font-semibold text-[color:var(--color-fg)]">
          {d.name || 'Без имени'}
        </span>
      </div>
    </Shell>
  );
}

export function GenerateNode({ data, selected }: NodeProps) {
  const d = data as unknown as GenerateData;
  const status = d.status ?? 'idle';
  const cover = d.resultUrl;
  const coverIsVid = d.resultKind === 'video' || (cover && isVideoUrl(cover));
  return (
    <Shell
      selected={selected}
      label={`Кадр · ${d.mode === 'image' ? 'изображение' : 'видео'}`}
      icon={<Clapperboard size={ICON.sz} />}
      width={156}
    >
      <div className="relative grid aspect-video place-items-center bg-[color:var(--color-bg)]">
        {cover && !coverIsVid ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assetSrc(cover)} alt="" className="h-full w-full object-cover" />
        ) : cover && coverIsVid ? (
          <>
            <ResultVideo
              src={`${assetSrc(cover)}#t=0.1`}
              muted
              playsInline
              controls
              preload="metadata"
              className="nodrag h-full w-full object-cover"
            />
            <Play size={18} className="nodrag pointer-events-none absolute text-white/90" />
          </>
        ) : (
          <Clapperboard size={18} className="text-white/20" />
        )}
      </div>
      <div className="flex items-center justify-between gap-1 px-2 py-1">
        <span className={'font-mono text-[11px] font-bold uppercase ' + STATUS_CLASS[status]}>
          {STATUS_LABEL[status]}
        </span>
        {!!d.prompt && (
          <span className="truncate text-[11px] text-[color:var(--color-faint)]">
            {d.prompt.slice(0, 24)}
          </span>
        )}
      </div>
    </Shell>
  );
}

export const MOBILE_NODE_TYPES = {
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
