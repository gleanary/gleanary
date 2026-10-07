'use client';

import { useState, useCallback, useEffect, useTransition, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { HighlightCard } from './highlight-card';
import { LibraryFilters, type LibraryFiltersState, DEFAULT_FILTERS } from './library-filters';
import { BulkActions } from './bulk-actions';
import { useRefreshOnMount } from '@/hooks/use-refresh-on-mount';
import type { HighlightWithContext, TagWithCount } from '@/types';

interface HighlightLibraryProps {
  initialHighlights: HighlightWithContext[];
  initialTotal: number;
  initialTags: TagWithCount[];
}

const PAGE_SIZE = 50;

/**
 * Client-side highlight library with filtering, selection, and bulk operations.
 * @param props - Initial highlights, total count, and available tags
 * @returns Complete highlight library component
 */
export function HighlightLibrary({
  initialHighlights,
  initialTotal,
  initialTags,
}: HighlightLibraryProps) {
  const [highlights, setHighlights] = useState(initialHighlights);
  const [total, setTotal] = useState(initialTotal);
  const [tags, setTags] = useState(initialTags);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filters, setFilters] = useState<LibraryFiltersState>(DEFAULT_FILTERS);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const fetchHighlights = useCallback(
    async (currentFilters: LibraryFiltersState, offset = 0, append = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const params = new URLSearchParams();
      if (currentFilters.tagId) params.set('tagId', String(currentFilters.tagId));
      if (currentFilters.dateFrom) params.set('dateFrom', currentFilters.dateFrom);
      if (currentFilters.dateTo) params.set('dateTo', currentFilters.dateTo);
      params.set('sort', currentFilters.sort);
      params.set('order', currentFilters.order);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));

      try {
        const res = await fetch(`/api/highlights?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = await res.json();
        setHighlights((prev) => (append ? [...prev, ...body.highlights] : body.highlights));
        setTotal(body.total);
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
    },
    [],
  );

  const fetchTags = useCallback(async () => {
    const res = await fetch('/api/tags');
    if (!res.ok) return;
    const body = await res.json();
    setTags(body.tags);
  }, []);

  const refreshData = useCallback(
    (currentFilters: LibraryFiltersState) =>
      Promise.all([fetchHighlights(currentFilters), fetchTags()]),
    [fetchHighlights, fetchTags],
  );

  useRefreshOnMount(() => refreshData(DEFAULT_FILTERS));

  const handleFiltersChange = useCallback(
    (newFilters: LibraryFiltersState) => {
      setFilters(newFilters);
      setSelected(new Set());
      startTransition(async () => {
        await fetchHighlights(newFilters);
      });
    },
    [fetchHighlights],
  );

  const handleSelect = useCallback((id: number, isSelected: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (isSelected) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleBulkTag = useCallback(
    async (tagIds: number[], mode: 'add' | 'replace') => {
      const ids = Array.from(selected);
      const res = await fetch('/api/highlights/bulk-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, tagIds, mode }),
      });
      if (!res.ok) return;
      setSelected(new Set());
      await refreshData(filters);
    },
    [selected, filters, refreshData],
  );

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selected);
    const res = await fetch('/api/highlights/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) return;
    setSelected(new Set());
    await refreshData(filters);
  }, [selected, filters, refreshData]);

  return (
    <div className="space-y-4">
      <LibraryFilters filters={filters} tags={tags} onChange={handleFiltersChange} />

      {selected.size > 0 && (
        <BulkActions
          selectedCount={selected.size}
          tags={tags}
          onBulkTag={handleBulkTag}
          onBulkDelete={handleBulkDelete}
          onDeselectAll={() => setSelected(new Set())}
        />
      )}

      {isPending && (
        <div className="text-muted-foreground py-4 text-center text-sm">Loading...</div>
      )}

      {!isPending && highlights.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-muted-foreground">No highlights yet.</p>
          <p className="text-muted-foreground/60 mt-1 text-sm">
            Highlights you create while reading articles will appear here.
          </p>
        </div>
      )}

      {!isPending && highlights.length > 0 && (
        <>
          <div className="text-muted-foreground text-xs">
            {total} highlight{total !== 1 ? 's' : ''}
          </div>
          <div className="space-y-3">
            {highlights.map((h) => (
              <HighlightCard
                key={h.id}
                highlight={h}
                selected={selected.has(h.id)}
                onSelect={handleSelect}
              />
            ))}
          </div>

          {total > highlights.length && (
            <div className="pt-2 text-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  setIsLoadingMore(true);
                  try {
                    await fetchHighlights(filters, highlights.length, true);
                  } finally {
                    setIsLoadingMore(false);
                  }
                }}
                disabled={isLoadingMore}
                className="text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
              >
                {isLoadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
