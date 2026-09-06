'use client';

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type KeyboardEvent,
} from 'react';
import Link from 'next/link';
import { SearchResults } from './SearchResults';
import { flattenSearchGroups, searchIndexForKey, SEARCH_QUERY_MAX } from './search-utils';
import { allResultsHref } from '@/lib/global-search';
import { useSearch } from './useSearch';

export function SearchPanel({
  apiUrl,
  initialQuery = '',
  initialPage = 1,
  syncUrl = false,
  autoFocus = false,
  compact = false,
  projectId,
  projectTitle = 'Текущий проект',
}: {
  apiUrl: string;
  initialQuery?: string;
  initialPage?: number;
  syncUrl?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
  projectId?: string | undefined;
  projectTitle?: string | undefined;
}) {
  const router = useRouter();
  const instanceId = useId();
  const inputId = `workspace-search-input-${instanceId}`;
  const listboxId = `workspace-search-results-${instanceId}`;
  const optionIdPrefix = `workspace-search-option-${instanceId}`;
  const [query, setQuery] = useState(initialQuery.slice(0, SEARCH_QUERY_MAX));
  const [page, setPage] = useState(Math.max(1, Math.min(100, initialPage)));
  const [activeIndex, setActiveIndex] = useState(-1);
  const [scope, setScope] = useState<'project' | 'all'>(projectId ? 'project' : 'all');
  const activeIndexRef = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const { data, status, retry, normalizedQuery } = useSearch({
    apiUrl,
    query,
    page,
    projectId: scope === 'project' ? projectId : undefined,
    limit: compact ? 10 : 20,
  });
  const flatItems = useMemo(() => flattenSearchGroups(data?.groups ?? []), [data]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    setScope(projectId ? 'project' : 'all');
    setPage(1);
  }, [projectId]);

  useEffect(() => {
    const initialIndex = flatItems.length > 0 ? 0 : -1;
    activeIndexRef.current = initialIndex;
    setActiveIndex(initialIndex);
  }, [data, flatItems.length]);

  useEffect(() => {
    if (!syncUrl) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (normalizedQuery) params.set('q', normalizedQuery);
      if (page > 1) params.set('page', String(page));
      if (scope === 'project' && projectId) params.set('projectId', projectId);
      router.replace(params.size > 0 ? `/search?${params}` : '/search', { scroll: false });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, page, projectId, router, scope, syncUrl]);

  const moveActive = useCallback(
    (next: number) => {
      if (flatItems.length === 0) return;
      const bounded = Math.max(0, Math.min(flatItems.length - 1, next));
      activeIndexRef.current = bounded;
      setActiveIndex(bounded);
      optionRefs.current[bounded]?.scrollIntoView({ block: 'nearest' });
    },
    [flatItems.length],
  );

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const nextIndex = searchIndexForKey(event.key, activeIndexRef.current, flatItems.length);
    if (nextIndex !== null) {
      event.preventDefault();
      moveActive(nextIndex);
    } else if (event.key === 'Enter' && activeIndexRef.current >= 0) {
      event.preventDefault();
      optionRefs.current[activeIndexRef.current]?.click();
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      setQuery('');
      setPage(1);
    }
  }

  return (
    <div className={compact ? 'flex min-h-0 flex-col' : ''}>
      {projectId && (
        <div
          className="mb-3 inline-flex self-start border-2 border-[color:var(--color-line)]"
          aria-label="Область поиска"
        >
          <button
            type="button"
            aria-pressed={scope === 'project'}
            onClick={() => {
              setScope('project');
              setPage(1);
            }}
            className={`px-3 py-2 font-mono text-[10px] font-bold uppercase ${
              scope === 'project'
                ? 'bg-[color:var(--color-accent)] text-black'
                : 'bg-[color:var(--color-surface)]'
            }`}
          >
            {projectTitle}
          </button>
          <button
            type="button"
            aria-pressed={scope === 'all'}
            onClick={() => {
              setScope('all');
              setPage(1);
            }}
            className={`border-l-2 border-[color:var(--color-line)] px-3 py-2 font-mono text-[10px] font-bold uppercase ${
              scope === 'all'
                ? 'bg-[color:var(--color-accent)] text-black'
                : 'bg-[color:var(--color-surface)]'
            }`}
          >
            Вся Среда
          </button>
        </div>
      )}
      <label htmlFor={inputId} className="sr-only">
        Поиск по рабочей среде
      </label>
      <div className="relative">
        <span aria-hidden className="absolute left-4 top-1/2 -translate-y-1/2 font-display text-xl">
          ⌕
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={flatItems.length > 0}
          aria-activedescendant={activeIndex >= 0 ? `${optionIdPrefix}-${activeIndex}` : undefined}
          value={query}
          maxLength={SEARCH_QUERY_MAX}
          autoComplete="off"
          spellCheck={false}
          placeholder="Проекты, сценарии, доски, монтажи, медиа…"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          onKeyDown={onKeyDown}
          className="h-14 w-full border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] pl-12 pr-20 font-display text-lg font-bold outline-none placeholder:font-normal placeholder:text-[color:var(--color-faint)] focus:shadow-[5px_5px_0_0_var(--color-accent)]"
        />
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 border border-[color:var(--color-line-soft)] px-2 py-1 font-mono text-[9px] text-[color:var(--color-faint)]">
          ESC
        </kbd>
      </div>

      <div
        className={compact ? 'mt-4 min-h-0 flex-1 overflow-y-auto pr-1' : 'mt-8 min-h-[260px]'}
        aria-live="polite"
        aria-busy={status === 'loading'}
      >
        {status === 'empty' && (
          <div className="border-2 border-dashed border-[color:var(--color-line-soft)] px-6 py-14 text-center">
            <p className="font-display text-xl font-black">
              {scope === 'project' ? `Поиск: ${projectTitle}` : 'Ищите по всей Среде'}
            </p>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              Введите название проекта, документа или имя медиафайла.
            </p>
          </div>
        )}
        {status === 'loading' && (
          <div role="status" className="space-y-2">
            <span className="sr-only">Поиск…</span>
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="h-[70px] animate-pulse border-2 border-[color:var(--color-line-soft)] bg-[color:var(--color-surface)]"
              />
            ))}
          </div>
        )}
        {status === 'error' && (
          <div
            role="alert"
            className="border-2 border-[color:var(--color-destructive)] bg-[color:var(--color-surface)] px-6 py-10 text-center"
          >
            <p className="font-display text-xl font-black">Поиск временно недоступен</p>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              Проверьте соединение и повторите запрос.
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-5 border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2 font-mono text-[11px] font-bold uppercase text-black"
            >
              Повторить
            </button>
          </div>
        )}
        {status === 'ready' && data && (
          <>
            <div className="mb-5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--color-faint)]">
              <span>
                Найдено: {data.total} · Страница {data.page} из {Math.max(1, data.totalPages)}
              </span>
              <span>↑↓ выбрать · Enter открыть</span>
            </div>
            <SearchResults
              response={data}
              query={normalizedQuery}
              activeIndex={activeIndex}
              onActiveIndexChange={(index) => {
                activeIndexRef.current = index;
                setActiveIndex(index);
              }}
              optionRefs={optionRefs}
              listboxId={listboxId}
              optionIdPrefix={optionIdPrefix}
            />
            {/* The compact palette deliberately has no pagination — it shows
                the first 10 and hands the rest to the full page, carrying the
                query and the CURRENT scope so the result set is the same one. */}
            {compact && (
              <Link
                href={allResultsHref(normalizedQuery, scope === 'project' ? projectId : undefined)}
                data-testid="search-all-results"
                className="mt-4 block border-2 border-[color:var(--color-line)] px-4 py-3 text-center font-mono text-[10px] font-bold uppercase tracking-[0.1em] hover:bg-[color:var(--color-surface)]"
              >
                Все результаты ({data.total}) →
              </Link>
            )}
            {!compact && data.totalPages > 1 && (
              <nav className="mt-4 flex items-center justify-between" aria-label="Страницы поиска">
                <button
                  type="button"
                  disabled={!data.hasPrevious}
                  onClick={() => {
                    setPage((value) => Math.max(1, value - 1));
                    inputRef.current?.focus();
                  }}
                  className="border-2 border-[color:var(--color-line)] px-4 py-2 font-mono text-[10px] font-bold uppercase disabled:opacity-35"
                >
                  ← Назад
                </button>
                <button
                  type="button"
                  disabled={!data.hasNext}
                  onClick={() => {
                    setPage((value) => value + 1);
                    inputRef.current?.focus();
                  }}
                  className="border-2 border-[color:var(--color-line)] px-4 py-2 font-mono text-[10px] font-bold uppercase disabled:opacity-35"
                >
                  Дальше →
                </button>
              </nav>
            )}
          </>
        )}
      </div>
    </div>
  );
}
