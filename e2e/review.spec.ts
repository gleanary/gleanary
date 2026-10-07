import { test, expect, type APIRequestContext } from '@playwright/test';
import { waitForApiResponse } from './utils';

/**
 * Creates a highlight that is immediately due for review (new highlights
 * have null lastReviewed, so they are due by default).
 */
async function createDueHighlight(
  request: APIRequestContext,
  articleId: number,
  text: string,
): Promise<number> {
  const res = await request.post('/api/highlights', {
    data: { articleId, text },
  });
  const { highlight } = await res.json();
  return highlight.id;
}

test.describe('Daily Review Flow', () => {
  let articleId: number;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/articles', {
      data: {
        url: `https://example.com/e2e-review-${Date.now()}`,
        title: 'E2E Review Test Article',
        contentHtml: '<p>Article for review flow testing.</p>',
        contentText: 'Article for review flow testing.',
      },
    });
    const body = await res.json();
    articleId = body.article.id;
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/articles/${articleId}`).catch(() => {});
  });

  test('review card: reveal source → "Got it" advances to next card', async ({ page, request }) => {
    const suffix = Date.now();
    // Seed two due highlights so the session is guaranteed to have a next card
    // after the first "Got it" — this makes the advance a single deterministic
    // state (the next card) instead of an "or session complete" branch, and
    // actually verifies the test's stated behaviour (advancing to the next card).
    await createDueHighlight(request, articleId, `Review card test A ${suffix}`);
    await createDueHighlight(request, articleId, `Review card test B ${suffix}`);

    await page.goto('/review');

    // Progress indicator is visible and formatted as "N / M" (a trailing
    // "(K total due)" span may follow, so match the pattern as a substring).
    await expect(page.getByTestId('review-progress')).toBeVisible({ timeout: 5000 });
    expect(await page.getByTestId('review-progress').textContent()).toMatch(/\d+ \/ \d+/);

    // The highlight card (with the yellow accent border) is rendered
    await expect(page.getByTestId('review-card')).toBeVisible();

    // A fresh card always starts unrevealed: the reveal control is present. Reveal it.
    const revealButton = page.getByTestId('reveal-source');
    await expect(revealButton).toBeVisible();
    await revealButton.click();

    // After reveal: the rating actions appear
    await expect(page.getByTestId('got-it')).toBeVisible({ timeout: 3000 });
    await expect(page.getByTestId('review-again')).toBeVisible();

    // "Got it" records the review (POST /api/review) and advances the session.
    // Wait on that specific response before reading the resulting UI state.
    const reviewResponse = waitForApiResponse(page, '/api/review', 'POST');
    await page.getByTestId('got-it').click();
    expect((await reviewResponse).ok()).toBe(true);

    // With a guaranteed second due highlight, the session advances to the next
    // (unrevealed) card rather than completing.
    await expect(page.getByTestId('reveal-source')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('session-complete')).toHaveCount(0);
  });

  test('"Got it" increases review interval, "Review again" resets it', async ({ request }) => {
    const suffix = Date.now();
    const hlId = await createDueHighlight(request, articleId, `Interval test ${suffix}`);

    // Submit "got_it" review via API and check interval increases
    const gotItRes = await request.post('/api/review', {
      data: { highlightId: hlId, action: 'got_it' },
    });
    expect(gotItRes.ok()).toBe(true);
    const gotItBody = await gotItRes.json();
    expect(gotItBody.highlight.reviewInterval).toBe(1);
    expect(gotItBody.highlight.reviewCount).toBe(1);

    // Submit another "got_it" — interval should double
    const gotIt2Res = await request.post('/api/review', {
      data: { highlightId: hlId, action: 'got_it' },
    });
    expect(gotIt2Res.ok()).toBe(true);
    const gotIt2Body = await gotIt2Res.json();
    expect(gotIt2Body.highlight.reviewInterval).toBe(2);
    expect(gotIt2Body.highlight.reviewCount).toBe(2);

    // Submit "review_again" — interval should reset to 1
    const reviewAgainRes = await request.post('/api/review', {
      data: { highlightId: hlId, action: 'review_again' },
    });
    expect(reviewAgainRes.ok()).toBe(true);
    const reviewAgainBody = await reviewAgainRes.json();
    expect(reviewAgainBody.highlight.reviewInterval).toBe(1);
    expect(reviewAgainBody.highlight.reviewCount).toBe(3);
  });
});
