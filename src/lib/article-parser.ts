import DefuddleClass from 'defuddle';
import { JSDOM, VirtualConsole } from 'jsdom';
import { sanitizeArticleHtml } from '@/lib/sanitize';
import { postProcessHtml } from '@/lib/html-post-processor';
import { safeFetchText } from '@/lib/fetch-utils';
import { convertHtmlToMarkdown } from '@/lib/html-to-markdown';
import { ExternalServiceError, ValidationError } from '@/lib/errors';
import { validateUrl } from '@/lib/url-validator';
import { logger } from '@/lib/logger';
import { computeWordCount, stripHtml, truncate } from '@/lib/text-utils';

/** Shared VirtualConsole instance that suppresses JSDOM noise */
const virtualConsole = new VirtualConsole();

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const JINA_READER_BASE = 'https://r.jina.ai/';

const BOT_CHALLENGE_TITLE_PATTERNS = [
  /just a moment/i,
  /attention required/i,
  /checking.*site.*connection/i,
  /verifying.*browser/i,
];

const BOT_CHALLENGE_BODY_PATTERNS = [
  /security verification/i,
  /verif(y|ying|ication).*\bnot?\s+a?\s*bot/i,
  /enable javascript and cookies/i,
  /ray id:/i,
];

/**
 * Returns true when content looks like a bot-challenge interstitial
 * rather than real article content.
 */
function isBotChallengeContent(title: string, text: string): boolean {
  if (BOT_CHALLENGE_TITLE_PATTERNS.some((re) => re.test(title))) return true;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 200) return false;
  return BOT_CHALLENGE_BODY_PATTERNS.some((re) => re.test(text));
}

/** Result of parsing an article from URL or raw HTML */
export interface ParsedArticle {
  url: string;
  title: string;
  author: string | null;
  contentHtml: string;
  contentText: string;
  contentOriginalHtml: string;
  contentMarkdown: string;
  excerpt: string | null;
  siteName: string | null;
  imageUrl: string | null;
  wordCount: number;
  publishedAt: string | null;
}

interface ContentPipelineResult {
  title: string;
  author: string | null;
  siteName: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
  contentHtml: string;
  contentText: string;
  contentMarkdown: string;
  excerpt: string | null;
  wordCount: number;
}

/**
 * Shared content extraction pipeline: Defuddle → DOMPurify → turndown.
 * Used by both the direct-fetch and Jina paths.
 * @param rawHtml - Raw HTML to parse
 * @param url - The article URL (used by Defuddle for URL resolution and metadata)
 * @returns Extracted and sanitized content with all derived fields
 */
async function runContentPipeline(rawHtml: string, url: string): Promise<ContentPipelineResult> {
  const normalizedHtml = rawHtml.trim() || '<html><head></head><body></body></html>';
  const dom = new JSDOM(normalizedHtml, { url, virtualConsole });
  try {
    const defuddle = new DefuddleClass(dom.window.document, { url });
    const parsed = await defuddle.parseAsync();

    const title = parsed.title || url;
    const author = parsed.author || null;
    const siteName = parsed.site || null;
    const imageUrl = parsed.image || null;
    const publishedAt = parsed.published || null;

    const contentHtml = sanitizeArticleHtml(postProcessHtml(parsed.content ?? ''));
    const contentText = stripHtml(contentHtml);
    const contentMarkdown = convertHtmlToMarkdown(contentHtml);
    const wordCount = computeWordCount(contentText);

    let excerpt: string | null = parsed.description || null;
    if (excerpt && excerpt.length > 300) {
      excerpt = truncate(excerpt);
    } else if (!excerpt && contentText) {
      excerpt = truncate(contentText);
    }

    return {
      title,
      author,
      siteName,
      imageUrl,
      publishedAt,
      contentHtml,
      contentText,
      contentMarkdown,
      excerpt,
      wordCount,
    };
  } finally {
    dom.window.close();
  }
}

/**
 * Parses article content from raw HTML using Defuddle for extraction
 * and DOMPurify for sanitization.
 * @param html - Raw HTML string of the web page
 * @param url - The URL of the article (used for URL resolution and as fallback metadata)
 * @returns Parsed article data with sanitized content
 */
export async function parseArticleFromHtml(html: string, url: string): Promise<ParsedArticle> {
  const contentOriginalHtml = html;
  const pipeline = await runContentPipeline(html, url);

  return {
    url,
    contentOriginalHtml,
    ...pipeline,
  };
}

/** Minimum word count from direct fetch to consider the content valid */
const DIRECT_FETCH_MIN_WORD_COUNT = 50;

