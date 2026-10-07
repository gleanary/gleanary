'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchResponse } from '@/types';

interface UseSearchQueryOptions {
  mode?: 'palette' | 'full';
  types?: string;
  status?: string;
  sourceId?: number;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

interface UseSearchQueryResult {
  data: SearchResponse | null;
  isLoading: boolean;
}

/**
 * Debounced search query hook with AbortController and stale-response guard.
 * Returns null data when query is below 2 chars (no request issued).
 * @param query - Raw search input; requests fire only at >= 2 chars after 200ms debounce
 * @param options - Extra query params forwarded to GET /api/search
 */
export function useSearchQuery(
  query: string,
  options: UseSearchQueryOptions = {},
): UseSearchQueryResult {
  // Internal fetch state — only updated from async callbacks, never synchronously in effects
  const [fetchedData, setFetchedData] = useState<SearchResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const { mode, types, status, sourceId, dateFrom, dateTo, limit, offset } = options;

  const fetchResults = useCallback(
    (q: string) => {
      // Abort any previous in-flight request
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      const params = new URLSearchParams({ q });
      if (mode) params.set('mode', mode);
      if (types) params.set('types', types);
      if (status) params.set('status', status);
      if (sourceId != null) params.set('sourceId', String(sourceId));
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (limit != null) params.set('limit', String(limit));
      if (offset != null) params.set('offset', String(offset));

      setIsLoading(true);
      fetch(`/api/search?${params.toString()}`, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`Search failed: ${res.status}`);
          return res.json() as Promise<SearchResponse>;
        })
        .then((result) => {
          // Ignore stale responses: only update if this controller is still current
          if (controller === controllerRef.current) {
            setFetchedData(result);
            setIsLoading(false);
          }
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') return;
          if (controller === controllerRef.current) {
            setIsLoading(false);
          }
        });
    },
    [mode, types, status, sourceId, dateFrom, dateTo, limit, offset],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < 2) {
      // Abort any in-flight request; state is cleared at render time (see return below)
      controllerRef.current?.abort();
      controllerRef.current = null;
      return;
    }

    debounceRef.current = setTimeout(() => {
      fetchResults(query);
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchResults]);

  // Abort on unmount
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  // Derive visible data at render time: queries below threshold always yield null
  const isQueryTooShort = query.trim().length < 2;
  return {
    data: isQueryTooShort ? null : fetchedData,
    isLoading: isQueryTooShort ? false : isLoading,
  };
}
