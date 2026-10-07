'use client';

import { useState, useCallback, useRef, useTransition } from 'react';
import { ArticleCard } from './article-card';
import { StatusTabs } from './status-tabs';
import { Button } from '@/components/ui/button';
import type { ArticleListItem, ArticleStatus } from '@/types';

interface ArticleListProps {
  initialArticles: ArticleListItem[];
  initialTotal: number;
  initialStatus: ArticleStatus | null;
  /** Optional source filter for feed/newsletter views */
  sourceId?: number;
  /** Optional source type filter (e.g. 'newsletter') */
  sourceType?: string;
  /** Optional source type to exclude */
  excludeSourceType?: string;
}

const PAGE_SIZE = 50;

/**
 * Client component that renders the article inbox with status/favorites filtering and pagination.
 * @param initialArticles - Articles fetched server-side for the initial render
 * @param initialTotal - Total article count for the initial filter
 * @param initialStatus - The status filter applied on initial load
 */
export function ArticleList({
  initialArticles,
  initialTotal,
  initialStatus,
  sourceId,
  sourceType,
  excludeSourceType,
}: ArticleListProps) {
  const [articles, setArticles] = useState(initialArticles);
  const [total, setTotal] = useState(initialTotal);
  const [status, setStatus] = useState<ArticleStatus | null>(initialStatus);
  const [isFavoriteFilter, setIsFavoriteFilter] = useState(false);
  const [isPending, startTransition] = useTransition();
  const abortRef = useRef<AbortController | null>(null);

  const fetchArticles = useCallback(
    async (
      filterStatus: ArticleStatus | null,
      filterFavorite: boolean,
      offset = 0,
      append = false,
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterFavorite) params.set('isFavorite', 'true');
      if (sourceId) params.set('sourceId', String(sourceId));
      if (sourceType) params.set('sourceType', sourceType);
      if (excludeSourceType) params.set('excludeSourceType', excludeSourceType);
      params.set('sort', 'savedAt');
      params.set('order', 'desc');
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));

      try {
        const res = await fetch(`/api/articles?${params}`, { signal: controller.signal });
        if (!res.ok) return;
        const body = await res.json();
        setArticles((prev) => (append ? [...prev, ...body.articles] : body.articles));
        setTotal(body.total);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        throw e;
      }
    },
    [sourceId, sourceType, excludeSourceType],
  );

  const handleTabChange = useCallback(
    (newStatus: ArticleStatus | null, newIsFavorite: boolean) => {
      setStatus(newStatus);
      setIsFavoriteFilter(newIsFavorite);
      startTransition(async () => {
        await fetchArticles(newStatus, newIsFavorite);
      });
    },
    [fetchArticles],
  );

  const handleLoadMore = useCallback(() => {
    startTransition(async () => {
      await fetchArticles(status, isFavoriteFilter, articles.length, true);
    });
  }, [fetchArticles, status, isFavoriteFilter, articles.length]);

  const title =
    excludeSourceType === 'newsletter'
      ? 'Articles'
      : sourceType === 'newsletter'
        ? 'Emails'
        : 'Library';

  return (
    <div className="space-y-4">
      <StatusTabs
        activeStatus={status}
        isFavoriteFilter={isFavoriteFilter}
        onChange={handleTabChange}
        title={title}
      />

      {isPending && (
        <div className="text-muted-foreground py-4 text-center text-sm">Loading...</div>
      )}

      {!isPending && articles.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-muted-foreground">
            {isFavoriteFilter ? 'No favorites yet.' : 'No articles yet.'}
          </p>
          {!isFavoriteFilter && (
            <p className="text-muted-foreground/60 mt-1 text-sm">
              Save articles via the browser extension or add RSS feeds to get started.
            </p>
          )}
        </div>
      )}

      {!isPending && articles.length > 0 && (
        <>
          <div className="text-muted-foreground text-xs">
            {total} article{total !== 1 ? 's' : ''}
          </div>
          <div className="space-y-2">
            {articles.map((article) => (
              <ArticleCard key={article.id} article={article} />
            ))}
          </div>

          {total > articles.length && (
            <div className="pt-2 text-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLoadMore}
                className="text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
