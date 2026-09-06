// Preview empty/upload stage — the entry point shown before the first clip
// lands (extracted from StudioClient.tsx, split 5l/N).
import { assetSrc } from '@/lib/asset-src';
import { FolderOpen, Loader2, Plus, Sparkles, UploadCloud } from '../_icons';
import { FORMATS } from '../_model';
import { useStudioProjectHref } from '../_project-context';
import type { Format, StudioClip } from '../_model';

export function EmptyStage({
  dragOver,
  setDragOver,
  onDropFiles,
  importing,
  upload,
  cancelUpload,
  clips,
  addClip,
  format,
  setFormat,
}: {
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  onDropFiles: (files: FileList | null) => void;
  importing: boolean;
  upload: { pct: number; name: string } | null;
  cancelUpload: () => void;
  clips: StudioClip[];
  addClip: (url: string, assetId?: string) => void;
  format: Format;
  setFormat: (f: Format) => void;
}) {
  const generateHref = useStudioProjectHref('/generate');
  return (
    <div
      data-testid="upload-stage"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDropFiles(e.dataTransfer.files);
      }}
      className={
        // Fills the WHOLE preview plate (no nested box). The drop target is the
        // entire area; it only lights up on drag — no second framed box at rest.
        'relative flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-6 rounded-[var(--radius-md)] p-6 text-center ring-2 ring-inset transition-colors ' +
        (dragOver
          ? 'bg-[rgba(var(--accent-rgb),0.06)] ring-[color:var(--color-accent)]'
          : 'ring-transparent')
      }
    >
      <div className="shrink-0">
        <p className="label-eyebrow mb-2.5 text-[color:var(--color-faint)]">Студия · Vertov</p>
        <h2 className="flex items-center justify-center gap-2.5 font-display text-[clamp(20px,2.6vw,28px)] font-black uppercase leading-[1.04] tracking-[-0.01em] text-[color:var(--color-fg)]">
          {importing && <Loader2 size={24} className="seed-spin" />}
          {importing ? `Загружаем… ${upload?.pct ?? 0}%` : 'Перетащи видео сюда'}
        </h2>
        <p className="mx-auto mt-1.5 max-w-sm truncate font-mono text-[13px] leading-snug text-[color:var(--color-faint)]">
          {importing ? (upload?.name ?? '') : 'MP4, MOV или WebM, до 8 ГБ'}
        </p>
      </div>

      {importing ? (
        <div className="w-full max-w-sm space-y-2.5">
          <div className="h-1.5 w-full overflow-hidden rounded-[var(--radius-xs)] bg-[color:var(--color-surface2)]">
            <div
              data-testid="upload-progress"
              className="h-full rounded-[var(--radius-xs)] bg-[color:var(--color-accent)] transition-[width] duration-200"
              style={{ width: `${upload?.pct ?? 0}%` }}
            />
          </div>
          <button
            type="button"
            data-testid="upload-cancel"
            onClick={cancelUpload}
            className="press-inset rounded-[var(--radius-sm)] px-4 py-1.5 text-[13px] font-semibold text-[color:var(--color-muted-foreground)] ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:text-[color:var(--color-fg)]"
          >
            Отменить
          </button>
        </div>
      ) : (
        /* Numbered «Плиты» — the three entry routes, mirroring the generate
           empty-state grammar. The last tile carries the single lime spark. */
        <ol className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
          {/* 01 — drop / pick from device */}
          <li className="flex flex-col rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-5 text-left shadow-[5px_5px_0_0_var(--color-shadow)]">
            <span
              className="tnum grid h-12 w-12 shrink-0 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] font-display text-[20px] font-black shadow-[3px_3px_0_0_var(--color-shadow)]"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-primary-foreground)',
              }}
            >
              01
            </span>
            <div className="mt-auto pt-6">
              <UploadCloud size={28} weight="bold" className="mb-3 text-[color:var(--color-fg)]" />
              <h3 className="font-display text-[16px] font-black uppercase leading-tight tracking-[-0.01em] text-[color:var(--color-fg)]">
                С устройства
              </h3>
              <label
                data-testid="upload-local"
                className="glass-accent mt-3 inline-flex h-9 cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-4 text-[13px] font-semibold"
              >
                <FolderOpen size={15} /> Выбрать файл
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    onDropFiles(e.target.files);
                    e.currentTarget.value = '';
                  }}
                />
              </label>
            </div>
          </li>

          {/* 02 — pick from projects (only when there are clips) */}
          <li className="flex flex-col rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-5 text-left shadow-[5px_5px_0_0_var(--color-shadow)]">
            <span
              className="tnum grid h-12 w-12 shrink-0 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] font-display text-[20px] font-black shadow-[3px_3px_0_0_var(--color-shadow)]"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-primary-foreground)',
              }}
            >
              02
            </span>
            <div className="mt-auto pt-6">
              <Plus size={28} weight="bold" className="mb-3 text-[color:var(--color-fg)]" />
              <h3 className="font-display text-[16px] font-black uppercase leading-tight tracking-[-0.01em] text-[color:var(--color-fg)]">
                Из проектов
              </h3>
              {clips.length > 0 ? (
                <div className="seed-scroll mt-3 flex gap-2 overflow-x-auto pb-1">
                  {clips.slice(0, 12).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      data-testid="upload-project-clip"
                      onClick={() => void addClip(c.assetUrl, c.id)}
                      title="Добавить на таймлайн"
                      className="group relative aspect-video h-14 shrink-0 overflow-hidden rounded-[var(--radius-sm)] border-[1.5px] border-[color:var(--color-line)] bg-black transition-colors hover:border-[color:var(--color-accent)]"
                    >
                      <video
                        src={`${assetSrc(c.assetUrl)}#t=0.1`}
                        muted
                        preload="metadata"
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                        <Plus size={16} className="text-white" />
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 font-mono text-[13px] leading-snug text-[color:var(--color-faint)]">
                  Пока пусто
                </p>
              )}
            </div>
          </li>

          {/* 03 — generate on platform (the single lime spark) */}
          <li className="flex flex-col rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-5 text-left shadow-[5px_5px_0_0_var(--color-shadow)]">
            <span
              className="tnum grid h-12 w-12 shrink-0 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] font-display text-[20px] font-black shadow-[3px_3px_0_0_var(--color-shadow)]"
              style={{
                background: 'var(--color-accent2)',
                color: 'var(--color-accent2-foreground)',
              }}
            >
              03
            </span>
            <div className="mt-auto pt-6">
              <Sparkles size={28} weight="bold" className="mb-3 text-[color:var(--color-fg)]" />
              <h3 className="font-display text-[16px] font-black uppercase leading-tight tracking-[-0.01em] text-[color:var(--color-fg)]">
                Сгенерировать
              </h3>
              <a
                href={generateHref}
                data-testid="upload-generate"
                className="glass glass-hover mt-3 inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] px-4 text-[13px] font-semibold text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
              >
                <Sparkles size={15} /> На платформе
              </a>
            </div>
          </li>
        </ol>
      )}

      {/* Aspect-ratio choice, available before the first clip lands. */}
      <div
        className={
          'flex flex-wrap items-center justify-center gap-1.5 ' +
          (importing ? 'pointer-events-none opacity-40' : '')
        }
      >
        <span className="label-eyebrow text-[color:var(--color-faint)]">Формат</span>
        {FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            data-testid={`upload-ratio-${f.id}`}
            onClick={() => setFormat(f)}
            className={
              'rounded-[var(--radius-sm)] px-3 py-1 text-[11px] font-semibold ring-1 ring-inset transition-colors ' +
              (f.id === format.id
                ? 'bg-[color:var(--color-surface2)] text-[color:var(--color-fg)] ring-[color:var(--color-accent)]'
                : 'text-[color:var(--color-muted-foreground)] ring-[color:var(--color-line)]/15 hover:text-[color:var(--color-fg)]')
            }
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}