/** Patterns indicating a JS-only SPA shell with no server-rendered content */
const SPA_SHELL_PATTERNS = [
  /<div\s+id=["']root["']\s*><\s*\/div>/i,
  /<div\s+id=["']app["']\s*><\s*\/div>/i,
];

/**
 * Checks if raw HTML looks like an empty SPA shell (e.g. React/Vue mount point
 * with no server-rendered content).
 * @param html - Raw HTML string to check
 * @returns True if the HTML matches known SPA shell patterns
 */
function looksLikeSpaShell(html: string): boolean {
  return SPA_SHELL_PATTERNS.some((re) => re.test(html));
}

/**
 * Fetches an article via the Jina Reader API, which uses a headless browser
 * to bypass bot protection. Returns HTML processed through the shared
 * Defuddle → DOMPurify → turndown pipeline.
 * @param url - The original article URL (already SSRF-validated)
 * @returns Parsed article data
 * @throws ExternalServiceError if Jina fetch fails or returns empty/bot-challenge content
 */
async function parseArticleViaJina(url: string): Promise<ParsedArticle> {
  const jinaUrl = `${JINA_READER_BASE}${url}`;
  const apiKey = process.env.JINA_API_KEY;

  // x-respond-with: html returns a plain HTML body (not JSON).
  // Omit Accept: application/json to avoid JSON-wrapped HTML response.
  const { text: rawHtml, response } = await safeFetchText(jinaUrl, {
    userAgent: USER_AGENT,
    timeoutMs: 60_000,
    headers: {
      'x-respond-with': 'html',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-No-Cache': 'true',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });

  if (!response.ok) {
    throw new ExternalServiceError('jina', `HTTP ${response.status}: ${response.statusText}`);
  }

  if (!rawHtml) {
    throw new ExternalServiceError('jina', 'Empty response body');
  }

  const pipeline = await runContentPipeline(rawHtml, url);

  // Detect bot-challenge pages that Jina itself failed to bypass
  if (isBotChallengeContent(pipeline.title, pipeline.contentText)) {
    logger.warn({ event: 'jina_bot_challenge', url }, 'Jina returned bot challenge content');
    throw new ExternalServiceError('jina', 'Bot challenge page — content could not be fetched');
  }

  logger.info({ event: 'article_fetched_via_jina', url }, 'Article fetched via Jina fallback');

  return {
    url,
    contentOriginalHtml: rawHtml,
    ...pipeline,
  };
}

/**
 * Fetches a URL and parses the article content. Tries a direct server-side fetch
 * with Defuddle first (richer metadata), falling back to Jina Reader API for
 * JS-heavy or bot-protected pages.
 *
 * When `opts.prefetched` is provided, the initial fetch is skipped and the
 * supplied buffer is used directly. Jina fallback still works normally (re-fetches
 * from the URL). This avoids a double-fetch when the caller has already fetched
 * the resource (e.g. to detect PDF content-type).
 *
 * @param url - The URL to fetch and parse
 * @param opts.prefetched - Pre-fetched response to skip the initial fetch
 * @returns Parsed article data
 * @throws ExternalServiceError if both direct fetch and Jina fail
 */
export async function parseArticleFromUrl(
  url: string,
  opts?: { prefetched?: { buffer: Buffer; contentType: string; ok: boolean } },
): Promise<ParsedArticle> {
  // Throws ValidationError for private/blocked URLs — must not be caught below.
  const validated = await validateUrl(url);
  const targetUrl = validated.toString();

  // Phase 1: Direct server-side fetch + Defuddle (richer metadata)
  // If caller already fetched the URL, skip the network round-trip.
  try {
    let html: string;
    let ok: boolean;
    let status: number | undefined;

    if (opts?.prefetched) {
      html = opts.prefetched.buffer.toString('utf8');
      ok = opts.prefetched.ok;
    } else {
      const result = await safeFetchText(targetUrl, {
        userAgent: USER_AGENT,
        timeoutMs: 10_000,
        validateSsrf: false, // already validated above
      });
      html = result.text;
      ok = result.response.ok;
      status = result.response.status;
    }

    if (!ok) {
      logger.info(
        { event: 'article_direct_non_ok', url: targetUrl, ...(status !== undefined && { status }) },
        'Direct fetch returned non-ok status, falling back to Jina',
      );
    } else if (!looksLikeSpaShell(html)) {
      const parsed = await parseArticleFromHtml(html, targetUrl);
      if (parsed.wordCount >= DIRECT_FETCH_MIN_WORD_COUNT) {
        logger.info(
          { event: 'article_fetched_direct', url: targetUrl },
          'Article fetched via direct fetch + Defuddle',
        );
        return parsed;
      }
      logger.info(
        { event: 'article_direct_sparse', url: targetUrl, wordCount: parsed.wordCount },
        'Direct fetch yielded sparse content, falling back to Jina',
      );
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err; // defense-in-depth: validateSsrf: false so shouldn't fire
    logger.info(
      { event: 'article_direct_fetch_failed', url: targetUrl, err },
      'Direct fetch failed, falling back to Jina',
    );
  }

  // Phase 2: Jina fallback (headless browser for JS-heavy/bot-protected pages)
  return parseArticleViaJina(targetUrl);
}
