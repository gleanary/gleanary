import { test, expect } from '@playwright/test';

test.describe('Highlight Search', () => {
  const createdIds: number[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of createdIds.splice(0)) {
      await page.request.delete(`/api/articles/${id}`).catch(() => {});
    }
  });

  test('create highlights with distinct text → search returns correct results', async ({
    page,
  }) => {
    const suffix = Date.now();

    // Create an article
    const articleRes = await page.request.post('/api/articles', {
      data: {
        url: `https://example.com/e2e-search-${suffix}`,
        title: 'E2E Search Test Article',
        contentHtml: '<p>Article content for search testing.</p>',
        contentText: 'Article content for search testing.',
      },
    });
    expect(articleRes.ok()).toBe(true);
    const { article } = await articleRes.json();
    createdIds.push(article.id);

    // Use a unique word (not just a number) as a suffix to ensure FTS5 tokenizes it
    const uniqueWord = `xtest${suffix}`;

    // Create 3 highlights with distinct, searchable text
    const highlightTexts = [
      `quantum entanglement ${uniqueWord} alpha`,
      `photosynthesis chlorophyll ${uniqueWord} beta`,
      `mitochondria powerhouse ${uniqueWord} gamma`,
    ];

    await Promise.all(
      highlightTexts.map(async (text) => {
        const res = await page.request.post('/api/highlights', {
          data: { articleId: article.id, text },
        });
        expect(res.ok()).toBe(true);
      }),
    );

    // Run independent search queries in parallel
    const [searchRes1, searchRes2, searchRes3, searchRes4] = await Promise.all([
      page.request.get(`/api/search?q=${uniqueWord} alpha&types=highlight`),
      page.request.get(`/api/search?q=${uniqueWord} beta&types=highlight`),
      page.request.get(`/api/search?q=${uniqueWord}&types=highlight`),
      page.request.get(`/api/search?q=xyznonexistent${suffix}&types=highlight`),
    ]);

    // Verify "alpha" search — should find exactly 1 highlight
    expect(searchRes1.ok()).toBe(true);
    const result1 = await searchRes1.json();
    expect(result1.results.highlights.length).toBe(1);
    // Snippet contains the matched text
    expect(result1.results.highlights[0].snippet).toContain('quantum entanglement');

    // Verify "beta" search — should find exactly 1 highlight
    expect(searchRes2.ok()).toBe(true);
    const result2 = await searchRes2.json();
    expect(result2.results.highlights.length).toBe(1);
    expect(result2.results.highlights[0].snippet).toContain('photosynthesis chlorophyll');

    // Verify unique word search — should find all 3
    expect(searchRes3.ok()).toBe(true);
    const result3 = await searchRes3.json();
    expect(result3.results.highlights.length).toBe(3);

    // Verify nonexistent term — should find 0
    expect(searchRes4.ok()).toBe(true);
    const result4 = await searchRes4.json();
    expect(result4.results.highlights.length).toBe(0);
  });

  test('search returns articles by title', async ({ page }) => {
    const suffix = Date.now();

    // Create an article with a unique searchable title
    const res = await page.request.post('/api/articles', {
      data: {
        url: `https://example.com/e2e-article-search-${suffix}`,
        title: `Bioluminescence Deep Ocean ${suffix}`,
        contentHtml: '<p>About deep sea creatures.</p>',
        contentText: 'About deep sea creatures.',
      },
    });
    expect(res.ok()).toBe(true);
    const { article: searchArticle } = await res.json();
    createdIds.push(searchArticle.id);

    // Search for the article by title keyword
    const searchRes = await page.request.get(`/api/search?q=bioluminescence&types=article`);
    expect(searchRes.ok()).toBe(true);
    const result = await searchRes.json();
    expect(result.results.articles.length).toBeGreaterThanOrEqual(1);
    expect(
      result.results.articles.some((a: { title: string }) => a.title.includes('Bioluminescence')),
    ).toBe(true);
  });

  test('navigating to /search auto-focuses the search input', async ({ page }) => {
    await page.goto('/search');

    const input = page.getByRole('textbox', { name: 'Search' });
    await expect(input).toBeFocused();
  });

  test('search with default types returns both articles and highlights', async ({ page }) => {
    const suffix = Date.now();
    const keyword = `terraforming${suffix}`;

    // Create an article with the keyword in the title
    const articleRes = await page.request.post('/api/articles', {
      data: {
        url: `https://example.com/e2e-combined-search-${suffix}`,
        title: `${keyword} Mars Exploration`,
        contentHtml: `<p>${keyword} is a fascinating topic.</p>`,
        contentText: `${keyword} is a fascinating topic.`,
      },
    });
    expect(articleRes.ok()).toBe(true);
    const { article } = await articleRes.json();
    createdIds.push(article.id);

    // Create a highlight with the same keyword
    const hlRes = await page.request.post('/api/highlights', {
      data: { articleId: article.id, text: `The concept of ${keyword} involves complex processes` },
    });
    expect(hlRes.ok()).toBe(true);

    // Search with default types (all four entity types)
    const searchRes = await page.request.get(`/api/search?q=${keyword}`);
    expect(searchRes.ok()).toBe(true);
    const result = await searchRes.json();
    expect(result.results.articles.length).toBeGreaterThanOrEqual(1);
    expect(result.results.highlights.length).toBeGreaterThanOrEqual(1);
    expect(result.totals.article).toBeGreaterThanOrEqual(1);
    expect(result.totals.highlight).toBeGreaterThanOrEqual(1);
  });
});
