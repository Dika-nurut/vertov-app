'use client';

import { useRef, useState } from 'react';
import {
  CircleNotch,
  FilmSlate,
  MusicNote,
  Plus,
  UploadSimple,
  X,
} from '@phosphor-icons/react/dist/ssr';
import { uploadMediaFile } from '../../lib/upload';

type Kind = 'image' | 'video' | 'audio';
export interface ReferenceMediaItem {
  id: string;
  url: string;
}

const mediaKinds: {
  kind: Kind;
  accept: string;
  hint: (limit: number) => string;
  label: string;
  name: string;
}[] = [
  {
    kind: 'image',
    accept: 'image/*',
    hint: (limit) => `до ${limit} фото`,
    label: 'фото',
    name: 'Фото',
  },
  { kind: 'video', accept: 'video/*', hint: () => 'видео', label: 'видео', name: 'Видео' },
  { kind: 'audio', accept: 'audio/*', hint: () => 'звук', label: 'звук', name: 'Звук' },
];

export interface MediaLimits {
  image: number;
  video: number;
  audio: number;
}

function acceptedKinds(limits: MediaLimits) {
  return mediaKinds.filter(({ kind }) => limits[kind] > 0);
}

/** The short list shared by the picker hint and the required-input copy. */
export function acceptedReferenceKinds(limits: MediaLimits): string {
  const names = acceptedKinds(limits).map(({ label }) => label);
  if (names.length < 2) return names[0] ?? '';
  if (names.length === 2) return names.join(' или ');
  return `${names.slice(0, -1).join(', ')} или ${names.at(-1)}`;
}

export function referenceRequiredCopy(limits: MediaLimits): string {
  const kinds = acceptedReferenceKinds(limits);
  return kinds ? `Добавь референс — ${kinds}.` : 'Добавь референс.';
}

/** Whether the reference requirement is met by a kind this drop zone accepts. */
export function hasAcceptedReferenceMedia(
  limits: MediaLimits,
  media: { images: string[]; videos: string[]; audios: string[] },
): boolean {
  return (
    (limits.image > 0 && media.images.length > 0) ||
    (limits.video > 0 && media.videos.length > 0) ||
    (limits.audio > 0 && media.audios.length > 0)
  );
}

function kindOf(file: File): Kind | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio';
  return null;
}

/**
 * One combined drop zone for the picked model's media inputs — accepts image /
 * video / audio and files each by type into the right bucket behind the scenes.
 *
 * The zone is bounded by the MODEL, not by a fixed constant: `limits` comes from
 * the selected card's declared capacity, so a keyframe model offers only its
 * one/two frame slots and a text-to-video model isn't offered a drop zone at
 * all. No headline — the instruction lives inside the drop area.
 */
