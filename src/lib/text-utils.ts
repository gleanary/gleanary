/**
 * Strips HTML tags from a string, returning plain text.
 * @param html - HTML string to strip
 * @returns Plain text with tags removed
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncates a string to a maximum length, appending '...' if truncated.
 * @param text - The string to truncate
 * @param maxLen - Maximum length (default 300)
 * @returns Truncated string
 */
export function truncate(text: string, maxLen = 300): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + '...' : text;
}

/**
 * Computes word count from a plain text string.
 * Splits on whitespace and filters out empty segments.
 * @param text - Plain text input
 * @returns Number of words
 */
export function computeWordCount(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Strips path separators and the .pdf extension from a raw filename for use
 * as an article title. Preserves non-ASCII characters (French, CJK titles).
 * Non-ASCII stripping for HTTP Content-Disposition headers belongs at the call site.
 * @param raw - Raw filename or user-supplied string
 * @returns Sanitized title, or empty string if nothing meaningful remains
 */
export function sanitizeTitle(raw: string): string {
  return raw
    .replace(/[/\\]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\.pdf$/i, '')
    .trim()
    .slice(0, 500);
}

/**
 * Strips a leading/trailing Markdown code fence (```html … ```) from AI output.
 * Trims surrounding whitespace first so fences at either end are matched.
 * @param text - Raw model output that may be wrapped in a code fence
 * @returns The text with the outer fence removed
 */
export function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:html)?\n?/, '')
    .replace(/\n?```$/, '');
}

/** Average adult reading speed in words per minute. */
export const AVERAGE_WPM = 238;

/**
 * Computes estimated reading time, or page count label for PDFs.
 * PDFs (pageCount set) always show pages, even when text extraction produced
 * a word count — see docs/modules/pdf-import.md §"Article cards".
 * @param wordCount - Number of words, or null for PDFs
 * @param pageCount - Number of pages (PDF only), optional
 * @returns Human-readable label (e.g., "5 min read" or "42 pages")
 */
export function readingTime(wordCount: number | null, pageCount?: number | null): string {
  if (pageCount) return `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`;
  const minutes = Math.max(1, Math.round((wordCount ?? 0) / AVERAGE_WPM));
  return `${minutes} min read`;
}

/**
 * Formats a date string into a human-readable format.
 * @param dateStr - ISO date string or date-like string
 * @returns Formatted date string (e.g., "January 15, 2024")
 */
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Formats a UTC-naive DB timestamp as a relative time (e.g. "5m ago").
 * DB rows come from `datetime('now')` which is UTC naive — the `+ 'Z'` suffix
 * tells the Date parser to treat the string as UTC.
 * @param dateStr - Timestamp string from the DB
 * @returns Relative time in short form, or a locale date after 30 days
 */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr + 'Z');
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
