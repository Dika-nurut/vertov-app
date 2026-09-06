'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Download, Film, Play, Scan, X } from '@/components/ui/icons';
import type { StudioClip } from '../../studio/StudioClient';

const StudioClient = dynamic(
  () => import('../../studio/StudioClient').then((module) => module.StudioClient),
  { ssr: false },
);

export function BoardExportMenu({
  open,
  apiUrl,
  boardId,
  assembling,
  animaticCount,
  onClose,
  onAnimatic,
  onFeedback,
}: {
  open: boolean;
  apiUrl: string;
  boardId: string;
  assembling: boolean;
  animaticCount: number;
  onClose: () => void;
  onAnimatic: () => void;
  onFeedback: (message: string) => void;
}) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);

  if (!open) return null;

  const share = async () => {
    if (shareUrl) {
      await navigator.clipboard.writeText(shareUrl).catch(() => {});
      onFeedback('Ссылка скопирована.');
      return;
    }
    setShareBusy(true);
    try {
      const response = await fetch(`${apiUrl}/v1/boards/${boardId}/share`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error(String(response.status));
      const { token } = (await response.json()) as { token: string };
      const url = `${apiUrl}/v1/storyboard/${token}`;
      setShareUrl(url);
      await navigator.clipboard.writeText(url).catch(() => {});
      onFeedback('Ссылка для читки скопирована.');
    } catch {
      onFeedback('Не удалось создать ссылку.');
    } finally {
      setShareBusy(false);
    }
  };

  const downloadJson = async () => {
    setDownloadBusy(true);
    try {
      const response = await fetch(`${apiUrl}/v1/boards/${boardId}/export.json`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.blob();
      const url = URL.createObjectURL(body);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `bord-${boardId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      onFeedback('JSON борда скачан.');
    } catch {
      onFeedback('Не удалось скачать JSON борда.');
    } finally {
      setDownloadBusy(false);
    }
  };

  return (
    <div
      data-testid="export-menu"
      className="glass-menu absolute bottom-[148px] left-1/2 z-40 w-72 -translate-x-1/2 p-1.5"
    >
      <a
        data-testid="export-storyboard-pdf"
        href={`${apiUrl}/v1/boards/${boardId}/storyboard.pdf`}
        target="_blank"
        rel="noreferrer"
        className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px] text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface2)]"
      >
        <Film size={13} className="text-[color:var(--color-accent)]" />
        <span className="flex-1">Раскадровка PDF</span>
        <span className="text-[11px] text-[color:var(--color-faint)]">скачать</span>
      </a>
      <button
        type="button"
        data-testid="export-board-json"
        disabled={downloadBusy}
        onClick={() => void downloadJson()}
        className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px] text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface2)] disabled:opacity-40"
      >
        <Download size={13} className="text-[color:var(--color-accent)]" />
        <span className="flex-1">Скачать JSON</span>
        <span className="text-[11px] text-[color:var(--color-faint)]">
          {downloadBusy ? '…' : 'backup'}
        </span>
      </button>
      <button
        type="button"
        data-testid="export-share"
        disabled={shareBusy}
        onClick={() => void share()}
        className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px] text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface2)] disabled:opacity-40"
      >
        <Scan size={13} className="text-[color:var(--color-accent)]" />
        <span className="flex-1">Ссылка для читки</span>
        <span className="text-[11px] text-[color:var(--color-faint)]">
          {shareBusy ? '…' : shareUrl ? 'копировать' : 'создать'}
        </span>
      </button>
      <button
        type="button"
        data-testid="export-animatic"
        disabled={assembling || animaticCount === 0}
        onClick={() => {
          onClose();
          onAnimatic();
        }}
        className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px] text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface2)] disabled:opacity-40"
      >
        <Play size={13} className="text-[color:var(--color-accent)]" />
        <span className="flex-1">Аниматик</span>
        <span className="text-[11px] text-[color:var(--color-faint)]">{animaticCount} кадр.</span>
      </button>
      {shareUrl && (
        <p className="break-all px-2.5 pb-1 pt-0.5 text-[11px] leading-snug text-[color:var(--color-faint)]">
          {shareUrl}
        </p>
      )}
    </div>
  );
}

export function BoardStudioSheet({
  open,
  title,
  studioKey,
  initialClips,
  apiUrl,
  onClose,
}: {
  open: boolean;
  title: string;
  studioKey: number;
  initialClips: StudioClip[];
  apiUrl: string;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        data-testid="studio-sheet"
        className="absolute inset-x-0 bottom-0 top-[5vh] overflow-y-auto rounded-t-[var(--radius-md)] border-t-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)]"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b-2 border-[color:var(--color-line)] bg-[color:var(--color-bg)] px-5 py-2.5">
          <span className="text-[13px] font-semibold text-[color:var(--color-fg)]">
            Монтаж · {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border-2 border-[color:var(--color-line)] px-3 text-[13px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            <X size={12} /> К борду
          </button>
        </div>
        <StudioClient key={studioKey} initialClips={initialClips} apiUrl={apiUrl} />
      </div>
    </div>
  );
}
