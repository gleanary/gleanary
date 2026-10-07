import type { Article } from '@/types';
import { formatDate, readingTime } from '@/lib/text-utils';

/**
 * Displays article metadata: title, author, site name, date, word count, reading time.
 */
export function ArticleHeader({ article }: { article: Article }) {
  const byline = [article.author, article.siteName].filter(Boolean).join(' · ');

  const metaItems: React.ReactNode[] = [];
  if (article.publishedAt) {
    metaItems.push(<span key="date">{formatDate(article.publishedAt)}</span>);
  }
  const timeLabel = readingTime(article.wordCount, article.pageCount);
  if (article.pageCount) {
    metaItems.push(<span key="time">{timeLabel}</span>);
  } else if (article.wordCount !== null && article.wordCount > 0) {
    metaItems.push(<span key="words">{article.wordCount.toLocaleString()} words</span>);
    metaItems.push(<span key="time">{timeLabel}</span>);
  }
  return (
    <header className="mb-8">
      <h1
        data-testid="article-title"
        className="mb-4 text-3xl leading-tight font-bold tracking-tight text-[rgb(var(--reader-text))] md:text-4xl"
      >
        {article.title}
      </h1>

      {byline && (
        <p
          data-testid="article-byline"
          className="mb-2 text-base text-[rgb(var(--reader-text))]/60"
        >
          {byline}
        </p>
      )}

      <div
        data-testid="article-meta"
        className="flex flex-wrap items-center gap-3 text-sm text-[rgb(var(--reader-text))]/50"
      >
        {metaItems.map((item, i) => (
          <span key={i} className="contents">
            {i > 0 && <span aria-hidden="true">·</span>}
            {item}
          </span>
        ))}
      </div>
    </header>
  );
}
