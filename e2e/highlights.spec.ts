import { test, expect, type Page } from '@playwright/test';
import { waitForApiResponse } from './utils';

const TEST_ARTICLE_HTML = `
<p data-testid="para-1">This is the first paragraph of a test article with enough text for highlighting.</p>
<p data-testid="para-2">This is the second paragraph which contains different content for testing.</p>
<p data-testid="para-3">A third paragraph provides additional text for multiple highlight tests.</p>
`;

/**
 * Creates a test article via the API and returns its ID.
 */
async function createTestArticle(page: Page): Promise<number> {
  const res = await page.request.post('/api/articles', {
    data: {
      url: `https://example.com/test-${Date.now()}-${Math.random()}`,
      title: 'E2E Test Article',
      contentHtml: TEST_ARTICLE_HTML,
      contentText:
        'This is the first paragraph of a test article with enough text for highlighting. This is the second paragraph which contains different content for testing. A third paragraph provides additional text for multiple highlight tests.',
    },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return body.article.id;
}

/**
 * Waits for highlight marks to be present and stable in the DOM.
 */
async function waitForMarks(page: Page, minCount = 1): Promise<void> {
  await page.waitForFunction(
    (min) => document.querySelectorAll('mark[data-highlight-id]').length >= min,
    minCount,
    { timeout: 15000 },
  );
}

/**
 * Exits edit mode by clicking on a neutral area outside any highlight.
 * In the reworked system, this saves any changes via PATCH.
 */
async function exitEditMode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const evt = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 0,
      clientY: 0,
    });
    document.body.dispatchEvent(evt);
  });
  // Wait for popover and handles to disappear
  await expect(page.locator('[data-testid="highlight-popover"]')).not.toBeVisible({
    timeout: 3000,
  });
}

/**
 * Simulates a mobile double-tap on an element by dispatching touchend
 * followed by a dblclick, matching the browser's synthesized event sequence.
 */
