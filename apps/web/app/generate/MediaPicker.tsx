'use client';

import { useEffect, useRef, useState } from 'react';
import {
  UploadSimple as Upload,
  X,
  ImageSquare as ImageIcon,
  FilmSlate as Film,
  MusicNote as Music,
  CircleNotch as Loader2,
  Link as Link2,
  ArrowsOut as Maximize2,
  ArrowsClockwise as RefreshCw,
} from '@phosphor-icons/react/dist/ssr';
import { assetSrc } from '@/lib/asset-src';

type Kind = 'image' | 'video' | 'audio';

const EXT_ACCEPT: Record<Kind, string> = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/quicktime,video/webm',
  audio: 'audio/mpeg,audio/mp4,audio/wav,audio/ogg',
};

interface GalleryClip {
  id: string;
  assetUrl: string;
}
export interface MediaPickerItem {
  id: string;
  url: string;
}

/**
 * Reusable reference-media picker for the generate screen. Lets the user add
 * URLs either from their own gallery (image/video) or by uploading a file
 * (image/video/audio). Controlled: value is a list of public asset URLs.
 */
export function MediaPicker({
  kind,
  label,
  max,
  value,
  onChange,
  apiUrl,
  hint,
}: {
  kind: Kind;
  label: string;
  max: number;
  value: MediaPickerItem[];
  onChange: (items: MediaPickerItem[]) => void;
  apiUrl: string;
  /** One-line "why this reference" microcopy shown under the label. */
  hint?: string;
}) {
  const [browseOpen, setBrowseOpen] = useState(false);
  const [clips, setClips] = useState<GalleryClip[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);
  // When set, the next upload REPLACES value[replaceIdx] instead of appending.
  const replaceIdx = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const Icon = kind === 'image' ? ImageIcon : kind === 'video' ? Film : Music;

  useEffect(() => {
    if (!browseOpen || clips !== null || kind === 'audio') return;
    (async () => {
      try {
        const r = await fetch(`${apiUrl}/v1/studio/clips?kind=${kind}`, { credentials: 'include' });
        const b = await r.json();
        setClips(b.clips ?? []);
      } catch {
        setClips([]);
      }
    })();
  }, [browseOpen, clips, kind, apiUrl]);

  const add = (url: string) => {
    if (value.length >= max) return;
    onChange([...value, { id: crypto.randomUUID(), url }]);
  };
  const remove = (id: string) => onChange(value.filter((entry) => entry.id !== id));

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? '').toLowerCase();
      const r = await fetch(`${apiUrl}/v1/studio/upload?ext=${ext}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      if (!r.ok) throw new Error(String(r.status));
      const b = await r.json();
      const idx = replaceIdx.current;
      if (idx != null && idx >= 0 && idx < value.length) {
        const next = [...value];
        next[idx] = { ...next[idx]!, url: b.url };
        onChange(next);
      } else {
        add(b.url);
      }
    } catch {
      /* surfaced by empty add */
    } finally {
      replaceIdx.current = null;
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div data-testid={`media-picker-${kind}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[13px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-muted-foreground)]">
            {label}
          </span>
          <span className="tnum text-[11px] text-[color:var(--color-faint)]">
            ({value.length}/{max})
          </span>
        </span>
        <button
          type="button"
          onClick={() => setLinkOpen((o) => !o)}
          disabled={value.length >= max}
          className="flex items-center gap-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-fg)] disabled:opacity-40"
        >
          <Link2 size={13} /> По ссылке
        </button>
      </div>

      {/* Why this reference — one quiet line so each slot explains itself. */}
      {hint && <p className="-mt-1 mb-2 text-[11px] text-[color:var(--color-faint)]">{hint}</p>}

      {linkOpen && value.length < max && (
        <form
          className="mb-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const u = linkUrl.trim();
            if (/^https?:\/\//i.test(u)) {
              add(u);
              setLinkUrl('');
              setLinkOpen(false);
            }
          }}
        >
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://… (изображение ≥300px)"
            className="min-w-0 flex-1 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 py-1.5 text-[13px] text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-faint)] focus:border-[color:var(--color-accent)]"
          />
          <button
            type="submit"
            className="press shrink-0 rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)]"
          >
            Добавить
          </button>
        </form>
      )}

      <div className="flex flex-wrap gap-2">
        {value.map((entry, i) => (
          <div
            key={entry.id}
            className="group relative h-16 w-16 overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-black"
          >
            {kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={assetSrc(entry.url)} alt="" className="h-full w-full object-cover" />
            ) : kind === 'video' ? (
              <video
                src={`${assetSrc(entry.url)}#t=0.1`}
                muted
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="grid h-full w-full place-items-center">
                <Music size={18} className="text-[color:var(--color-muted-foreground)]" />
              </div>
            )}
            {/* ordinal — maps to the @imageN / @videoN / @audioN reference token */}
            <span className="tnum absolute left-0 top-0 grid h-4 min-w-4 place-items-center rounded-br-[var(--radius-xs)] bg-[color:var(--color-accent)] px-1 text-[11px] font-semibold text-[color:var(--color-primary-foreground)]">
              {i + 1}
            </span>
            {/* hover action bar: zoom · replace · delete */}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/80 py-1 opacity-0 transition-opacity group-hover:opacity-100 touch:opacity-100">
              {kind !== 'audio' && (
                <button
                  type="button"
                  onClick={() => setZoomUrl(entry.url)}
                  aria-label="Увеличить"
                  title="Увеличить"
                  className="text-white/80 transition-colors hover:text-white"
                >
                  <Maximize2 size={12} />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  replaceIdx.current = i;
                  fileRef.current?.click();
                }}
                aria-label="Заменить"
                title="Заменить"
                className="text-white/80 transition-colors hover:text-white"
              >
                <RefreshCw size={12} />
              </button>
              <button
                type="button"
                onClick={() => remove(entry.id)}
                aria-label="Убрать"
                title="Убрать"
                className="text-white/80 transition-colors hover:text-destructive"
              >
                <X size={13} />
              </button>
            </div>
          </div>
        ))}

        {value.length < max && (
          <>
            {kind !== 'audio' && (
              <button
                type="button"
                onClick={() => setBrowseOpen((o) => !o)}
                data-testid={`pick-${kind}`}
                className="grid h-16 w-16 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-dashed border-[color:var(--color-line)] text-[color:var(--color-muted-foreground)] transition-colors hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-fg)]"
                title="Из архива"
              >
                <Icon size={18} />
              </button>
            )}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="grid h-16 w-16 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-dashed border-[color:var(--color-line)] text-[color:var(--color-muted-foreground)] transition-colors hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-fg)]"
              title="Загрузить"
            >
              {uploading ? <Loader2 size={16} className="seed-spin" /> : <Upload size={16} />}
            </button>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={EXT_ACCEPT[kind]}
          onChange={onUpload}
          className="hidden"
        />
      </div>

      {browseOpen && kind !== 'audio' && (
        <div className="mt-2 max-h-44 overflow-y-auto rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-2 shadow-[3px_3px_0_0_var(--color-shadow)]">
          {clips === null ? (
            <p className="p-2 text-[13px] text-[color:var(--color-faint)]">Загрузка…</p>
          ) : clips.length === 0 ? (
            <p className="p-2 text-[13px] text-[color:var(--color-faint)]">
              В архиве пока нет {kind === 'image' ? 'изображений' : 'видео'}.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {clips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  data-testid="gallery-pick"
                  onClick={() => {
                    add(c.assetUrl);
                    setBrowseOpen(false);
                  }}
                  className="aspect-square overflow-hidden rounded-[var(--radius-xs)] border-[2.5px] border-[color:var(--color-line)] bg-black transition-colors hover:border-[color:var(--color-accent)]"
                >
                  {kind === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={assetSrc(c.assetUrl)} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <video
                      src={`${assetSrc(c.assetUrl)}#t=0.1`}
                      muted
                      className="h-full w-full object-cover"
                    />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Zoom lightbox */}
      {zoomUrl && (
        <div
          role="dialog"
          aria-label="Просмотр"
          onClick={() => setZoomUrl(null)}
          className="seed-fade-up fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
        >
          <button
            type="button"
            aria-label="Закрыть"
            className="press absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-[color:var(--color-fg)] shadow-[3px_3px_0_0_var(--color-shadow)] hover:bg-[color:var(--color-surface2)]"
          >
            <X size={18} />
          </button>
          {kind === 'video' ? (
            <video
              src={assetSrc(zoomUrl)}
              controls
              autoPlay
              className="max-h-[85vh] max-w-[85vw] rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)]"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={assetSrc(zoomUrl)}
              alt=""
              className="max-h-[85vh] max-w-[85vw] rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </div>
  );
}
