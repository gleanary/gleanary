/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ArticleHeader } from '@/components/reader/article-header';
import type { Article } from '@/types';

afterEach(cleanup);

describe('ArticleHeader', () => {
  it('renders the title only: the byline and meta row live in the context panel', () => {
    const article = {
      id: 1,
      title: 'A Title',
      author: 'Jane Doe',
      siteName: 'Example Blog',
      publishedAt: '2024-01-15T12:00:00Z',
      wordCount: 1190,
      pageCount: null,
    } as Article;

    const { container } = render(<ArticleHeader article={article} />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('A Title');
    expect(screen.queryByTestId('article-byline')).toBeNull();
    expect(screen.queryByTestId('article-meta')).toBeNull();
    expect(container.textContent).toBe('A Title');
  });
});
