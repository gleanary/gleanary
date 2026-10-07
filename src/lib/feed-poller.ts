import 'server-only';
import RssParser from 'rss-parser';
import { eq, and, sql, isNull, or, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { sources, articles } from '@/db/schema';
import { parseArticleFromUrl } from '@/lib/article-parser';
import { safeFetchText } from '@/lib/fetch-utils';
import { logger } from '@/lib/logger';
import type { Source, PollResult } from '@/types';

export type { PollResult } from '@/types';

const FEED_FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024; // 5 MB
const USER_AGENT = 'ReadwiseClone/1.0 (compatible; feed-poller)';

const parser = new RssParser();

/**
 * Polls a single RSS feed source, fetches new entries, and saves them as articles.
 * @param source - The source record to poll (must be type='rss_feed' with a feedUrl)
 * @returns Poll result with counts and any errors
 */
export async function pollFeed(source: Source): Promise<PollResult> {
  const result: PollResult = {
    feedId: source.id,
    feedName: source.name,
    newArticles: 0,
    skipped: 0,
    errors: [],
  };

  // Validate source
  if (source.type !== 'rss_feed' || !source.feedUrl) {
    result.errors.push('Source is not an RSS feed or has no feed URL');
    return result;
  }

  // Build conditional headers for efficiency
  const headers: Record<string, string> = {
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
  };
  if (source.etag) {
    headers['If-None-Match'] = source.etag;
  }
  if (source.lastModified) {
    headers['If-Modified-Since'] = source.lastModified;
  }

  // Fetch the feed with SSRF validation, timeout, and size limit
  let feedText: string;
  let response: Response;
  try {
    const result_ = await safeFetchText(source.feedUrl, {
      timeoutMs: FEED_FETCH_TIMEOUT_MS,
      maxBytes: MAX_FEED_BYTES,
      userAgent: USER_AGENT,
      headers,
    });
    feedText = result_.text;
    response = result_.response;
  } catch (error) {
    const msg = `Failed to fetch feed: ${String(error)}`;
    result.errors.push(msg);
    logger.error({ err: error, event: 'feed_fetch_failed', feedId: source.id }, msg);
    return result;
  }

  // Handle 304 Not Modified
  if (response.status === 304) {
    db.update(sources)
      .set({ lastPolled: new Date().toISOString() })
      .where(eq(sources.id, source.id))
      .run();
    logger.info({ event: 'feed_not_modified', feedId: source.id }, 'Feed not modified (304)');
    return result;
  }

  if (!response.ok) {
    const msg = `Feed returned HTTP ${response.status}`;
    result.errors.push(msg);
    logger.error({ event: 'feed_fetch_failed', feedId: source.id, status: response.status }, msg);
    return result;
  }

  let feed: RssParser.Output<Record<string, unknown>>;
  try {
    feed = await parser.parseString(feedText);
  } catch (error) {
    const msg = `Failed to parse feed XML: ${String(error)}`;
    result.errors.push(msg);
    logger.error({ err: error, event: 'feed_parse_failed', feedId: source.id }, msg);
    return result;
  }

  // Batch dedup: collect all item URLs and check existence in one query
  const itemUrls = feed.items.map((item) => item.link).filter((url): url is string => Boolean(url));

  const existingUrls = new Set(
    itemUrls.length > 0
      ? db
          .select({ url: articles.url })
          .from(articles)
          .where(inArray(articles.url, itemUrls))
          .all()
          .map((r) => r.url)
      : [],
  );

  // Process each feed item
  for (const item of feed.items) {
    const itemUrl = item.link;
    if (!itemUrl) {
      result.skipped++;
      continue;
    }

    if (existingUrls.has(itemUrl)) {
      result.skipped++;
      continue;
    }

    // Parse and save the article
    try {
      const parsed = await parseArticleFromUrl(itemUrl);

      db.insert(articles)
        .values({
          url: parsed.url,
          title: parsed.title || item.title || itemUrl,
          author: parsed.author || item.creator || null,
          contentHtml: parsed.contentHtml,
          contentText: parsed.contentText,
          contentOriginalHtml: parsed.contentOriginalHtml,
          contentMarkdown: parsed.contentMarkdown,
          excerpt: parsed.excerpt,
          siteName: parsed.siteName,
          imageUrl: parsed.imageUrl,
          wordCount: parsed.wordCount,
          sourceId: source.id,
          publishedAt: parsed.publishedAt || item.pubDate || item.isoDate || null,
          status: 'inbox',
        })
        .run();

      result.newArticles++;
      logger.info(
        { event: 'feed_article_saved', feedId: source.id, url: itemUrl },
        'New article from feed',
      );
    } catch (error) {
      const msg = `Failed to parse article ${itemUrl}: ${String(error)}`;
      result.errors.push(msg);
      logger.warn(
        { err: error, event: 'feed_article_parse_failed', feedId: source.id, url: itemUrl },
        msg,
      );
    }
  }

  // Update source metadata
  db.update(sources)
    .set({
      lastPolled: new Date().toISOString(),
      etag: response.headers.get('etag') || source.etag,
      lastModified: response.headers.get('last-modified') || source.lastModified,
    })
    .where(eq(sources.id, source.id))
    .run();

  logger.info(
    {
      event: 'feed_polled',
      feedId: source.id,
      newArticles: result.newArticles,
      skipped: result.skipped,
      errors: result.errors.length,
    },
    'Feed polled',
  );

  return result;
}

/**
 * Polls all RSS feed sources that are due for polling.
 * A feed is "due" when lastPolled is null or lastPolled + pollInterval minutes ≤ now.
 * @returns Array of poll results, one per feed polled
 */
export async function pollAllFeeds(): Promise<PollResult[]> {
  const now = new Date();

  // Find all RSS feeds that are due
  const dueFeeds = db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.type, 'rss_feed'),
        or(
          isNull(sources.lastPolled),
          sql`datetime(${sources.lastPolled}, '+' || ${sources.pollInterval} || ' minutes') <= datetime(${now.toISOString()})`,
        ),
      ),
    )
    .all();

  if (dueFeeds.length === 0) {
    return [];
  }

  logger.info(
    { event: 'feed_poll_start', count: dueFeeds.length },
    `Polling ${dueFeeds.length} due feed(s)`,
  );

  const results: PollResult[] = [];

  // Poll sequentially to avoid overwhelming external servers
  for (const feed of dueFeeds) {
    const result = await pollFeed(feed);
    results.push(result);
  }

  return results;
}
