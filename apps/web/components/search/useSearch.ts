'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchResponse } from './types';
import { createLatestRequestGuard, SEARCH_QUERY_MAX } from './search-utils';

export type SearchStatus = 'empty' | 'loading' | 'ready' | 'error';

export function useSearch({
  apiUrl,
  query,
  page,
  projectId,
  limit = 20,
  debounceMs = 180,
}: {
  apiUrl: string;
  query: string;
  page: number;
  projectId?: string | undefined;
  limit?: number;
  debounceMs?: number;
}) {
  const [status, setStatus] = useState<SearchStatus>(query.trim() ? 'loading' : 'empty');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const requestGuard = useRef(createLatestRequestGuard());
  const normalizedQuery = query.trim().slice(0, SEARCH_QUERY_MAX);

  const retry = useCallback(() => setRetryKey((value) => value + 1), []);

  useEffect(() => {
    if (!normalizedQuery) {
      requestGuard.current.invalidate();
      setStatus('empty');
      setData(null);
      return;
    }

    const sequence = requestGuard.current.begin();
    const controller = new AbortController();
    setStatus('loading');
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: normalizedQuery,
          page: String(page),
          limit: String(limit),
        });
        if (projectId) params.set('projectId', projectId);
        const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/search?${params}`, {
          credentials: 'include',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`http_${response.status}`);
        const payload = (await response.json()) as SearchResponse;
        if (!requestGuard.current.isCurrent(sequence)) return;
        setData(payload);
        setStatus('ready');
      } catch (error) {
        if (controller.signal.aborted || !requestGuard.current.isCurrent(sequence)) return;
        setData(null);
        setStatus('error');
      }
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [apiUrl, debounceMs, limit, normalizedQuery, page, projectId, retryKey]);

  return { data, status, retry, normalizedQuery };
}
