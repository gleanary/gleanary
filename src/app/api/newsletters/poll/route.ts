import { NextRequest, NextResponse } from 'next/server';
import { pollNewsletters } from '@/lib/newsletter-poller';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import type { NewsletterPollResult } from '@/types';

/**
 * POST /api/newsletters/poll — Manually trigger newsletter IMAP polling.
 * @param _req - NextRequest (unused)
 * @returns Poll results with new article count and any errors
 */
export const POST = withRoute('POST /api/newsletters/poll', async (_req: NextRequest) => {
  const timeout = new Promise<NewsletterPollResult>((resolve) =>
    setTimeout(
      () =>
        resolve({
          newArticles: 0,
          skipped: 0,
          errors: ['Poll timed out — IMAP connection hung or server too slow'],
        }),
      120_000,
    ),
  );
  const result = await Promise.race([pollNewsletters(), timeout]);

  logger.info(
    { event: 'newsletter_manual_poll', newArticles: result.newArticles },
    'Manual newsletter poll completed',
  );

  return NextResponse.json({
    polled: true,
    newArticles: result.newArticles,
    errors: result.errors,
  });
});