async function simulateTouchDoubleTap(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Element not found: ${sel}`);
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    el.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        changedTouches: [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })],
      }),
    );

    el.dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      }),
    );
  }, selector);
}

/**
 * Returns the number of unique highlight IDs in the DOM.
 */
async function countUniqueHighlights(page: Page): Promise<number> {
  return page.evaluate(() => {
    const marks = document.querySelectorAll('mark[data-highlight-id]');
    const idSet = new Set<string>();
    marks.forEach((m) => {
      const id = m.getAttribute('data-highlight-id');
      if (id) idSet.add(id);
    });
    return idSet.size;
  });
}

test.describe('Highlight E2E', () => {
  let articleId: number;

  test.beforeEach(async ({ page }) => {
    articleId = await createTestArticle(page);
    await page.goto(`/reader/${articleId}`);
    await expect(page.locator('[data-testid="highlight-layer"]')).toBeVisible();
    await expect(page.getByTestId('article-content')).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await page.request.delete(`/api/articles/${articleId}`).catch(() => {});
  });

  test.describe('Desktop', () => {
    test('double-click paragraph → entire paragraph highlighted and edit mode entered', async ({
      page,
    }) => {
      const para = page.locator('[data-testid="para-2"]');
      await para.dblclick();

      // A highlight mark should be created covering the paragraph text
      await waitForMarks(page);
      const mark = page.locator('mark[data-highlight-id]');
      const markText = await mark.first().textContent();
      expect(markText).toContain('second paragraph');

      // Edit mode: popover and handles should appear
      await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible({
        timeout: 3000,
      });
      await expect(page.locator('[data-testid="selection-handle-start"]')).toBeVisible({
        timeout: 3000,
      });
      await expect(page.locator('[data-testid="selection-handle-end"]')).toBeVisible({
        timeout: 3000,
      });

      // Exit edit mode
      await exitEditMode(page);
    });

    test('double-click on existing highlight does nothing', async ({ page }) => {
      const para = page.locator('[data-testid="para-1"]');
      await para.dblclick();
      await waitForMarks(page);
      await exitEditMode(page);
      await waitForMarks(page);

      // Double-click on the highlighted mark
      const highlightMark = page.locator('mark[data-highlight-id]').first();
      await highlightMark.dblclick();

      // A dblclick on an existing highlight enters edit mode (the dblclick handler
      // bails on existing marks) rather than creating a new one. Waiting for the
      // popover confirms edit mode engaged, which also sets the guard that suppresses
      // the auto-create debounce — so no duplicate can be created afterward.
      await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible({
        timeout: 3000,
      });

      // There should still be only one unique highlight ID
      expect(await countUniqueHighlights(page)).toBe(1);
    });

    test('click existing highlight → enter edit mode → popover and handles appear', async ({
      page,
    }) => {
      await page.locator('[data-testid="para-1"]').dblclick();
      await waitForMarks(page);
      await exitEditMode(page);
      await waitForMarks(page);

      // Click the highlight mark to re-enter edit mode
      await page.locator('mark[data-highlight-id]').first().click();

      // Popover and handles should appear
      await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible({
        timeout: 3000,
      });
      await expect(page.locator('[data-testid="selection-handle-start"]')).toBeVisible({
        timeout: 3000,
      });
      await expect(page.locator('[data-testid="selection-handle-end"]')).toBeVisible({
        timeout: 3000,
      });

      await exitEditMode(page);
    });

    test('click outside during edit mode → saves and exits', async ({ page }) => {
      await page.locator('[data-testid="para-1"]').dblclick();
      await waitForMarks(page);

      await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible({
        timeout: 3000,
      });

      // Click outside
      await exitEditMode(page);

      // Popover and handles should disappear
      await expect(page.locator('[data-testid="highlight-popover"]')).not.toBeVisible({
        timeout: 3000,
      });
      await expect(page.locator('[data-testid="selection-handle-start"]')).not.toBeVisible({
        timeout: 3000,
      });

      // Highlight should still exist
      await waitForMarks(page);
    });

    test('scrolling during edit mode → popover stays visible', async ({ page }) => {
      await page.locator('[data-testid="para-1"]').dblclick();
      await waitForMarks(page);

      await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible({
        timeout: 3000,
      });

      // Scroll
      await page.evaluate(() => window.scrollBy(0, 100));

      // Popover should still be visible
      await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible({
        timeout: 3000,
      });

      await waitForMarks(page);
    });

    test('Escape key saves and exits edit mode', async ({ page }) => {
      await page.locator('[data-testid="para-1"]').dblclick();
      await waitForMarks(page);

      await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible({
        timeout: 3000,
      });

      // Dispatch Escape
      await page.evaluate(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      // Escape saves and exits edit mode: the popover disappears. (In headless
      // Chromium, Escape may instead navigate to about:blank — detected below; once
      // navigated, the popover query resolves to nothing and passes immediately.)
      await expect(page.locator('[data-testid="highlight-popover"]')).not.toBeVisible({
        timeout: 5000,
      });

      const url = page.url();
      if (url.includes('about:blank')) {
        test.skip(
          true,
          'Headless Chromium navigates to about:blank on Escape — known browser limitation',
        );
        return;
      }

      await waitForMarks(page);
    });

    test('highlight persists across navigation', async ({ page }) => {
      await page.locator('[data-testid="para-2"]').dblclick();
      await waitForMarks(page);
      await exitEditMode(page);

      // Navigate away and back
      await page.goto(`/reader/${articleId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-testid="highlight-layer"]')).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByTestId('article-content')).toBeVisible({ timeout: 5000 });

      await waitForMarks(page);
      await expect(page.locator('mark[data-highlight-id]').first()).toBeVisible();
    });

    test('popover stays within viewport bounds', async ({ page }) => {
      await page.locator('[data-testid="para-1"]').dblclick();
      await waitForMarks(page);

      const popover = page.locator('[data-testid="highlight-popover"]');
      await expect(popover).toBeVisible({ timeout: 3000 });

      const popoverRect = await popover.boundingBox();
      const viewport = page.viewportSize()!;

      expect(popoverRect).toBeTruthy();
      expect(popoverRect!.x).toBeGreaterThanOrEqual(0);
      expect(popoverRect!.y).toBeGreaterThanOrEqual(0);
      expect(popoverRect!.x + popoverRect!.width).toBeLessThanOrEqual(viewport.width);
      expect(popoverRect!.y + popoverRect!.height).toBeLessThanOrEqual(viewport.height);

      await exitEditMode(page);
    });

    test('multiple highlights on different paragraphs', async ({ page }) => {
      // Highlight paragraph 1 — wait on the creation POST so the highlight is
      // committed before we exit edit mode.
      const create1 = waitForApiResponse(page, '/api/highlights', 'POST');
      await page.locator('[data-testid="para-1"]').dblclick();
      expect((await create1).ok()).toBe(true);
      await waitForMarks(page, 1);
      await exitEditMode(page);

      // Ensure edit mode is fully torn down before the next highlight. The dblclick
      // handler bails while a highlight is being edited (editingRef guard), so a
      // second dblclick fired too early silently no-ops — the root cause of the
      // observed flake where waitForMarks(2) then timed out. The selection handles
      // only render in edit mode, so their disappearance confirms the teardown.
      await expect(page.locator('[data-testid="selection-handle-start"]')).not.toBeVisible({
        timeout: 3000,
      });

      // Highlight paragraph 3 — again wait on its creation POST before asserting marks.
      const create2 = waitForApiResponse(page, '/api/highlights', 'POST');
      await page.locator('[data-testid="para-3"]').dblclick();
      expect((await create2).ok()).toBe(true);
      await waitForMarks(page, 2);
      await exitEditMode(page);

      // Both highlights should exist (2 unique IDs)
      expect(await countUniqueHighlights(page)).toBe(2);
    });

    test('delete highlight via popover', async ({ page }) => {
      // Create a highlight
      await page.locator('[data-testid="para-1"]').dblclick();
      await waitForMarks(page);

      // Popover should be visible
      await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible({
        timeout: 3000,
      });

      // Click delete button in popover. The click fires DELETE /api/highlights/:id;
      // wait on that specific response (and assert it succeeded) so the removal is
      // confirmed server-side, not just optimistically in the DOM.
      const deleteResponse = waitForApiResponse(page, /^\/api\/highlights\/\d+$/, 'DELETE');
      await page.locator('[data-testid="highlight-delete"]').click();
      expect((await deleteResponse).ok()).toBe(true);

      // Marks are removed from the DOM. (A button click carries no text selection,
      // so the post-delete suppression window has nothing to re-create from.)
      await expect(page.locator('mark[data-highlight-id]')).toHaveCount(0);
      expect(await countUniqueHighlights(page)).toBe(0);
    });
  });

  test.describe('Mobile Touch', () => {
    test('double-tap on paragraph auto-creates highlight via selectionchange', async ({ page }) => {
      await simulateTouchDoubleTap(page, '[data-testid="para-2"]');

      // Wait for selectionchange debounce (400ms) + API call
      await waitForMarks(page);
      expect(await countUniqueHighlights(page)).toBe(1);

      // The mark text should contain the paragraph content
      const markText = await page.locator('mark[data-highlight-id]').first().textContent();
      expect(markText).toContain('second paragraph');
    });

    test('popover stays visible on narrow mobile viewport', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.reload();
      await expect(page.locator('[data-testid="highlight-layer"]')).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByTestId('article-content')).toBeVisible({ timeout: 5000 });

      await page.locator('[data-testid="para-1"]').dblclick();
      await waitForMarks(page);

      const popover = page.locator('[data-testid="highlight-popover"]');
      await expect(popover).toBeVisible({ timeout: 3000 });

      const popoverRect = await popover.boundingBox();
      expect(popoverRect).toBeTruthy();
      expect(popoverRect!.x).toBeGreaterThanOrEqual(0);
      expect(popoverRect!.x + popoverRect!.width).toBeLessThanOrEqual(320);
      expect(popoverRect!.y).toBeGreaterThanOrEqual(0);
      expect(popoverRect!.y + popoverRect!.height).toBeLessThanOrEqual(568);

      await exitEditMode(page);
    });

    test('double-tap on existing highlight does not create duplicate', async ({ page }) => {
      await page.locator('[data-testid="para-1"]').dblclick();
      await waitForMarks(page);
      await exitEditMode(page);

      // Double-tapping an existing highlight must not create a second one: the
      // dblclick handler bails on existing marks, so no creation request should
      // fire. Guard against a regression by failing if a POST /api/highlights is
      // issued in response to the tap.
      let createRequests = 0;
      const onRequest = (req: import('@playwright/test').Request) => {
        if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/highlights') {
          createRequests++;
        }
      };
      page.on('request', onRequest);

      await simulateTouchDoubleTap(page, 'mark[data-highlight-id]');

      // The mark count stays at exactly one, and no creation request was issued.
      await expect(page.locator('mark[data-highlight-id]')).toHaveCount(1);
      expect(await countUniqueHighlights(page)).toBe(1);

      page.off('request', onRequest);
      expect(createRequests).toBe(0);
    });
  });
});
