/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArticleProvider, useArticle } from '@/components/reader/article-context';
import { ReadingProgressBar } from '@/components/reader/reading-progress-bar';
import type { Article } from '@/types';

// Exposes the context's triggerProgressReset as a clickable element,
// the same way reader controls (e.g. "restart reading") invoke it.
function ResetTrigger() {
  const { triggerProgressReset } = useArticle();
  return <button onClick={triggerProgressReset}>reset</button>;
}

// Typo-safe partial fixture: the argument is checked against Partial<Article>,
// unlike a bare double cast which would let a misspelled field compile.
function makeArticle(fields: Partial<Article>): Article {
  return fields as Article;
}

function renderBar(readingProgress: number) {
  render(
    <ArticleProvider initialArticle={makeArticle({ id: 1, readingProgress })}>
      <ReadingProgressBar />
      <ResetTrigger />
    </ArticleProvider>,
  );
}

/** Progress reported by the bar as a 0–100 number. */
function barPercent(): number {
  const value = screen.getByRole('progressbar').getAttribute('aria-valuenow');
  expect(value).not.toBeNull();
  return Number(value);
}

function reset() {
  fireEvent.click(screen.getByRole('button', { name: 'reset' }));
}

function setViewport(scrollHeight: number, innerHeight: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
  // Also resets scrollY between tests; individual tests move it via scrollTo().
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
}

function scrollTo(scrollY: number) {
  Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
  fireEvent.scroll(window);
}

describe('ReadingProgressBar', () => {
  // scrollHeight 2000 − innerHeight 1000 → docHeight 1000, so scrollY maps 1:1000 to progress
  beforeEach(() => {
    setViewport(2000, 1000);
  });

  it('renders the saved reading progress on mount without resetting', () => {
    renderBar(0.7);
    expect(barPercent()).toBe(70);
  });

  it('advances progress monotonically when scrolling', () => {
    renderBar(0);
    scrollTo(300);
    expect(barPercent()).toBe(30);
    scrollTo(500);
    expect(barPercent()).toBe(50);
    // Scrolling back up does not decrease progress
    scrollTo(200);
    expect(barPercent()).toBe(50);
  });

  it('does not regress below the saved initial progress', () => {
    renderBar(0.7);
    scrollTo(300);
    expect(barPercent()).toBe(70);
    scrollTo(900);
    expect(barPercent()).toBe(90);
  });

  it('clamps progress to 100% when scrolled past the end', () => {
    renderBar(0);
    scrollTo(1500);
    expect(barPercent()).toBe(100);
  });

  it('ignores scroll when the document is not scrollable', () => {
    setViewport(1000, 1000);
    renderBar(0.2);
    scrollTo(500);
    expect(barPercent()).toBe(20);
  });

  it('resets to 0 when a reset is triggered', () => {
    renderBar(0.7);
    reset();
    expect(barPercent()).toBe(0);
  });

  it('resets again on a second reset and allows forward progress after each', () => {
    renderBar(0.8);
    reset();
    scrollTo(300);
    expect(barPercent()).toBe(30);
    reset();
    expect(barPercent()).toBe(0);
    // maxProgress is re-zeroed, so forward progress works after the second reset too
    scrollTo(200);
    expect(barPercent()).toBe(20);
  });
});
