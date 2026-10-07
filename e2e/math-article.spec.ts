import { test, expect, type Page } from '@playwright/test';
import { waitForMarks } from './utils';

// A paragraph with inline math, a display-math block, and surrounding prose. The reader
// renders LaTeX via KaTeX (katex/contrib/auto-render); this exercises the class-name
// contract getTextFromNode depends on end-to-end against the installed KaTeX version.
const CONTENT_HTML = `
<p data-testid="para-1">The famous identity is $E=mc^2$ and it appears everywhere in physics.</p>
<p data-testid="para-2">Below is a definite integral rendered as a display block:</p>
<p data-testid="para-3">$$\\int_0^1 x^2 dx$$</p>
<p data-testid="para-4">Trailing paragraph so the article has enough text to anchor against.</p>
`;

const CONTENT_TEXT =
  'The famous identity is E=mc^2 and it appears everywhere in physics. Below is a definite integral rendered as a display block: integral of x squared. Trailing paragraph so the article has enough text to anchor against.';

/**
 * Creates a math-bearing article via the API and returns its ID.
 */
async function createMathArticle(page: Page): Promise<number> {
  const res = await page.request.post('/api/articles', {
    data: {
      url: `https://example.com/math-e2e-${Date.now()}-${Math.random()}`,
      title: 'Math Article E2E',
      contentHtml: CONTENT_HTML,
      contentText: CONTENT_TEXT,
    },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return body.article.id;
}

test.describe('Math article (KaTeX rendering + highlight anchoring)', () => {
  let articleId: number;

  test.afterEach(async ({ page }) => {
    if (articleId) await page.request.delete(`/api/articles/${articleId}`).catch(() => {});
  });

  test('renders inline and display math in the reader', async ({ page }) => {
    articleId = await createMathArticle(page);
    await page.goto(`/reader/${articleId}`);
    await expect(page.getByTestId('article-content')).toBeVisible();

    // KaTeX renders lazily after mount; wait for the rendered output to appear.
    await page.waitForFunction(() => !!document.querySelector('.katex'), null, { timeout: 15000 });

    // At least two math instances rendered (inline $E=mc^2$ + the display integral).
    const katexCount = await page.locator('.katex').count();
    expect(katexCount).toBeGreaterThanOrEqual(2);

    // The display block is wrapped in .katex-display (the load-bearing class the
    // highlight extractor uses to reconstruct $$...$$ delimiters).
    await expect(page.locator('.katex-display').first()).toBeVisible();
  });

  test('highlight spanning a display-math block survives reload and re-anchors', async ({
    page,
  }) => {
    articleId = await createMathArticle(page);
    await page.goto(`/reader/${articleId}`);
    await expect(page.locator('[data-testid="highlight-layer"]')).toBeVisible();
    await expect(page.getByTestId('article-content')).toBeVisible();
    await page.waitForFunction(() => !!document.querySelector('.katex'), null, { timeout: 15000 });

    // Double-click the paragraph holding the display-math block to highlight it whole.
    // The reader's dblclick handler selects the paragraph and creates a highlight whose
    // range spans the .katex-display subtree.
    await page.locator('[data-testid="para-3"]').dblclick();
    await waitForMarks(page, 1);
    const highlightId = await page
      .locator('mark[data-highlight-id]')
      .first()
      .getAttribute('data-highlight-id');
    expect(highlightId).toBeTruthy();

    // Reload: the highlight must re-anchor against the freshly parsed + re-rendered
    // math DOM (KaTeX re-splits text nodes on every mount), proving the anchor is
    // durable across the math rendering pass.
    await page.goto(`/reader/${articleId}`);
    await expect(page.locator('[data-testid="highlight-layer"]')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('article-content')).toBeVisible();
    await page.waitForFunction(() => !!document.querySelector('.katex'), null, { timeout: 15000 });
    await waitForMarks(page, 1);
    await expect(page.locator(`mark[data-highlight-id="${highlightId}"]`).first()).toBeVisible();
  });
});
