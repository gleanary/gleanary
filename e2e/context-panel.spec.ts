import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { waitForApiResponse } from './utils';

// Narrow enough that the 320px panel (and the 280px sidebar) narrow the 680px reader
// column, so toggling really reflows the text. At the default 1280px nothing would move.
test.use({ viewport: { width: 900, height: 720 } });

function articleHtml(paragraphs: number) {
  return Array.from(
    { length: paragraphs },
    (_, i) =>
      `<p>Paragraph ${i}. ${'The quick brown fox jumps over the lazy dog while the reader keeps their place. '.repeat(5)}</p>`,
  ).join('');
}
const LONG_HTML = articleHtml(60);

const pdfFixture = readFileSync(
  join(__dirname, '../__tests__/mocks/fixtures/pdfs/multi-page-text.pdf'),
);

const trigger = (page: Page) => page.getByRole('button', { name: 'Toggle details panel' });
const panel = (page: Page) => page.getByTestId('context-panel');
const wrapper = (page: Page) => page.getByTestId('content-wrapper');

/** Expects the panel to be open or closed, from the trigger state and the push margin. */
async function expectPanelOpen(page: Page, open: boolean) {
  await expect(trigger(page)).toHaveAttribute('aria-expanded', String(open));
  await expect(wrapper(page)).toHaveCSS('margin-right', open ? '320px' : '0px');
}

/** Index of the first content paragraph still visible at the viewport top, its top and line height. */
function topParagraph(page: Page) {
  return page.evaluate(() => {
    const paragraphs = Array.from(document.querySelectorAll<HTMLElement>('.article-content p'));
    for (const [index, p] of paragraphs.entries()) {
      const rect = p.getBoundingClientRect();
      if (rect.bottom <= 0) continue;
      return { index, top: rect.top, lineHeight: parseFloat(getComputedStyle(p).lineHeight) };
    }
    return null;
  });
}

/** The `[data-page]` element at the viewport top and how far (0–1 of its height) into it. */
function topPdfPage(page: Page) {
  return page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-page]'))) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= 0) continue;
      return { page: el.dataset.page, offset: -rect.top / rect.height };
    }
    return null;
  });
}

function contentWidth(page: Page) {
  return page.evaluate(
    () =>
      document.querySelector('.article-content, .react-pdf__Document')?.getBoundingClientRect()
        .width ?? 0,
  );
}

/** Lets the slide, the PDF width debounce, re-rendering and the place-keeping restore settle. */
async function settle(page: Page, ms = 1_200) {
  await page.waitForTimeout(ms);
}