export function ReferenceDropZone({
  apiUrl,
  assetSrc,
  images,
  videos,
  audios,
  onChange,
  limits,
  role,
}: {
  apiUrl: string;
  assetSrc: (url: string) => string;
  images: ReferenceMediaItem[];
  videos: ReferenceMediaItem[];
  audios: ReferenceMediaItem[];
  onChange: (next: {
    images: ReferenceMediaItem[];
    videos: ReferenceMediaItem[];
    audios: ReferenceMediaItem[];
  }) => void;
  /** Per-kind capacity of the picked model. A kind at 0 is not accepted. */
  limits: MediaLimits;
  /** What the attached stills MEAN: keyframe anchors, or style/cast references. */
  role: 'frame' | 'reference';
}) {
  const imagesOnly = limits.image > 0 && limits.video === 0 && limits.audio === 0;
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [rejectedKind, setRejectedKind] = useState<Kind | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function addFiles(files: File[]) {
    if (!files.length) return;
    setRejectedKind(null);
    setBusy(true);
    const next = { image: [...images], video: [...videos], audio: [...audios] };
    for (const file of files) {
      const k = kindOf(file);
      if (!k) continue;
      if (limits[k] === 0) {
        setRejectedKind(k);
        continue;
      }
      if (next[k].length >= limits[k]) continue;
      const url = await uploadMediaFile(apiUrl, file);
      if (url) next[k].push({ id: crypto.randomUUID(), url });
    }
    setBusy(false);
    onChange({ images: next.image, videos: next.video, audios: next.audio });
  }

  function remove(kind: Kind, id: string) {
    const next = { image: [...images], video: [...videos], audio: [...audios] };
    next[kind] = next[kind].filter((item) => item.id !== id);
    onChange({ images: next.image, videos: next.video, audios: next.audio });
  }

  const tiles: { kind: Kind; id: string; url: string }[] = [
    ...images.map((item) => ({ kind: 'image' as const, ...item })),
    ...videos.map((item) => ({ kind: 'video' as const, ...item })),
    ...audios.map((item) => ({ kind: 'audio' as const, ...item })),
  ];
  const full =
    images.length >= limits.image && videos.length >= limits.video && audios.length >= limits.audio;
  // Copy names the INPUT the picked card takes — the card and the zone must say
  // the same thing, or "which model does what" is guesswork again.
  const title =
    role === 'frame'
      ? limits.image > 1
        ? 'Первый и последний кадр'
        : 'Первый кадр'
      : imagesOnly
        ? 'Изображение-референс'
        : 'Референсы';
  const accepted = acceptedKinds(limits);
  const hint =
    role === 'frame'
      ? 'фото · необязательно · перетащи'
      : imagesOnly
        ? 'необязательно · стиль и композиция'
        : accepted.map(({ hint, kind }) => hint(limits[kind])).join(' · ');

  return (
    <div className="space-y-2.5">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accepted.map(({ accept }) => accept).join(',')}
        className="hidden"
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <div
        role="button"
        data-testid="reference-dropzone"
        data-role={role}
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        onPaste={(e) => void addFiles(Array.from(e.clipboardData.files ?? []))}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void addFiles(Array.from(e.dataTransfer.files ?? []));
        }}
        className={
          // Shrunk to a thin strip (Layout A): the dock is one-screen, no room
          // for a big drop area — icon + two-line label, all on one row.
          'flex cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] border-2 border-dashed px-3 py-2.5 text-left transition-colors ' +
          (drag
            ? 'border-[color:var(--color-accent)] bg-[rgba(var(--accent-rgb),0.08)]'
            : 'border-[color:var(--color-line)]/55 bg-[color:var(--color-surface2)] hover:border-[color:var(--color-line)]')
        }
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-xs)] bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)]">
          {busy ? <CircleNotch size={16} className="seed-spin" /> : <UploadSimple size={16} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-[color:var(--color-fg)]">{title}</span>
          <span className="block truncate font-mono text-[11px] uppercase tracking-wide text-[color:var(--color-faint)]">
            {hint}
          </span>
        </span>
      </div>

      {rejectedKind && (
        <p role="status" className="text-[11px] text-[color:var(--color-muted-foreground)]">
          {mediaKinds.find(({ kind }) => kind === rejectedKind)!.name} не поддерживается выбранной
          моделью.
        </p>
      )}

      {tiles.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tiles.map((t) => (
            <div
              key={t.id}
              className="group relative h-14 w-14 overflow-hidden rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-bg)]"
            >
              {t.kind === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={assetSrc(t.url)} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="grid h-full w-full place-items-center text-[color:var(--color-muted-foreground)]">
                  {t.kind === 'video' ? (
                    <FilmSlate size={18} weight="bold" />
                  ) : (
                    <MusicNote size={18} weight="bold" />
                  )}
                </span>
              )}
              <button
                type="button"
                aria-label="Убрать"
                onClick={() => remove(t.kind, t.id)}
                className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-[var(--radius-xs)] bg-[color:var(--color-bg)]/80 text-[color:var(--color-fg)] opacity-0 transition-opacity group-hover:opacity-100 touch:opacity-100"
              >
                <X size={12} weight="bold" />
              </button>
            </div>
          ))}
          {!full && (
            <button
              type="button"
              aria-label="Добавить ещё"
              onClick={() => inputRef.current?.click()}
              className="press-inset grid h-14 w-14 place-items-center rounded-[var(--radius-xs)] border-2 border-dashed border-[color:var(--color-line)]/55 text-[color:var(--color-muted-foreground)] transition-colors hover:border-[color:var(--color-line)] hover:text-[color:var(--color-fg)]"
            >
              <Plus size={18} weight="bold" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
