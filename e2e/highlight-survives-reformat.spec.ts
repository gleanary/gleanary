import { test, expect, type Page } from '@playwright/test';

const CONTENT_HTML = `
<p data-testid="para-1">Hello reanchor world foo bar test paragraph here.</p>
<p data-testid="para-2">Second paragraph with more content to anchor against.</p>
`;

const CONTENT_TEXT =
  'Hello reanchor world foo bar test paragraph here. Second paragraph with more content to anchor against.';

/**
 * Waits for at least `minCount` highlight marks to appear in the DOM.
 */
async function waitForMarks(page: Page, minCount = 1): Promise<void> {
  await page.waitForFunction(
    (min) => document.querySelectorAll('mark[data-highlight-id]').length >= min,
    minCount,
    { timeout: 15000 },
  );
}

test('reanchor route corrects drifted anchor; highlight renders in reader', async ({ page }) => {
  // 1. Create article via API.
  const createRes = await page.request.post('/api/articles', {
    data: {
      url: `https://example.com/reanchor-e2e-${Date.now()}`,
      title: 'Reanchor E2E Test Article',
      contentHtml: CONTENT_HTML,
      contentText: CONTENT_TEXT,
    },
  });
  expect(createRes.ok()).toBe(true);
  const { article } = await createRes.json();
  const articleId: number = article.id;

  // Compute the correct v2 anchor for "foo bar" in the article text stream.
  // The text stream is the concatenation of all text nodes in the reader DOM:
  // outer div > div.article-content > p[1] text + p[2] text (with no whitespace normalization).
  // "foo bar" appears at a known position; we'll store it with correct offsets and then
  // deliberately corrupt the offsets to exercise the fuzzy path.
  const exactText = 'foo bar';
  const streamPrefix = '\nHello reanchor world '; // text before "foo bar" in the stream
  const correctStart = streamPrefix.length;
  const correctEnd = correctStart + exactText.length;

  // 2. Create the highlight directly via API with the correct v2 anchor.
  const highlightRes = await page.request.post('/api/highlights', {
    data: {
      articleId,
      text: exactText,
      positionData: JSON.stringify({
        v: 2,
        exact: exactText,
        prefix: 'world ',
        suffix: ' test',
        start: correctStart,
        end: correctEnd,
      }),
    },
  });
  expect(highlightRes.ok()).toBe(true);
  const { highlight } = await highlightRes.json();
  const highlightId: number = highlight.id;

  // 3. Verify the highlight renders in the reader.
  await page.goto(`/reader/${articleId}`);
  await waitForMarks(page, 1);
  await expect(page.locator(`mark[data-highlight-id="${highlightId}"]`).first()).toBeVisible();

  // 4. Corrupt the stored anchor: wrong start/end but correct exact.
  // This simulates what content drift looks like — the text is still there but offsets
  // no longer point to it. The reanchor route must use the fuzzy path to fix this.
  const corruptedAnchor = {
    v: 2,
    exact: exactText,
    prefix: 'world ',
    suffix: ' test',
    start: 0, // deliberately wrong — points to start of stream, not "foo bar"
    end: 7, // deliberately wrong
  };
  const patchRes = await page.request.patch(`/api/highlights/${highlightId}`, {
    data: { positionData: JSON.stringify(corruptedAnchor) },
  });
  expect(patchRes.ok()).toBe(true);

  // 5. Call reanchor-highlights — should correct the drifted anchor via fuzzy path.
  const reanchorRes = await page.request.post(`/api/articles/${articleId}/reanchor-highlights`);
  expect(reanchorRes.ok()).toBe(true);
  const reanchorBody = await reanchorRes.json();
  expect(reanchorBody.reanchored).toBe(1);
  expect(reanchorBody.orphaned).toBe(0);

  // 6. Reload the reader — highlight must still render at the correct text.
  await page.goto(`/reader/${articleId}`);
  await waitForMarks(page, 1);
  await expect(page.locator(`mark[data-highlight-id="${highlightId}"]`).first()).toBeVisible();
});