test.describe('Context panel (desktop side sheet)', () => {
  const createdIds: number[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of createdIds.splice(0)) {
      await page.request.delete(`/api/articles/${id}`).catch(() => {});
    }
  });

  async function createArticle(page: Page, title: string, contentHtml = LONG_HTML) {
    const res = await page.request.post('/api/articles', {
      data: {
        url: `https://example.com/e2e-context-panel-${Date.now()}-${Math.random()}`,
        title,
        contentHtml,
        contentText: contentHtml.replace(/<[^>]+>/g, ' '),
        status: 'inbox',
      },
    });
    expect(res.ok()).toBe(true);
    const { article } = await res.json();
    createdIds.push(article.id);
    return article.id as number;
  }

  /** Opens the reader and waits for hydration (the trigger appears once content registers). */
  async function openReader(page: Page, id: number) {
    await page.goto(`/reader/${id}`);
    await expect(page.getByTestId('article-content').first()).toBeVisible({ timeout: 10_000 });
    await expect(trigger(page)).toBeVisible({ timeout: 10_000 });
  }

  test('trigger and shortcut toggle the panel, which pushes the content', async ({ page }) => {
    const id = await createArticle(page, 'E2E Context Panel Toggle');
    await openReader(page, id);
    await expectPanelOpen(page, false);

    await trigger(page).click();
    await expectPanelOpen(page, true);
    await expect(panel(page)).toContainText('Details');
    await expect(panel(page)).toContainText('About');

    await trigger(page).click();
    await expectPanelOpen(page, false);

    await page.keyboard.press('Control+Shift+Backslash');
    await expectPanelOpen(page, true);
    await page.keyboard.press('Control+Shift+Backslash');
    await expectPanelOpen(page, false);
  });

  test('only one side panel is open at a time', async ({ page }) => {
    const id = await createArticle(page, 'E2E Context Panel Exclusion');
    await page.addInitScript(() => localStorage.setItem('sidebar-open', 'true'));
    await openReader(page, id);
    const hamburger = page.getByRole('button', { name: 'Open navigation' });
    await expect(hamburger).toBeHidden();

    // Opening the panel closes the sidebar
    await trigger(page).click();
    await expectPanelOpen(page, true);
    await expect(hamburger).toBeVisible();
    await expect(wrapper(page)).toHaveCSS('margin-left', '0px');

    // Opening the sidebar from the hamburger closes the panel
    await hamburger.click();
    await expect(hamburger).toBeHidden();
    await expectPanelOpen(page, false);

    // Swap back with the panel shortcut, then open the sidebar with Ctrl+\
    await page.keyboard.press('Control+Shift+Backslash');
    await expectPanelOpen(page, true);
    await expect(hamburger).toBeVisible();
    await page.keyboard.press('Control+Backslash');
    await expect(hamburger).toBeHidden();
    await expectPanelOpen(page, false);
  });

  test('stays open across client navigation and is closed after a reload', async ({ page }) => {
    const first = await createArticle(page, `E2E Context Panel Nav A ${Date.now()}`);
    const second = await createArticle(page, `E2E Context Panel Nav B ${Date.now()}`);

    await page.goto('/');
    await page.locator(`a[href="/reader/${first}"]`).click();
    await page.waitForURL(`/reader/${first}`);
    await expect(trigger(page)).toBeVisible({ timeout: 10_000 });
    await trigger(page).click();
    await expectPanelOpen(page, true);

    // Back to the inbox (no panel there): no trigger and no right margin
    await page.getByRole('button', { name: 'Back' }).click();
    await page.waitForURL('/');
    await expect(trigger(page)).toHaveCount(0);
    await expect(wrapper(page)).toHaveCSS('margin-right', '0px');

    // Into the second article: still open, with the new page's content
    await page.locator(`a[href="/reader/${second}"]`).click();
    await page.waitForURL(`/reader/${second}`);
    await expect(page.getByTestId('article-title')).toContainText('Nav B');
    await expectPanelOpen(page, true);
    await expect(panel(page)).toContainText('About');

    await page.reload();
    await expect(trigger(page)).toBeVisible({ timeout: 10_000 });
    await expectPanelOpen(page, false);
  });

  test('toggling mid-article keeps the top paragraph in place (HTML)', async ({ page }) => {
    const id = await createArticle(page, 'E2E Context Panel Place HTML');
    await openReader(page, id);

    await page.evaluate(() => window.scrollTo({ top: 4000, behavior: 'instant' }));
    await settle(page, 300);
    const before = await topParagraph(page);
    expect(before).not.toBeNull();
    const widthBefore = await contentWidth(page);

    await trigger(page).click();
    await expectPanelOpen(page, true);
    await settle(page);
    expect(await contentWidth(page)).toBeLessThan(widthBefore);
    const opened = await topParagraph(page);
    expect(opened?.index).toBe(before!.index);
    expect(Math.abs(opened!.top - before!.top)).toBeLessThanOrEqual(before!.lineHeight);

    await page.keyboard.press('Control+Shift+Backslash');
    await expectPanelOpen(page, false);
    await settle(page);
    const closed = await topParagraph(page);
    expect(closed?.index).toBe(before!.index);
    expect(Math.abs(closed!.top - before!.top)).toBeLessThanOrEqual(before!.lineHeight);
  });

  test('toggling mid-document keeps the top PDF page in place (original view)', async ({
    page,
  }) => {
    // Real OCR may run at import time (see pdf-import.spec.ts); allow its worst case.
    test.setTimeout(200_000);
    // A unique trailing comment gives a distinct content hash, so this upload never
    // collides with pdf-import.spec.ts's dedup check when both run in parallel.
    const buffer = Buffer.concat([pdfFixture, Buffer.from(`\n%e2e-context-panel-${Date.now()}\n`)]);
    const uploadRes = await page.request.post('/api/upload', {
      multipart: {
        file: { name: 'context-panel.pdf', mimeType: 'application/pdf', buffer },
        title: 'E2E Context Panel Place PDF',
      },
      timeout: 190_000,
    });
    const uploadBody = await uploadRes.json().catch(() => null);
    if (uploadBody?.article?.id) createdIds.push(uploadBody.article.id);
    expect(uploadRes.ok()).toBe(true);
    const id = uploadBody.article.id as number;

    await page.addInitScript((articleId) => {
      localStorage.setItem(`article_view_${articleId}`, 'original');
    }, id);
    await page.goto(`/reader/${id}`);
    await expect(trigger(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('pdf-page-rendered')).toBeVisible({ timeout: 15_000 });

    // Scroll 30% into page 2
    await page.evaluate(() => {
      const rect = document.querySelector('[data-page="2"]')!.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + rect.top + rect.height * 0.3, behavior: 'instant' });
    });
    await settle(page, 1_000);
    const before = await topPdfPage(page);
    expect(before?.page).toBe('2');
    const widthBefore = await contentWidth(page);

    await trigger(page).click();
    await expectPanelOpen(page, true);
    await settle(page, 2_000);
    expect(await contentWidth(page)).toBeLessThan(widthBefore);
    const opened = await topPdfPage(page);
    expect(opened?.page).toBe(before!.page);
    expect(Math.abs(opened!.offset - before!.offset)).toBeLessThanOrEqual(0.02);

    await trigger(page).click();
    await expectPanelOpen(page, false);
    await settle(page, 2_000);
    const closed = await topPdfPage(page);
    expect(closed?.page).toBe(before!.page);
    expect(Math.abs(closed!.offset - before!.offset)).toBeLessThanOrEqual(0.02);
  });

  test('reloading with the sidebar open restores the saved position', async ({ page }) => {
    const id = await createArticle(page, 'E2E Context Panel Reload Sidebar');
    const anchorBlock = 30;
    const patch = await page.request.patch(`/api/articles/${id}`, {
      data: { readingProgress: 0.5, readingAnchorBlock: anchorBlock, readingAnchorOffset: 0 },
    });
    expect(patch.ok()).toBe(true);

    await page.addInitScript(() => localStorage.setItem('sidebar-open', 'true'));
    await openReader(page, id);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    await settle(page);

    const top = await topParagraph(page);
    expect(top?.index).toBe(anchorBlock);
    expect(Math.abs(top!.top)).toBeLessThanOrEqual(top!.lineHeight);
  });

  test('toggling the panel never advances reading progress', async ({ page }) => {
    test.slow();
    // A short article: the content scales with the column width but the viewport and the
    // footer do not, so closing the panel raises the scroll ratio by a few percent
    const id = await createArticle(page, 'E2E Context Panel Progress', articleHtml(15));
    await openReader(page, id);
    await trigger(page).click();
    await expectPanelOpen(page, true);
    await settle(page, 600);

    // With the panel open, scroll mid-article and wait for the debounced progress save
    const saved = waitForApiResponse(
      page,
      `/api/articles/${id}`,
      'PATCH',
      (body) => typeof (body as { readingProgress?: unknown } | null)?.readingProgress === 'number',
    );
    await page.evaluate(() =>
      window.scrollTo({ top: document.documentElement.scrollHeight * 0.4, behavior: 'instant' }),
    );
    const savedRes = await saved;
    expect(savedRes.ok()).toBe(true);
    const savedProgress = (savedRes.request().postDataJSON() as { readingProgress: number })
      .readingProgress;

    const progressSaves: number[] = [];
    page.on('request', (req) => {
      if (req.method() !== 'PATCH' || new URL(req.url()).pathname !== `/api/articles/${id}`) return;
      const body = req.postDataJSON() as { readingProgress?: number } | null;
      if (typeof body?.readingProgress === 'number') progressSaves.push(body.readingProgress);
    });

    // Close, open and close again without scrolling (closing widens the column and
    // shortens the page, which pushes the scroll ratio above the saved value)
    await trigger(page).click();
    await expectPanelOpen(page, false);
    await settle(page, 600);
    await page.keyboard.press('Control+Shift+Backslash');
    await expectPanelOpen(page, true);
    await settle(page, 600);
    await trigger(page).click();
    await expectPanelOpen(page, false);

    // Longer than the 5s progress debounce
    await page.waitForTimeout(7_000);
    for (const progress of progressSaves) expect(progress).toBeLessThanOrEqual(savedProgress);

    const res = await page.request.get(`/api/articles/${id}`);
    const { article } = await res.json();
    expect(article.readingProgress).toBeLessThanOrEqual(savedProgress);
  });

  test('Escape inside the panel closes it without navigating back', async ({ page }) => {
    const id = await createArticle(page, 'E2E Context Panel Escape');
    await openReader(page, id);

    // Keyboard activation moves focus to the close button
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expectPanelOpen(page, true);
    await expect(panel(page).getByRole('button', { name: 'Close details panel' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expectPanelOpen(page, false);
    await expect(trigger(page)).toBeFocused();
    expect(new URL(page.url()).pathname).toBe(`/reader/${id}`);
  });
});
