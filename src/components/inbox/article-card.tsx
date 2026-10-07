'use client';

import Link from 'next/link';
import { Heart, FileText } from 'lucide-react';
import { formatDate, readingTime } from '@/lib/text-utils';
import { FAVORITE_ACTIVE_CLASSES } from '@/lib/constants';
import type { ArticleListItem } from '@/types';

interface ArticleCardProps {
  article: ArticleListItem;
  snippet?: string;
}

/**
 * Renders a single article as a clickable card linking to the reader view.
 * @param article - The article to display
 */
export function ArticleCard({ article, snippet }: ArticleCardProps) {
  const readingPct = Math.round((article.readingProgress ?? 0) * 100);

  const meta = [
    article.siteName,
    formatDate(article.savedAt),
    article.wordCount || article.pageCount
      ? readingTime(article.wordCount, article.pageCount)
      : null,
  ].filter(Boolean);

  return (
    <Link
      href={`/reader/${article.id}`}
      className="border-border bg-card hover:bg-accent/50 block rounded-lg border p-4 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {article.isFavorite && (
              <Heart className={`h-3.5 w-3.5 shrink-0 ${FAVORITE_ACTIVE_CLASSES}`} />
            )}
            {article.originalFilePath && (
              <FileText className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-label="PDF" />
            )}
            <h2 className="text-foreground truncate text-sm font-medium">{article.title}</h2>
          </div>
          <div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
            {meta.map((item, i) => (
              <span key={i} className="contents">
                {i > 0 && <span aria-hidden="true">&middot;</span>}
                <span>{item}</span>
              </span>
            ))}
            {article.extractionTier === 'failed' && (
              <>
                {meta.length > 0 && <span aria-hidden="true">&middot;</span>}
                <span className="text-destructive">No text extracted</span>
              </>
            )}
          </div>
          {snippet ? (
            // Safe: server-guaranteed escaped HTML containing only <mark> tags — see docs/modules/global-search.md §6.1
            <p
              className="text-muted-foreground mt-2 line-clamp-2 text-xs leading-relaxed [&_mark]:rounded-sm [&_mark]:bg-[rgba(253,224,71,0.4)] [&_mark]:dark:bg-[rgba(253,224,71,0.25)]"
              dangerouslySetInnerHTML={{ __html: snippet }}
            />
          ) : (
            article.excerpt && (
              <p className="text-muted-foreground mt-2 line-clamp-2 text-xs leading-relaxed">
                {article.excerpt}
              </p>
            )
          )}
        </div>

        {readingPct > 0 && readingPct < 100 && (
          <span className="text-muted-foreground shrink-0 text-xs">{readingPct}%</span>
        )}
      </div>
    </Link>
  );
}
