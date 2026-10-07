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
