// Studio header (Zone: Header S1) — the fixed app bar: back-to-projects link,
// project title + save indicator, and the export cluster (settings popover with
// cover-frame/platform-presets/res/fps/format, the export button, and the
// cancel-render button while a render is in flight). Extracted VERBATIM from
// StudioClient (§C continuation); purely presentational — handlers/state in.
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { withProjectContext } from '@/lib/project-context';
import { FolderOpen, Settings2, Loader2, Film, X } from '../_icons';
import { SaveIndicator, type SaveState } from '../../_components/SaveIndicator';
import { PortalMenu } from '../_kit/PortalMenu';
import { Row, Seg } from '../_kit/controls';
import { fmt, FORMATS } from '../_model';
import type { Format, ExportPhase, TClip } from '../_model';

export function StudioHeader({
  projectTitle,
  save,
  exportBtnRef,
  exportOpen,
  setExportOpen,
  playhead,
  totalDur,
  setFormat,
  exportRes,
  setExportRes,
  exportFps,
  setExportFps,
  exportFmt,
  setExportFmt,
  onExport,
  timeline,
  busy,
  phase,
  cancelRender,
  isAnonymous = false,
  workspaceProjectId,
}: {
  projectTitle: string | undefined;
  save: { state: SaveState; retry: () => void };
  exportBtnRef: React.RefObject<HTMLButtonElement | null>;
  exportOpen: boolean;
  setExportOpen: React.Dispatch<React.SetStateAction<boolean>>;
  playhead: number;
  totalDur: number;
  setFormat: (f: Format) => void;
  exportRes: '720' | '1080' | '1440' | '2160';
  setExportRes: React.Dispatch<React.SetStateAction<'720' | '1080' | '1440' | '2160'>>;
  exportFps: '24' | '25' | '30' | '50' | '60';
  setExportFps: React.Dispatch<React.SetStateAction<'24' | '25' | '30' | '50' | '60'>>;
  exportFmt: 'mp4' | 'mov';
  setExportFmt: React.Dispatch<React.SetStateAction<'mp4' | 'mov'>>;
  onExport: () => void;
  timeline: TClip[];
  busy: boolean;
  phase: ExportPhase;
  cancelRender: (renderId: string) => void;
  isAnonymous?: boolean;
  workspaceProjectId?: string | undefined;
}) {
  const pathname = usePathname();
  // In project mode the list this returns to is the PROJECT's montage list;
  // dropping the id here silently ejected the editor out of Среда (the «← НА
  // СТОЛ» pill disappears once ProjectContextProvider clears the session).
  // Standalone Studio has no id and stays standalone.
  const projectsHref = workspaceProjectId
    ? withProjectContext('/studio/projects', workspaceProjectId)
    : '/studio/projects';
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b-[1.5px] border-[color:var(--color-line)] px-4">
      <div className="flex min-w-0 items-center gap-3">
        {/* Way back to the projects gallery; the editor's content autosaves.
            Guests have no project list — back exits to the landing instead
            (guest-CJM decision, 2026-07-09). */}
        <Link
          href={isAnonymous ? '/' : projectsHref}
          data-testid="studio-to-projects"
          title={isAnonymous ? 'На главную' : 'Все проекты'}
          aria-label={isAnonymous ? 'На главную' : 'Все проекты'}
          className="glass glass-hover grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-fg)]"
        >
          <FolderOpen size={16} />
        </Link>
        <span
          className="truncate font-display text-[15px] font-medium tracking-tight text-[color:var(--color-fg)]"
          data-testid="studio-project-title"
        >
          {projectTitle ?? 'Монтаж'}
        </span>
        <SaveIndicator state={save.state} onRetry={save.retry} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {/* Aspect ratio now lives on the canvas (CapCut, subsystem A); the
          header app bar stays clean. */}
        <div className="relative inline-flex items-center gap-1">
          <button
            ref={exportBtnRef}
            type="button"
            data-testid="export-settings"
            title="Настройки экспорта"
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            onClick={() => setExportOpen((v) => !v)}
            className="glass glass-hover grid h-11 w-11 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            <Settings2 size={16} />
          </button>
          <PortalMenu
            anchorRef={exportBtnRef}
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            width="w-64"
            testid="export-settings-pop"
          >
            <div className="space-y-3 p-1.5">
              {/* S7: cover-frame = the frame under the playhead at export. */}
              <div className="flex items-center justify-between">
                <span className="label-eyebrow text-[color:var(--color-faint)]">Обложка</span>
                <span
                  data-testid="cover-time"
                  className="tnum font-mono text-[11px] text-[color:var(--color-muted-foreground)]"
                >
                  кадр {fmt(Math.max(0, Math.min(playhead, totalDur)))}
                </span>
              </div>
              {/* S7: social presets — one tap sets ratio + resolution + fps. */}
              <div>
                <span className="label-eyebrow text-[color:var(--color-faint)]">Платформа</span>
                <div className="mt-1 grid grid-cols-2 gap-1.5">
                  {(
                    [
                      { id: 'tiktok', label: 'TikTok', fmt: '9:16', res: '1080' },
                      { id: 'reels', label: 'Reels', fmt: '9:16', res: '1080' },
                      { id: 'shorts', label: 'Shorts', fmt: '9:16', res: '1080' },
                      { id: 'youtube', label: 'YouTube', fmt: '16:9', res: '1080' },
                    ] as const
                  ).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      data-testid={`preset-${p.id}`}
                      onClick={() => {
                        const f = FORMATS.find((x) => x.id === p.fmt);
                        if (f) setFormat(f);
                        setExportRes(p.res);
                        setExportFps('30');
                        setExportFmt('mp4');
                      }}
                      className="press-inset rounded-[var(--radius-xs)] bg-[color:var(--color-surface2)] px-2 py-1.5 text-[11px] font-semibold text-[color:var(--color-muted-foreground)] ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:text-[color:var(--color-fg)]"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <Row label="Разрешение (короткая сторона)">
                <Seg
                  value={exportRes}
                  onChange={setExportRes}
                  options={[
                    { id: '720', label: '720' },
                    { id: '1080', label: '1080' },
                    { id: '1440', label: '1440' },
                    { id: '2160', label: '4K' },
                  ]}
                />
              </Row>
              <Row label="Кадров/с">
                <Seg
                  value={exportFps}
                  onChange={setExportFps}
                  options={(['24', '25', '30', '50', '60'] as const).map((f) => ({
                    id: f,
                    label: f,
                  }))}
                />
              </Row>
              <Row label="Формат">
                <Seg
                  value={exportFmt}
                  onChange={setExportFmt}
                  options={[
                    { id: 'mp4', label: 'MP4' },
                    { id: 'mov', label: 'MOV' },
                  ]}
                />
              </Row>
            </div>
          </PortalMenu>
          {isAnonymous ? (
            /* Guest-CJM (2026-07-09): export is free but needs a real account.
               Say so AT the button — an honest CTA beats a button that "looks
               fine until you touch it" and only then throws a wall. */
            <Link
              href={`/login?next=${encodeURIComponent(pathname ?? '/studio')}`}
              data-testid="export-login-cta"
              title="Экспорт бесплатный — нужен только вход"
              className="glass-accent inline-flex h-11 items-center gap-2 rounded-[var(--radius-md)] px-6 text-[13px] font-semibold"
            >
              <Film size={17} />
              {`Экспорт ${exportFmt.toUpperCase()}`}
              <span className="border-l-[1.5px] border-[color:var(--color-line)] pl-2 font-mono text-[11px] font-bold uppercase tracking-wide opacity-80">
                бесплатно · войти
              </span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={onExport}
              disabled={timeline.length === 0 || busy}
              data-testid="export-btn"
              className="glass-accent inline-flex h-11 items-center gap-2 rounded-[var(--radius-md)] px-6 text-[13px] font-semibold disabled:pointer-events-none disabled:opacity-40"
            >
              {busy ? <Loader2 size={17} className="seed-spin" /> : <Film size={17} />}
              {phase.kind === 'rendering'
                ? 'Собираем…'
                : phase.kind === 'uploading'
                  ? 'Готовим…'
                  : `Экспорт ${exportFmt.toUpperCase()}`}
            </button>
          )}
          {phase.kind === 'rendering' && (
            <button
              type="button"
              onClick={() => void cancelRender(phase.renderId)}
              data-testid="cancel-render"
              className="glass glass-hover grid h-11 w-11 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
              title="Отменить рендер"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
