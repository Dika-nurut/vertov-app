'use client';

import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  loadValidatedProjectContext,
  isProjectProductPath,
  parseProjectContext,
  PROJECT_CONTEXT_STORAGE_KEY,
  type ProjectContextState,
} from '@/lib/project-context';

const INITIAL_PROJECT_CONTEXT: ProjectContextState = { mode: 'loading', projectId: null };
const ProjectContext = createContext<ProjectContextState>(INITIAL_PROJECT_CONTEXT);
const ProjectContextSetter = createContext<Dispatch<SetStateAction<ProjectContextState>> | null>(
  null,
);

function ProjectContextSynchronizer({ apiUrl }: { apiUrl: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const setState = useContext(ProjectContextSetter);
  const serializedSearch = search.toString();

  useEffect(() => {
    if (!setState) return;
    if (!isProjectProductPath(pathname)) {
      window.sessionStorage.removeItem(PROJECT_CONTEXT_STORAGE_KEY);
      setState({ mode: 'standalone' });
      return;
    }
    const parsed = parseProjectContext(serializedSearch ? `?${serializedSearch}` : '');
    if (parsed.mode === 'standalone') {
      // Missing explicit context is an intentional standalone route. Never
      // revive an old project merely because session storage remembers it.
      window.sessionStorage.removeItem(PROJECT_CONTEXT_STORAGE_KEY);
      setState({ mode: 'standalone' });
      return;
    }
    if (parsed.mode === 'invalid') {
      window.sessionStorage.removeItem(PROJECT_CONTEXT_STORAGE_KEY);
      setState({ mode: 'invalid', projectId: null, reason: 'malformed' });
      return;
    }

    const controller = new AbortController();
    // A remembered id is navigation continuity only. Keep storage empty until
    // the authoritative API validation succeeds.
    window.sessionStorage.removeItem(PROJECT_CONTEXT_STORAGE_KEY);
    setState({ mode: 'loading', projectId: parsed.projectId });
    void loadValidatedProjectContext(fetch, apiUrl, parsed.projectId, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) {
          if (next.mode === 'valid') {
            window.sessionStorage.setItem(PROJECT_CONTEXT_STORAGE_KEY, next.project.id);
          } else {
            window.sessionStorage.removeItem(PROJECT_CONTEXT_STORAGE_KEY);
          }
          setState(next);
        }
      },
      (error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (!controller.signal.aborted) {
          window.sessionStorage.removeItem(PROJECT_CONTEXT_STORAGE_KEY);
          setState({ mode: 'invalid', projectId: parsed.projectId, reason: 'unavailable' });
        }
      },
    );
    return () => controller.abort();
  }, [apiUrl, pathname, serializedSearch, setState]);

  return null;
}

export function ProjectContextProvider({
  apiUrl,
  children,
}: {
  apiUrl: string;
  children: ReactNode;
}) {
  // Start closed rather than assuming standalone: on an explicit project URL,
  // child product effects and submit controls must not run before validation.
  const [state, setState] = useState<ProjectContextState>(INITIAL_PROJECT_CONTEXT);
  const value = useMemo(() => state, [state]);
  return (
    <ProjectContextSetter.Provider value={setState}>
      <ProjectContext.Provider value={value}>
        <Suspense fallback={null}>
          <ProjectContextSynchronizer apiUrl={apiUrl} />
        </Suspense>
        {children}
      </ProjectContext.Provider>
    </ProjectContextSetter.Provider>
  );
}

export function useProjectContext(): ProjectContextState {
  return useContext(ProjectContext);
}
