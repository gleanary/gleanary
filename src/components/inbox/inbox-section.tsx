'use client';

import { ArticleList } from './article-list';
import type { ArticleListItem, ArticleStatus } from '@/types';

interface InboxSectionProps {
  initialArticles: ArticleListItem[];
  initialTotal: number;
  initialStatus: ArticleStatus | null;
  sourceId?: number;
  sourceType?: string;
  excludeSourceType?: string;
}

/**
 * Wraps the article list with source filtering props.
 * @param initialArticles - Server-fetched articles for the initial render
 * @param initialTotal - Total article count for the initial filter
 * @param initialStatus - The status filter applied on initial load
 * @param sourceId - Optional source filter for feed/newsletter views
 * @param sourceType - Optional source type filter (e.g. 'newsletter')
 * @param excludeSourceType - Optional source type to exclude
 */
export function InboxSection({
  initialArticles,
  initialTotal,
  initialStatus,
  sourceId,
  sourceType,
  excludeSourceType,
}: InboxSectionProps) {
  return (
    <ArticleList
      initialArticles={initialArticles}
      initialTotal={initialTotal}
      initialStatus={initialStatus}
      sourceId={sourceId}
      sourceType={sourceType}
      excludeSourceType={excludeSourceType}
    />
  );
}
