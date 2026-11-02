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
 * Parses an article's `ai_tags` column (a JSON array of tag names).
 * Malformed values never throw: they yield no tags. This module is also bundled for the
 * client, so it does not log itself; server callers pass `onInvalid` to log a warning.
 * @param raw - The stored JSON string, or null when the article has no tags
 * @param onInvalid - Called when `raw` is present but malformed
 * @returns The distinct tag names, or [] when missing or malformed
 */
export function parseAiTags(raw: string | null, onInvalid?: () => void): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')) {
      return [...new Set(parsed)];
    }
  } catch {
    // Invalid JSON: handled as malformed below
  }
  onInvalid?.();
  return [];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Parses a timestamp, reading a zone-less date-time as UTC. DB rows come from
 * `datetime('now')`, a UTC value without a zone marker (`2026-11-02 23:30:00`) that
 * V8 would read as local time and older WebKit rejects outright.
 * @param dateStr - Timestamp string, usually from the DB
 * @returns The parsed instant (Invalid Date when unparseable)
 */
export function parseDbTimestamp(dateStr: string): Date {
  return new Date(NAIVE_DATETIME.test(dateStr) ? `${dateStr.replace(' ', 'T')}Z` : dateStr);
}

/**
 * Formats a date string into a human-readable format. A date-only value
 * (`2024-01-15`) is a calendar date and prints as stored in every timezone; a
 * timestamp prints its local date, with zone-less DB timestamps read as UTC.
 * @param dateStr - ISO date, DB timestamp or other date-like string
 * @returns Formatted date string (e.g., "January 15, 2024")
 */
export function formatDate(dateStr: string): string {
  const date = parseDbTimestamp(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(DATE_ONLY.test(dateStr) ? { timeZone: 'UTC' } : {}),
  });
}

/**
 * Formats a timestamp as a relative time (e.g. "5m ago"), reading zone-less DB
 * timestamps as UTC (see `parseDbTimestamp`).
 * @param dateStr - Timestamp string from the DB
 * @returns Relative time in short form, or a locale date after 30 days
 */
export function formatRelativeTime(dateStr: string): string {
  const date = parseDbTimestamp(dateStr);
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
