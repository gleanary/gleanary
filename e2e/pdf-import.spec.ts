import { test, expect, type Page, type APIResponse } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Multi-page fixture has a real text layer — needed for selection assertions
const pdfBuffer = readFileSync(
  join(__dirname, '../__tests__/mocks/fixtures/pdfs/multi-page-text.pdf'),
);

test.describe('PDF Import — reader view toggle', () => {
  const createdIds: number[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of createdIds.splice(0)) {
      await page.request.delete(`/api/articles/${id}`).catch(() => {});
    }
  });

  /**
   * Uploads the fixture PDF, self-healing against orphaned state: the API
   * inserts the article row *before* running OCR, so a run that never gets a
   * response back (client-side timeout, crash) leaves a permanent row behind
   * even though its cleanup never registered the id. That row's content hash
   * then makes every later run 409 immediately. On 409, delete the existing
   * article (the response includes its id) and retry once.
   */
  async function uploadFixture(page: Page): Promise<APIResponse> {
    const post = () =>
      page.request.post('/api/upload', {
        multipart: {
          file: { name: 'test.pdf', mimeType: 'application/pdf', buffer: pdfBuffer },
          title: 'E2E PDF Import Test',
        },
      });

    let res = await post();
    if (res.status() === 409) {
      const { existingId } = (await res.json().catch(() => ({}))) as { existingId?: number };
      if (existingId) await page.request.delete(`/api/articles/${existingId}`).catch(() => {});
      res = await post();
    }
    return res;
  }

  test('upload → inbox shows page count → toggle to original → text selectable → toggle back', async ({
    page,
  }) => {
    // Real Mistral OCR runs synchronously at import time, and mistral-ocr.ts's
    // own timeouts (60s file-upload + 120s OCR-call) mean the worst case for a
    // single upload is 180s on their own, before the rest of the journey below.
    // The previous 120s test budget only covered the OCR-call leg and got
    // killed mid-request on a slow-but-successful upload leg. Give this test
    // headroom for the full documented worst case plus the journey after it.
    test.setTimeout(200_000);

    // Upload via multipart form
    const uploadRes = await uploadFixture(page);
    // Register cleanup before asserting so a duplicate-URL 409 doesn't leak
    // this article past the test and poison later runs.
    const uploadBody = await uploadRes.json().catch(() => null);
    if (uploadBody?.article?.id) createdIds.push(uploadBody.article.id);
    expect(uploadRes.ok()).toBeTruthy();
    const { article } = uploadBody;
    // pageCount is set by local pdf preflight — deterministic for this fixture
    expect(article.pageCount).toBeGreaterThan(0);

    // Inbox: article card shows page count label (e.g. "2 pages")
    await page.goto('/');
    const articleLink = page.locator(`a[href="/reader/${article.id}"]`);
    await expect(articleLink).toBeVisible({ timeout: 5000 });
    await expect(articleLink).toContainText(`${article.pageCount} page`);

    // Reader: navigate and verify page count in header
    await articleLink.click();
    await page.waitForURL(`/reader/${article.id}`);
    await expect(page.getByTestId('article-title')).toContainText('E2E PDF Import Test', {
      timeout: 5000,
    });
    await expect(page.getByTestId('article-meta')).toContainText(`${article.pageCount} page`);

    // Default view is extracted — "Original PDF" toggle button is visible
    const originalBtn = page.getByRole('button', { name: /original pdf/i });
    await expect(originalBtn).toBeVisible();

    // Toggle to original PDF view
    await originalBtn.click();
    const extractedBtn = page.getByRole('button', { name: /extracted/i });
    await expect(extractedBtn).toBeVisible();

    // Wait for the first page canvas to finish rendering (set by onRenderSuccess)
    await expect(page.locator('[data-testid="pdf-page-rendered"]')).toBeVisible({
      timeout: 15000,
    });

    // Text layer must be present and selectable
    const selectionLength = await page.evaluate(() => {
      const doc = document.querySelector('.react-pdf__Document');
      if (!doc) return 0;
      const range = document.createRange();
      range.selectNodeContents(doc);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      return window.getSelection()?.toString().length ?? 0;
    });
    expect(selectionLength).toBeGreaterThan(0);

    // Toggle back to extracted view
    await extractedBtn.click();
    await expect(page.getByRole('button', { name: /original pdf/i })).toBeVisible();
  });
});
