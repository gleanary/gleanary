/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render, waitFor } from '@testing-library/react';
import { ArticleContent } from '@/components/reader/article-content';
import { renderMath, wrapInlineDollarMath } from '@/lib/math-render';

// Exact paragraph from the bug report: two currency dollar signs in one text node.
const CURRENCY_PARAGRAPH =
  'In 2023, median weekly earnings of $1,578 for workers with a bachelor’s degree and $966 for people with a high school diploma.';

/**
 * Renders ArticleContent and waits for its async math pass to finish (onReady).
 * @param html - Article HTML to render
 * @returns The article-content container element
 */
async function renderArticle(html: string): Promise<HTMLElement> {
  let ready = false;
  const { getByTestId } = render(
    createElement(ArticleContent, {
      html,
      onReady: () => {
        ready = true;
      },
    }),
  );
  await waitFor(() => expect(ready).toBe(true));
  return getByTestId('article-content');
}

describe('ArticleContent math rendering', () => {
  it('does not treat currency dollar signs as inline math (repro)', async () => {
    const el = await renderArticle(`<p>${CURRENCY_PARAGRAPH}</p>`);

    expect(el.querySelector('.katex')).toBeNull();
    expect(el.textContent).toContain('$1,578 for workers with a bachelor’s degree and $966');
  });

  it('still renders real inline and display math', async () => {
    const el = await renderArticle('<p>Energy $E=mc^2$ and</p><p>$$\\int_0^1 x^2 dx$$</p>');

    expect(el.querySelectorAll('.katex').length).toBe(2);
    expect(el.querySelector('.katex-display')).not.toBeNull();
  });

  it('fires onReady for math-free articles', async () => {
    const el = await renderArticle('<p>No math here.</p>');
    expect(el.textContent).toBe('No math here.');
  });
});

describe('wrapInlineDollarMath', () => {
  it.each([
    ['$E=mc^2$', '\\(E=mc^2\\)'],
    ['$2x+1$', '\\(2x+1\\)'],
    ['$x_i$ and $y$', '\\(x_i\\) and \\(y\\)'],
    ['$x$.', '\\(x\\).'],
    ['costs $5, and later $x$', 'costs $5, and later \\(x\\)'],
  ])('wraps valid inline math %s', (input, expected) => {
    expect(wrapInlineDollarMath(input)).toBe(expected);
  });

  it.each([
    CURRENCY_PARAGRAPH,
    '$5 and $10',
    '$5-$10',
    'costs $ 5 $',
    'a $x\ny$ b',
    '\\$x\\$',
    '$$\\int_0^1 x^2 dx$$',
    'no dollars at all',
  ])('leaves %j untouched', (input) => {
    expect(wrapInlineDollarMath(input)).toBe(input);
  });
});

describe('renderMath', () => {
  /**
   * Builds a detached div from HTML and runs renderMath on it.
   * @param html - Inner HTML
   * @returns The rendered element
   */
  function rendered(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    renderMath(el);
    return el;
  }

  it('keeps the bug-report paragraph as plain text with both $ signs', () => {
    const el = rendered(`<p>${CURRENCY_PARAGRAPH}</p>`);
    expect(el.querySelector('.katex')).toBeNull();
    expect(el.textContent).toBe(CURRENCY_PARAGRAPH);
  });

  it.each(['$E=mc^2$', '$2x+1$', '$x_i$', '\\(x\\)'])('renders inline math %s', (input) => {
    const el = rendered(`<p>${input}</p>`);
    expect(el.querySelector('.katex')).not.toBeNull();
    expect(el.querySelector('.katex-display')).toBeNull();
  });

  it.each(['$$\\int_0^1 x^2 dx$$', '\\[y\\]'])('renders display math %s', (input) => {
    const el = rendered(`<p>${input}</p>`);
    expect(el.querySelector('.katex-display')).not.toBeNull();
  });

  it.each(['$5 and $10', '$5-$10', 'costs $ 5 $', '\\$x\\$'])('does not render %j', (input) => {
    const el = rendered(`<p>${input}</p>`);
    expect(el.querySelector('.katex')).toBeNull();
    expect(el.textContent).toBe(input);
  });

  it('leaves math-looking text inside <code> and <pre> untouched', () => {
    const el = rendered('<p><code>$x$</code></p><pre>$y$ \\(z\\)</pre>');
    expect(el.querySelector('.katex')).toBeNull();
    expect(el.textContent).toBe('$x$$y$ \\(z\\)');
  });
});
