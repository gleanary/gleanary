/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { HighlightCard } from '@/components/library/highlight-card';
import type { HighlightWithContext } from '@/types';

// Minimal valid highlight fixture; individual tests override `text`.
function makeHighlight(text: string): HighlightWithContext {
  return {
    id: 1,
    articleId: 1,
    text,
    note: null,
    color: 'yellow',
    positionData: null,
    anchorStatus: 'anchored',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    lastReviewed: null,
    reviewCount: null,
    reviewInterval: null,
    article: { title: 'Some Article', url: 'https://example.com', siteName: 'Example' },
    tags: [],
  };
}

describe('HighlightCard', () => {
  it('renders malicious highlight text inertly on first paint (no HTML injection)', () => {
    const { container } = render(
      <HighlightCard
        highlight={makeHighlight('<img src="x" onerror="window.__xss=1">')}
        selected={false}
        onSelect={() => {}}
      />,
    );

    // On first paint (before the async KaTeX effect resolves) the raw text must not
    // be parsed as HTML — no <img> element, and the literal markup is shown as text.
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img');
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('renders plain angle brackets as literal text without over-escaping', () => {
    const { container } = render(
      <HighlightCard highlight={makeHighlight('a < b > c')} selected={false} onSelect={() => {}} />,
    );

    expect(container.textContent).toContain('a < b > c');
  });
});
