const HTTP_URL = /https?:\/\/[^\s<>"“”«»]+/i;
// Includes the typographic quotes/ellipsis mobile apps put around shared links
const TRAILING_PUNCTUATION = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  ']',
  '}',
  ')',
  "'",
  '’',
  '…',
  '」',
  '）',
]);

/**
 * Strips trailing punctuation picked up from surrounding prose, keeping a closing
 * parenthesis only when it balances an opening one inside the URL (e.g. Wikipedia).
 * @param url - Raw URL match
 * @returns The URL without trailing sentence punctuation
 */
function trimTrailing(url: string): string {
  const opens = url.split('(').length - 1;
  let closes = url.split(')').length - 1;
  let end = url.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(url.charAt(end - 1))) {
    if (url.charAt(end - 1) === ')') {
      if (opens >= closes) break;
      closes--;
    }
    end--;
  }
  return url.slice(0, end);
}

/**
 * Finds the first http(s) URL in a share-sheet payload. Android apps often put the
 * link in `text` (sometimes after the title) rather than in `url`.
 * @param url - The `url` share-target param
 * @param text - The `text` share-target param
 * @returns The first http(s) URL found, or null when there is none
 */
export function extractSharedUrl(url: string | null, text: string | null): string | null {
  for (const candidate of [url, text]) {
    const match = candidate?.match(HTTP_URL);
    if (match) return trimTrailing(match[0]);
  }
  return null;
}
