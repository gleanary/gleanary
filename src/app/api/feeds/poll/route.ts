import { NextRequest, NextResponse } from 'next/server';
import { pollBodySchema } from '@/lib/validators';
import { pollFeed, pollAllFeeds } from '@/lib/feed-poller';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { ValidationError } from '@/lib/errors';
import { getSourceOrThrow } from '@/lib/db-helpers';

/**
 * POST /api/feeds/poll — Trigger feed polling.
 * If sourceId is provided, polls that specific feed.
 * Otherwise, polls all feeds that are due.
 * @param req - NextRequest with optional JSON body { sourceId?: number }
 * @returns Poll results
 */
export const POST = withRoute('POST /api/feeds/poll', async (req: NextRequest) => {
  // Parse body: empty body means poll-all
  const text = await req.text();
  const body = text ? pollBodySchema.parse(JSON.parse(text)) : undefined;

  if (body?.sourceId) {
    // Poll a specific feed
    const source = getSourceOrThrow(body.sourceId);

    if (source.type !== 'rss_feed' || !source.feedUrl) {
      throw new ValidationError(`Source ${body.sourceId} is not an RSS feed`);
    }

    const result = await pollFeed(source);
    logger.info(
      { event: 'manual_poll', sourceId: body.sourceId, newArticles: result.newArticles },
      'Manual feed poll completed',
    );
    return NextResponse.json({ results: [result] });
  }

  // Poll all due feeds
  const results = await pollAllFeeds();
  logger.info({ event: 'manual_poll_all', feedCount: results.length }, 'Manual poll-all completed');
  return NextResponse.json({ results });
});
