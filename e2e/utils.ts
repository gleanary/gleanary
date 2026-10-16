import { type Page, type Response } from '@playwright/test';

/**
 * Waits for the next HTTP response whose URL pathname and request method match.
 *
 * Start the wait BEFORE triggering the action that fires the request, then await
 * it so the response cannot be missed and a follow-up read cannot race the write:
 *
 *   const res = waitForApiResponse(page, `/api/articles/${id}`, 'PATCH');
 *   await button.click();
 *   expect((await res).ok()).toBe(true);
 *
 * The pathname is compared against `new URL(res.url()).pathname` (never a substring
 * `includes`), so query strings are ignored and unrelated routes cannot match. Pass
 * a RegExp when the id in the path is not known ahead of time.
 *
 * @param page - Playwright page to listen on
 * @param pathname - Exact URL pathname to match, or a RegExp tested against it
 * @param method - HTTP method to match (e.g. 'POST', 'PATCH', 'DELETE')
 * @returns Promise resolving to the first matching Playwright Response
 */
export function waitForApiResponse(
  page: Page,
  pathname: string | RegExp,
  method: string,
): Promise<Response> {
  return page.waitForResponse((res) => {
    const path = new URL(res.url()).pathname;
    const pathMatches = typeof pathname === 'string' ? path === pathname : pathname.test(path);
    return pathMatches && res.request().method() === method;
  });
}

/**
 * Waits for at least `minCount` highlight marks to appear in the DOM.
 *
 * @param page - Playwright page to poll
 * @param minCount - minimum number of `mark[data-highlight-id]` elements to wait for
 */
export async function waitForMarks(page: Page, minCount = 1): Promise<void> {
  await page.waitForFunction(
    (min) => document.querySelectorAll('mark[data-highlight-id]').length >= min,
    minCount,
    { timeout: 15000 },
  );
}

/**
 * Named Playwright test locks for specs that delete highlights during cleanup.
 *
 * Why: `/review` is a server component that SSR-renders a random sample of up to
 * 15 due highlights drawn from the WHOLE database (getDueHighlights, ORDER BY
 * RANDOM()), so `page.route` cannot scope it. Under local parallel workers, the
 * specs listed here create highlights and delete their articles in
 * afterAll/afterEach (which cascade-deletes the highlights). If a review card's
 * highlight vanishes before "Got it", POST /api/review 404s and the session never
 * advances, so the review spec times out.
 *
 * Reader/writer scheme: each writer spec holds exactly one lock on its top-level
 * describe, so writers still run in parallel with each other. The Daily Review
 * spec holds ALL of them ({@link ALL_HIGHLIGHT_WRITER_LOCKS}), so it is only
 * scheduled when no writer is running, and no writer starts while it runs.
 * Playwright holds a job's locks for the whole group, including beforeAll/afterAll.
 *
 * Add an entry here (and lock that spec's top-level describe) whenever a new
 * spec deletes highlights, directly or via article deletion.
 */
export const HIGHLIGHT_WRITER_LOCKS = {
  draftFlow: 'highlight-writer:draft-flow',
  globalSearch: 'highlight-writer:global-search',
  highlights: 'highlight-writer:highlights',
  mathArticle: 'highlight-writer:math-article',
  saveAndRead: 'highlight-writer:save-and-read',
  search: 'highlight-writer:search',
  selectionHandles: 'highlight-writer:selection-handles',
} as const;

/** Every highlight-writer lock; held by the Daily Review spec to exclude all writers. */
export const ALL_HIGHLIGHT_WRITER_LOCKS = Object.values(HIGHLIGHT_WRITER_LOCKS);
