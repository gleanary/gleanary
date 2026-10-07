import Link from 'next/link';
import { AVERAGE_WPM, readingTime } from '@/lib/text-utils';
import type { ArticleListItem } from '@/types';

interface ReadingCardProps {
  article: ArticleListItem;
}

/**
 * Compact card for the horizontal Reading row on the home page.
 * Shows title, site name, reading progress bar, and estimated time remaining.
 * @param article - The article to display
 */
export function ReadingCard({ article }: ReadingCardProps) {
  const progress = article.readingProgress ?? 0;
  const progressPct = Math.round(progress * 100);
  const isPdf = article.pageCount !== null;
  const wordsRemaining = Math.round((1 - progress) * (article.wordCount ?? 0));
  const minutesRemaining = Math.max(1, Math.round(wordsRemaining / AVERAGE_WPM));

  return (
    <Link
      href={`/reader/${article.id}`}
      className="border-border bg-card hover:bg-accent/50 w-[280px] flex-shrink-0 snap-start rounded-lg border p-4 transition-colors"
    >
      <h3 className="text-foreground mb-2 line-clamp-2 text-sm leading-snug font-medium">
        {article.title}
      </h3>

      {article.siteName && (
        <p className="text-muted-foreground mb-3 truncate text-xs">{article.siteName}</p>
      )}

      <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
        <div
          className="bg-primary h-full rounded-full transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs">
        <span>{progressPct}%</span>
        {isPdf ? (
          <span>{readingTime(null, article.pageCount)}</span>
        ) : (
          <span>{minutesRemaining} min left</span>
        )}
      </div>
    </Link>
  );
}
