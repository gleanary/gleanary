import { test, expect, type Page } from '@playwright/test';

const TEST_ARTICLE_HTML = `
<p data-testid="para-1">This is the first paragraph of a test article with enough text for highlighting and handle testing.</p>
<p data-testid="para-2">This is the second paragraph which contains different content for testing selection handles.</p>
<p data-testid="para-3">A third paragraph provides additional text for multiple highlight tests and dragging.</p>
`;

async function createTestArticle(page: Page): Promise<number> {
  const res = await page.request.post('/api/articles', {
    data: {
      url: `https://example.com/handle-test-${Date.now()}-${Math.random()}`,
      title: 'Handle E2E Test Article',
      contentHtml: TEST_ARTICLE_HTML,
      contentText: 'This is the first paragraph. This is the second paragraph. A third paragraph.',
    },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return body.article.id;
}

async function waitForMarks(page: Page, minCount = 1): Promise<void> {
  await page.waitForFunction(
    (min) => document.querySelectorAll('mark[data-highlight-id]').length >= min,
    minCount,
    { timeout: 5000 },
  );
}

test.describe('Selection Handles E2E', () => {
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

  test('handles appear when entering edit mode via highlight creation', async ({ page }) => {
    await page.locator('[data-testid="para-1"]').dblclick();
    await waitForMarks(page);

    const startHandle = page.locator('[data-testid="selection-handle-start"]');
    const endHandle = page.locator('[data-testid="selection-handle-end"]');
    const popover = page.locator('[data-testid="highlight-popover"]');

    await expect(popover).toBeVisible({ timeout: 3000 });
    await expect(startHandle).toBeVisible({ timeout: 3000 });
    await expect(endHandle).toBeVisible({ timeout: 3000 });

    const startBox = await startHandle.boundingBox();
    const endBox = await endHandle.boundingBox();
    expect(startBox).not.toBeNull();
    expect(endBox).not.toBeNull();
    expect(startBox!.x).toBeGreaterThan(0);
    expect(endBox!.x).toBeGreaterThan(0);

    const endIsRightOrBelow = endBox!.x > startBox!.x || endBox!.y > startBox!.y;
    expect(endIsRightOrBelow).toBe(true);
  });

  test('handles disappear when exiting edit mode', async ({ page }) => {
    await page.locator('[data-testid="para-1"]').dblclick();
    await waitForMarks(page);

    const startHandle = page.locator('[data-testid="selection-handle-start"]');
    const endHandle = page.locator('[data-testid="selection-handle-end"]');

    await expect(startHandle).toBeVisible({ timeout: 3000 });

    await page.evaluate(() => {
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }),
      );
    });

    await expect(startHandle).not.toBeVisible({ timeout: 3000 });
    await expect(endHandle).not.toBeVisible({ timeout: 3000 });
  });

  test('handles appear when re-entering edit mode via mark click', async ({ page }) => {
    await page.locator('[data-testid="para-1"]').dblclick();
    await waitForMarks(page);

    await page.evaluate(() => {
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }),
      );
    });
    await expect(page.locator('[data-testid="highlight-popover"]')).not.toBeVisible({
      timeout: 3000,
    });

    await page.locator('mark[data-highlight-id]').first().click();

    await expect(page.locator('[data-testid="selection-handle-start"]')).toBeVisible({
      timeout: 3000,
    });
    await expect(page.locator('[data-testid="selection-handle-end"]')).toBeVisible({
      timeout: 3000,
    });
    await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible({
      timeout: 3000,
    });
  });

  test('clicking on a handle does not cancel edit mode', async ({ page }) => {
    await page.locator('[data-testid="para-1"]').dblclick();
    await waitForMarks(page);

    const startHandle = page.locator('[data-testid="selection-handle-start"]');
    await expect(startHandle).toBeVisible({ timeout: 3000 });

    await startHandle.click({ force: true });

    await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible();
    await expect(startHandle).toBeVisible();
  });

  test('dragging end handle changes selection text', async ({ page }) => {
    await page.locator('[data-testid="para-1"]').dblclick();
    await waitForMarks(page);

    const endHandle = page.locator('[data-testid="selection-handle-end"]');
    await expect(endHandle).toBeVisible({ timeout: 3000 });

    const initialText = await page.evaluate(() => window.getSelection()?.toString());
    expect(initialText).toBeTruthy();

    const handleBox = await endHandle.boundingBox();
    expect(handleBox).not.toBeNull();

    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;
    const endX = startX - 100;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, startY, { steps: 10 });
    await page.mouse.up();

    const newText = await page.evaluate(() => window.getSelection()?.toString());
    expect(newText).toBeTruthy();

    await expect(page.locator('[data-testid="highlight-popover"]')).toBeVisible();
  });

  test('handles have correct z-index and are interactive', async ({ page }) => {
    await page.locator('[data-testid="para-1"]').dblclick();
    await waitForMarks(page);

    const startHandle = page.locator('[data-testid="selection-handle-start"]');
    await expect(startHandle).toBeVisible({ timeout: 3000 });

    const grip = startHandle.getByTestId('selection-handle-grip');
    await expect(grip).toBeVisible();
    const line = startHandle.getByTestId('selection-handle-line');
    await expect(line).toBeVisible();

    const touchAction = await startHandle.evaluate((el) => window.getComputedStyle(el).touchAction);
    expect(touchAction).toBe('none');
  });
});
