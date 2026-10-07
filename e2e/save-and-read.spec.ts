import { test, expect } from '@playwright/test';
import { waitForApiResponse } from './utils';

test.describe('Save Article and Read', () => {
  const createdIds: number[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of createdIds.splice(0)) {
      await page.request.delete(`/api/articles/${id}`).catch(() => {});
    }
  });

  test('save article via API → appears in inbox → read in reader view', async ({ page }) => {
    const uniqueSuffix = Date.now();
    // Create an article via the API (bypasses external fetch)
    const articleData = {
      url: `https://example.com/e2e-save-read-${uniqueSuffix}`,
      title: `E2E Save and Read Article ${uniqueSuffix}`,
      contentHtml:
        '<h2>Introduction</h2><p>This is a test article created for the E2E save-and-read flow.</p><p>It has multiple paragraphs for reading.</p>',
      contentText:
        'Introduction This is a test article created for the E2E save-and-read flow. It has multiple paragraphs for reading.',
      siteName: 'Example Blog',
      author: 'Test Author',
    };

    const createRes = await page.request.post('/api/articles', { data: articleData });
    expect(createRes.ok()).toBe(true);
    const { article } = await createRes.json();
    const articleId = article.id;
    createdIds.push(articleId);

    // Navigate to inbox and verify article appears (use link href for uniqueness)
    await page.goto('/');
    const articleLink = page.locator(`a[href="/reader/${articleId}"]`);
    await expect(articleLink).toBeVisible({ timeout: 5000 });

    // Click on the article to open reader view
    await articleLink.click();
    await page.waitForURL(`/reader/${articleId}`);

    // Verify reader view renders article content
    await expect(page.getByTestId('article-title')).toContainText(
      `E2E Save and Read Article ${uniqueSuffix}`,
      {
        timeout: 5000,
      },
    );
    await expect(page.getByTestId('article-content')).toBeVisible();
    await expect(page.getByTestId('article-content')).toContainText(
      'test article created for the E2E',
    );

    // Verify metadata renders
    await expect(page.getByTestId('article-byline')).toContainText('Test Author');
  });

  test('article status updates from inbox → archived via Archive button', async ({ page }) => {
    // Create article
    const createRes = await page.request.post('/api/articles', {
      data: {
        url: `https://example.com/e2e-status-${Date.now()}`,
        title: 'E2E Status Update Article',
        contentHtml: '<p>Content for status test.</p>',
        contentText: 'Content for status test.',
        status: 'inbox',
      },
    });
    expect(createRes.ok()).toBe(true);
    const { article } = await createRes.json();
    createdIds.push(article.id);

    // Open reader view
    await page.goto(`/reader/${article.id}`);
    await expect(page.getByTestId('article-content')).toBeVisible({ timeout: 5000 });

    // Click Archive button to finish the article. The click fires an async PATCH
    // to /api/articles/:id; wait on that specific response (and assert it succeeded)
    // before reading the status back, so the GET can't race ahead of the write.
    const archiveButton = page.getByTestId('archive-footer-button');
    await expect(archiveButton).toBeVisible({ timeout: 3000 });
    await expect(archiveButton).toContainText('Archive');
    const patchResponse = waitForApiResponse(page, `/api/articles/${article.id}`, 'PATCH');
    await archiveButton.click();
    expect((await patchResponse).ok()).toBe(true);

    // Verify via API that status is now 'archived' and readAt was stamped
    const getRes = await page.request.get(`/api/articles/${article.id}`);
    expect(getRes.ok()).toBe(true);
    const updated = await getRes.json();
    expect(updated.article.status).toBe('archived');
    expect(updated.article.readAt).toBeDefined();
  });

  test('highlight persists across reload in reader view', async ({ page }) => {
    // Create article with enough content for highlighting
    const createRes = await page.request.post('/api/articles', {
      data: {
        url: `https://example.com/e2e-persist-${Date.now()}`,
        title: 'E2E Highlight Persistence',
        contentHtml:
          '<p data-testid="persist-para">This paragraph will be highlighted and should persist after reload.</p>',
        contentText: 'This paragraph will be highlighted and should persist after reload.',
      },
    });
    expect(createRes.ok()).toBe(true);
    const { article } = await createRes.json();
    createdIds.push(article.id);

    // Open reader, create a highlight
    await page.goto(`/reader/${article.id}`);
    await expect(page.locator('[data-testid="highlight-layer"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="persist-para"]').dblclick();
    await page.waitForFunction(
      () => document.querySelectorAll('mark[data-highlight-id]').length >= 1,
      null,
      { timeout: 5000 },
    );

    // Reload and verify highlight still exists
    await page.reload();
    await expect(page.locator('[data-testid="highlight-layer"]')).toBeVisible({ timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelectorAll('mark[data-highlight-id]').length >= 1,
      null,
      { timeout: 5000 },
    );

    const markText = await page.locator('mark[data-highlight-id]').first().textContent();
    expect(markText).toContain('highlighted and should persist');
  });
});
