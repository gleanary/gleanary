import { test, expect, type Page } from '@playwright/test';

test.describe('Mobile Save Page', () => {
  const createdIds: number[] = [];

  /** Seed an article and register it for cleanup; fails the test loudly if the create fails. */
  async function createArticle(page: Page, url: string, title: string): Promise<void> {
    const res = await page.request.post('/api/articles', {
      data: {
        url,
        title,
        contentHtml: '<p>Test content</p>',
        contentText: 'Test content',
      },
    });
    expect(res.ok()).toBe(true);
    const { article } = await res.json();
    createdIds.push(article.id);
  }

  test.afterEach(async ({ page }) => {
    for (const id of createdIds.splice(0)) {
      await page.request.delete(`/api/articles/${id}`).catch(() => {});
    }
  });

  test('saves article via manual URL paste', async ({ page }) => {
    const uniqueSuffix = Date.now();
    const testUrl = `https://example.com/e2e-manual-save-${uniqueSuffix}`;

    // Saving a fresh URL makes the server fetch it externally — stub the parse API
    // at the browser boundary so the flow is deterministic without network reachability.
    // The real parse contract is covered by the duplicate-path tests below (409) and
    // the article-parser integration tests (201).
    let parsedUrl: string | undefined;
    await page.route('**/api/articles/parse', async (route) => {
      parsedUrl = (route.request().postDataJSON() as { url?: string }).url;
      await route.fulfill({ status: 201, json: { article: { id: 999999 } } });
    });

    await page.goto('/save');

    // Type URL into input
    const urlInput = page.locator('[data-testid="save-url-input"]');
    await expect(urlInput).toBeVisible({ timeout: 5000 });
    await urlInput.fill(testUrl);

    // Click save button
    const saveButton = page.locator('[data-testid="save-submit-button"]');
    await saveButton.click();

    // Deterministic success path: status shows "Saved!" with a link to the article
    const status = page.locator('[data-testid="save-status"]');
    await expect(status).toContainText('Saved!', { timeout: 10000 });
    await expect(page.locator('[data-testid="save-open-link"]')).toBeVisible();
    expect(parsedUrl).toBe(testUrl);
  });

  test('auto-saves when URL query param is provided', async ({ page }) => {
    // Pre-create the article so the auto-save hits the deterministic duplicate path
    // (the parse route dedups by URL before any external fetch)
    const uniqueSuffix = Date.now();
    const testUrl = `https://example.com/e2e-auto-save-${uniqueSuffix}`;
    await createArticle(page, testUrl, `Auto Save Test ${uniqueSuffix}`);

    // Navigate to save page with url param — should auto-save and show duplicate
    await page.goto(`/save?url=${encodeURIComponent(testUrl)}`);

    const status = page.locator('[data-testid="save-status"]');
    await expect(status).toBeVisible({ timeout: 10000 });
    await expect(status).toContainText(/already/i);
  });

  test('shows duplicate message for already-saved URL', async ({ page }) => {
    const uniqueSuffix = Date.now();
    const testUrl = `https://example.com/e2e-dup-${uniqueSuffix}`;
    await createArticle(page, testUrl, `Dup Test ${uniqueSuffix}`);

    // Try to save the same URL
    await page.goto('/save');
    const urlInput = page.locator('[data-testid="save-url-input"]');
    await urlInput.fill(testUrl);

    const saveButton = page.locator('[data-testid="save-submit-button"]');
    await saveButton.click();

    const status = page.locator('[data-testid="save-status"]');
    await expect(status).toBeVisible({ timeout: 10000 });
    await expect(status).toContainText(/already/i);
  });
});
