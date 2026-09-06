'use client';

import { createContext, useContext, useMemo } from 'react';
import { withProjectContext } from '@/lib/project-context';

/**
 * The active Среда project for everything rendered inside the Studio editor.
 * The editor's internal cross-links (Generate, Boards) sit three components
 * deep — Library→MediaPanel, PreviewStage→EmptyStage, Inspector→SmartPanel —
 * and hardcoded standalone targets there quietly dropped the project, so
 * anything generated from Studio landed in the global library instead of the
 * project. A context carries the id without re-typing it through six
 * intermediate signatures. Standalone Studio provides no id and its links stay
 * standalone.
 */
const StudioProjectContext = createContext<string | null>(null);

export function StudioProjectProvider({
  workspaceProjectId,
  children,
}: {
  workspaceProjectId: string | null;
  children: React.ReactNode;
}) {
  return (
    <StudioProjectContext.Provider value={workspaceProjectId}>
      {children}
    </StudioProjectContext.Provider>
  );
}

/** `href` with the active project appended, or unchanged when standalone. */
export function useStudioProjectHref(href: string): string {
  const projectId = useContext(StudioProjectContext);
  return useMemo(() => (projectId ? withProjectContext(href, projectId) : href), [href, projectId]);
}
