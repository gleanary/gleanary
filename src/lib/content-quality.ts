/**
 * Client-side heuristic scoring for article formatting quality.
 * Uses regex/string analysis only — no JSDOM — so it can run in the browser.
 */

/** Score threshold: articles scoring >= this value are flagged for AI cleanup. */
export const QUALITY_THRESHOLD = 50;

/** Minimum element count to avoid false positives on tiny content. */
const MIN_ELEMENTS_FOR_RATIO = 5;

/** Minimum non-whitespace chars between images to count as "has text". */
const MIN_TEXT_BETWEEN_IMAGES = 20;

/** Minimum consecutive images (without intervening text) to trigger the heuristic. */
const MIN_CONSECUTIVE_IMAGES = 4;

/** Empty element ratio above which the heuristic triggers. */
const EMPTY_ELEMENT_THRESHOLD = 0.3;

/** HTML-to-text length ratio above which the heuristic triggers. */
const MARKUP_RATIO_THRESHOLD = 10;

/**
 * Detects likely formatting issues in article HTML using lightweight heuristics.
 * Returns a score 0–100 where higher means more likely to have layout problems.
 * @param contentHtml - The article's sanitized HTML content
 * @param sourceType - The source type (e.g. 'newsletter', 'rss_feed', null)
 * @param pageCount - Optional PDF page count; enables PDF-specific signals when provided
 * @returns Quality issue score (0 = clean, 100 = severe formatting issues)
 */
export function detectFormattingIssues(
  contentHtml: string,
  sourceType: string | null,
  pageCount?: number | null,
): number {
  if (!contentHtml) return 0;

  let score = 0;

  score += scoreConsecutiveImages(contentHtml);
  score += scoreEmptyElements(contentHtml);
  score += scoreTableScaffolding(contentHtml);
  score += scoreMarkupRatio(contentHtml);

  if (sourceType === 'newsletter') {
    score += 20;
  }

  if (pageCount != null && pageCount > 0) {
    score += scoreLowTextPerPage(contentHtml, pageCount);
  }
  score += scoreShortParagraphDensity(contentHtml);

  return Math.min(100, score);
}

/**
 * +25 if 4+ `<img>` tags appear consecutively without intervening text paragraphs.
 */
function scoreConsecutiveImages(html: string): number {
  const imgPattern = /<img[\s>]/gi;
  const positions: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = imgPattern.exec(html)) !== null) {
    positions.push(match.index);
  }

  if (positions.length < MIN_CONSECUTIVE_IMAGES) return 0;

  // Find the end of each <img ...> tag to measure the gap to the next
  let consecutive = 1;
  for (let i = 0; i < positions.length - 1; i++) {
    const gapStart = html.indexOf('>', positions[i]) + 1;
    const gapEnd = positions[i + 1];
    const gap = html.slice(gapStart, gapEnd);
    const textOnly = gap.replace(/<[^>]*>/g, '').replace(/\s+/g, '');

    if (textOnly.length < MIN_TEXT_BETWEEN_IMAGES) {
      consecutive++;
      if (consecutive >= MIN_CONSECUTIVE_IMAGES) return 25;
    } else {
      consecutive = 1;
    }
  }

  return 0;
}

/**
 * +20 if more than 30% of div/p/span elements are empty or whitespace-only.
 */
function scoreEmptyElements(html: string): number {
  const elementPattern = /<(div|p|span)[\s>]/gi;
  let total = 0;
  while (elementPattern.exec(html) !== null) {
    total++;
  }

  if (total < MIN_ELEMENTS_FOR_RATIO) return 0;

  const emptyPattern = /<(div|p|span)(\s[^>]*)?>(\s|&nbsp;|<br\s*\/?>)*<\/(div|p|span)>/gi;
  let emptyCount = 0;
  while (emptyPattern.exec(html) !== null) {
    emptyCount++;
  }

  return emptyCount / total > EMPTY_ELEMENT_THRESHOLD ? 20 : 0;
}

/**
 * +15 if `<table>` elements exist but no `<th>` elements (layout tables).
 */
function scoreTableScaffolding(html: string): number {
  const hasTable = /<table[\s>]/i.test(html);
  const hasTh = /<th[\s>]/i.test(html);
  return hasTable && !hasTh ? 15 : 0;
}

/**
 * +20 if the ratio of raw HTML length to stripped text length exceeds 10.
 */
function scoreMarkupRatio(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return 0;
  return html.length / text.length > MARKUP_RATIO_THRESHOLD ? 20 : 0;
}

/**
 * +20 when average chars per page is below 100 — indicates near-empty text extraction.
 */
function scoreLowTextPerPage(html: string, pageCount: number): number {
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length / pageCount < 100 ? 20 : 0;
}

/** Minimum <p> count required to evaluate short-paragraph density. */
const MIN_PARAGRAPHS_FOR_DENSITY = 5;

/** Fraction of short paragraphs (< 50 chars) above which +15 fires. */
const SHORT_PARAGRAPH_THRESHOLD = 0.6;

/**
 * +15 when most paragraphs are very short — indicates line-by-line PDF extraction artifacts.
 */
function scoreShortParagraphDensity(html: string): number {
  let count = 0;
  let shortCount = 0;
  let searchFrom = 0;
  while (true) {
    const open = html.indexOf('<p', searchFrom);
    if (open === -1) break;
    const tagEnd = html.indexOf('>', open);
    if (tagEnd === -1) break;
    const close = html.indexOf('</p>', tagEnd + 1);
    if (close === -1) break;
    const inner = html
      .slice(tagEnd + 1, close)
      .replace(/<[^>]*>/g, '')
      .trim();
    count++;
    if (inner.length < 50) shortCount++;
    searchFrom = close + 4;
  }
  if (count < MIN_PARAGRAPHS_FOR_DENSITY) return 0;
  return shortCount / count > SHORT_PARAGRAPH_THRESHOLD ? 15 : 0;
}

/**
 * Validates AI reformat output before it is committed to the database.
 * Catches model drift (too short/long) and DOMPurify stripping excessive markup.
 *
 * @param rawOutput - Raw text returned by the model (before sanitization)
 * @param sanitized - Output after sanitizeArticleHtml() has been applied
 * @param inputContent - The content that was sent to the model (full article or individual chunk)
 * @returns true if the output passes both length and sanitization ratio checks
 */
export function validateCleanOutput(
  rawOutput: string,
  sanitized: string,
  inputContent: string,
  minRatio = 0.6,
): boolean {
  const inputLen = inputContent.length;
  if (inputLen === 0) return false;

  const sanitizedLen = sanitized.length;
  const minLen = inputLen * minRatio;
  const maxLen = inputLen * 1.4;

  if (sanitizedLen < minLen || sanitizedLen > maxLen) return false;
  if (sanitizedLen < rawOutput.length * 0.5) return false;

  return true;
}

/**
 * Returns true when a PDF extraction result needs AI cleanup.
 * Triggered when extraction failed entirely or formatting heuristics flag the output.
 * @param extractionTier - The tier from a PdfExtractionResult
 * @param contentHtml - The extracted HTML content
 * @param pageCount - Optional page count for PDF-specific quality signals
 */
export function isPdfCleanupNeeded(
  extractionTier: string,
  contentHtml: string,
  pageCount?: number | null,
): boolean {
  return (
    extractionTier === 'failed' ||
    detectFormattingIssues(contentHtml, null, pageCount) >= QUALITY_THRESHOLD
  );
}
