// Library media panel — local-import dropzone + source bin + render history
// (extracted from StudioClient.tsx, split 5i/N). The most coupled panel; all
// state/handlers are injected (media-import, addClip/addPip, timeline, history).
import { assetSrc } from '@/lib/asset-src';
import { Loader2, UploadCloud } from '../_icons';
import { SourceTile } from '../_components/SourceTile';
import { useStudioProjectHref } from '../_project-context';
import type { RenderHistoryItem, StudioClip, TClip } from '../_model';

export function MediaPanel({
  setDragOver,
  dragOver,
  onDropFiles,
  importing,
  upload,
  clips,
  timeline,
  addClip,
  addPip,
  history,
}: {
  setDragOver: (v: boolean) => void;
  dragOver: boolean;
  onDropFiles: (files: FileList | null) => void;
  importing: boolean;
  upload: { pct: number; name: string } | null;
  clips: StudioClip[];
  timeline: TClip[];
  addClip: (url: string, assetId?: string) => void;
  addPip: (url: string, assetId?: string) => void;
  history: RenderHistoryItem[];
}) {
  const generateHref = useStudioProjectHref('/generate');
  return (
    <div className="space-y-6">
      {/* Always-available local import — a labelled file input that
                  doubles as a drop target, mirroring the empty-stage uploader. */}
      <label
        data-testid="media-upload"
        data-tour-target="studio-upload"
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
          'flex cursor-pointer flex-col items-center gap-1.5 rounded-[var(--radius-md)] border-2 border-dashed p-4 text-center transition-colors ' +
          (dragOver
            ? 'border-[color:var(--color-accent)] bg-[rgba(var(--accent-rgb),0.08)]'
            : 'border-[color:var(--color-line)]/55 hover:border-[color:var(--color-line)]')
        }
      >
        <span className="grid h-9 w-9 place-items-center rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] text-[color:var(--color-fg)] ring-1 ring-inset ring-[color:var(--color-line)]/15">
          {importing ? <Loader2 size={16} className="seed-spin" /> : <UploadCloud size={16} />}
        </span>
        <span className="text-[13px] font-semibold text-[color:var(--color-fg)]">
          {importing ? `Загружаем… ${upload?.pct ?? 0}%` : 'Загрузить видео'}
        </span>
        {importing ? (
          <span className="mt-0.5 h-1 w-full max-w-[180px] overflow-hidden rounded-[var(--radius-xs)] bg-[color:var(--color-surface2)]">
            <span
              className="block h-full rounded-[var(--radius-xs)] bg-[color:var(--color-accent)] transition-[width] duration-200"
              style={{ width: `${upload?.pct ?? 0}%` }}
            />
          </span>
        ) : (
          <span className="text-[11px] text-[color:var(--color-faint)]">
            Перетащи или выбери MP4 / MOV / WebM — до 8 ГБ
          </span>
        )}
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
      <section>
        <p className="label-eyebrow mb-3">Клипы ({clips.length})</p>
        {clips.length === 0 ? (
          <div className="glass rounded-[var(--radius-md)] p-5 text-[13px] leading-relaxed text-[color:var(--color-faint)]">
            Загрузи видео выше — или сгенерируй его на странице «Создать», и оно появится здесь.
            <a
              href={generateHref}
              data-testid="media-panel-generate"
              className="mt-3 block text-[color:var(--color-accent)]"
            >
              → К генерации
            </a>
          </div>
        ) : (
          <div className="grid max-h-[300px] grid-cols-2 gap-2 overflow-y-auto pr-1">
            {clips.map((c) => (
              <SourceTile
                key={c.id}
                assetUrl={c.assetUrl}
                added={timeline.some((t) => t.url === c.assetUrl)}
                onAdd={() => void addClip(c.assetUrl, c.id)}
                onPip={() => void addPip(c.assetUrl, c.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3" data-testid="render-history">
        <p className="label-eyebrow">История рендеров</p>
        {history.length === 0 ? (
          <p className="text-[13px] text-[color:var(--color-faint)]">Пока нет рендеров</p>
        ) : (
          <ul className="seed-scroll max-h-[220px] space-y-1.5 overflow-y-auto pr-1">
            {history.map((h) => (
              <li
                key={h.id}
                data-testid="history-item"
                className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border-[1.5px] border-[color:var(--color-line)] px-2.5 py-1.5 text-[13px]"
              >
                <span className="truncate text-[color:var(--color-muted-foreground)]">
                  {h.status === 'succeeded'
                    ? 'Готово'
                    : h.status === 'failed'
                      ? 'Ошибка'
                      : h.status === 'canceled'
                        ? 'Отменён'
                        : h.status === 'running'
                          ? 'Рендер...'
                          : 'В очереди'}
                </span>
                {h.resultUrl ? (
                  <a
                    href={assetSrc(h.resultUrl)}
                    download
                    data-testid="history-download"
                    className="shrink-0 text-[color:var(--color-accent)] hover:underline"
                  >
                    Скачать
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
