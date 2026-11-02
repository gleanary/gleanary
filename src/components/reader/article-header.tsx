import type { Article } from '@/types';

/**
 * Displays the article title. The byline and the meta row (date, length) live in the
 * context panel's About section.
 * @param props.article - The article
 * @returns The header with the H1
 */
export function ArticleHeader({ article }: { article: Article }) {
  return (
    <header className="mb-8">
      <h1
        data-testid="article-title"
        className="text-3xl leading-tight font-bold tracking-tight text-[rgb(var(--reader-text))] md:text-4xl"
      >
        {article.title}
      </h1>
    </header>
  );
}
