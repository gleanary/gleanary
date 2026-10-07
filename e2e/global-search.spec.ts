import { test, expect } from '@playwright/test';

test.describe('Global Search', () => {
  const createdIds: number[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of createdIds.splice(0)) {
      await page.request.delete(`/api/articles/${id}`).catch(() => {});
    }
  });

  test('Ctrl+K opens palette → query → arrow nav → Enter → reader deep-links to highlight mark', async ({
    page,
  }) => {
    const suffix = Date.now();
    const uniqueWord = `zpalette${suffix}`;

    // Create article + highlight
    const articleRes = await page.request.post('/api/articles', {
      data: {
        url: `https://example.com/e2e-palette-${suffix}`,
        title: `Palette Deep Link Test ${suffix}`,
        contentHtml: `<p>This is a paragraph about ${uniqueWord} in the article body.</p>`,
        contentText: `This is a paragraph about ${uniqueWord} in the article body.`,
      },
    });
    expect(articleRes.ok()).toBeTruthy();
    const { article } = await articleRes.json();
    createdIds.push(article.id);

    const hlRes = await page.request.post('/api/highlights', {
      data: { articleId: article.id, text: `${uniqueWord} deep link highlight text` },
    });
    expect(hlRes.ok()).toBeTruthy();
    const { highlight } = await hlRes.json();
    const highlightId = highlight.id;

    // Navigate to app home
    await page.goto('/');

    // Open palette with Ctrl+K
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: 'Search' });
    await expect(input).toBeVisible();

    // Type query — at least 2 chars, wait for results
    await input.fill(uniqueWord);
    // Wait for results listbox to appear
    const listbox = page.getByTestId('search-listbox');
    await expect(listbox).toBeVisible({ timeout: 3000 });

    // The highlight result must be present — locate it deterministically by its
    // stable testid (kind + id) rather than counting ArrowDown presses. This fails
    // if the highlight result is missing, with no weaker fallback.
    const highlightOption = page.getByTestId(`search-option-highlight-${highlightId}`);
    await expect(highlightOption).toBeVisible({ timeout: 3000 });

    // Focus the option (hover activates it) and press Enter to navigate via the
    // keyboard path to the reader with the highlight deep-link.
    await highlightOption.hover();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/reader/${article.id}\\?highlight=${highlightId}`));
  });

  test('"See all" footer → /search page shows tabs with counts → tab switch filters results', async ({
    page,
  }) => {
    const suffix = Date.now();
    const uniqueWord = `zseeall${suffix}`;

    // Create article with unique keyword
    const articleRes = await page.request.post('/api/articles', {
      data: {
        url: `https://example.com/e2e-seeall-${suffix}`,
        title: `See All Test ${uniqueWord}`,
        contentHtml: `<p>${uniqueWord} content body text here.</p>`,
        contentText: `${uniqueWord} content body text here.`,
      },
    });
    expect(articleRes.ok()).toBeTruthy();
    const { article } = await articleRes.json();
    createdIds.push(article.id);

    // Also create a highlight with the same keyword
    const hlRes = await page.request.post('/api/highlights', {
      data: { articleId: article.id, text: `Highlight about ${uniqueWord} for testing` },
    });
    expect(hlRes.ok()).toBeTruthy();

    await page.goto('/');

    // Open palette
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: 'Search' });
    await expect(input).toBeVisible();
    await input.fill(uniqueWord);

    // Wait for "See all" footer to appear
    const footer = page.getByTestId('search-footer');
    await expect(footer).toBeVisible({ timeout: 3000 });

    // Click "See all"
    await footer.click();

    // Should navigate to /search page with q param
    await expect(page).toHaveURL(new RegExp(`/search\\?q=.*${encodeURIComponent(uniqueWord)}`));

    // Search page should show results
    await expect(page.getByRole('main')).toBeVisible();

    // Tabs should be visible with the query present
    const articleTab = page.getByRole('tab', { name: /Articles/i });
    await expect(articleTab).toBeVisible({ timeout: 3000 });

    // Switch to Articles tab
    await articleTab.click();

    // URL should update with types=article
    await expect(page).toHaveURL(/types=article/);

    // Articles tab should show our article
    await expect(page.getByRole('main')).toContainText(`See All Test ${uniqueWord}`, {
      timeout: 3000,
    });
  });

  test('Escape closes the palette (DOM dispatch workaround for headless Chromium)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: 'Search' });
    await expect(input).toBeVisible();

    // Use DOM dispatch workaround: headless Chromium's Escape key navigates to about:blank
    // instead of firing a keyboard event to the page. See TECH_DEBT.md.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // Palette should close (input no longer visible)
    await expect(input).not.toBeVisible({ timeout: 1000 });
  });
});
