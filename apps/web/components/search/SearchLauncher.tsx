'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { SearchPanel } from './SearchPanel';
import { isSearchShortcut } from '@/lib/global-search';

/**
 * Only the most recently mounted launcher owns ⌘K. Two launchers listening on
 * `window` would both toggle on a single keypress, so an app shell + a page
 * launcher would cancel each other out and the palette would never open.
 */
const shortcutOwners: Array<() => void> = [];

/** Reusable desktop launcher. The global shell can mount this in a later milestone. */
export function SearchLauncher({
  apiUrl,
  label = 'Поиск',
  className,
  projectId,
  projectTitle,
}: {
  apiUrl: string;
  label?: string;
  className?: string | undefined;
  projectId?: string | undefined;
  projectTitle?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [routeProjectId, setRouteProjectId] = useState<string | undefined>(projectId);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setRouteProjectId(
      projectId ?? params.get('projectId') ?? params.get('workspaceProjectId') ?? undefined,
    );
  }, [projectId]);

  useEffect(() => {
    const toggle = () => setOpen((value) => !value);
    shortcutOwners.push(toggle);
    function onShortcut(event: KeyboardEvent) {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      if (shortcutOwners.at(-1) === toggle) toggle();
    }
    window.addEventListener('keydown', onShortcut);
    return () => {
      window.removeEventListener('keydown', onShortcut);
      const index = shortcutOwners.lastIndexOf(toggle);
      if (index !== -1) shortcutOwners.splice(index, 1);
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Just the word. The magnifier glyph said the same thing twice, and the
            ⌘K badge was a lie on Windows and Linux — the shortcut itself takes
            metaKey OR ctrlKey (lib/global-search.ts), so only the hint was
            Mac-only. Removing it costs discoverability of the shortcut, not the
            shortcut. (Owner, 2026-07-28.) */}
        <button type="button" className={className}>
          {label}
        </button>
      </DialogTrigger>
      {/* Search must cover the project desk, which owns transient layers up to
          --z-desk-prompt. See the layer contract in globals.css. */}
      <DialogContent
        className="flex h-[min(720px,85vh)] max-w-3xl flex-col gap-4 overflow-hidden z-[var(--z-app-modal)]"
        overlayClassName="z-[var(--z-app-modal)]"
        data-testid="search-dialog"
      >
        <DialogHeader>
          <DialogTitle>Поиск по Среде</DialogTitle>
          <DialogDescription>
            Проекты, сценарии, доски, документы студии и ваши медиа.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <SearchPanel
            apiUrl={apiUrl}
            autoFocus
            compact
            projectId={routeProjectId}
            projectTitle={projectTitle}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
