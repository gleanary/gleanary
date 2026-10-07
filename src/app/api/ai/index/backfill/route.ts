import { NextRequest } from 'next/server';
import { eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { backfillSchema } from '@/lib/validators';
import { generateConceptIndex } from '@/lib/ai';
import { logger } from '@/lib/logger';
import { handleApiError } from '@/lib/api-error-handler';

const encoder = new TextEncoder();

function sseEvent(event: string, data: object): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * POST /api/ai/index/backfill — Batch-generate concept indexes for all unindexed articles.
 * Streams progress via Server-Sent Events. Intended for one-time backfill of existing articles.
 * Uses a concurrency limit of 3 to avoid API rate limits.
 * @param req - NextRequest with optional JSON body matching backfillSchema
 * @returns SSE stream with progress, error, and done events
 */
export async function POST(req: NextRequest) {
  let params: { batchSize: number; limit?: number };
  try {
    const body =
      req.headers.get('content-length') === '0' ? {} : await req.json().catch(() => ({}));
    params = backfillSchema.parse(body);
  } catch (error) {
    return handleApiError(error, 'POST /api/ai/index/backfill');
  }

  const { batchSize, limit } = params;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Load all unindexed articles (lightweight — content fields are only read for indexing)
        const allUnindexed = db
          .select({
            id: articles.id,
            title: articles.title,
            contentMarkdown: articles.contentMarkdown,
            contentText: articles.contentText,
            contentHtml: articles.contentHtml,
          })
          .from(articles)
          .where(isNull(articles.aiIndex))
          .orderBy(articles.savedAt)
          .all();

        const unindexed = limit ? allUnindexed.slice(0, limit) : allUnindexed;
        const total = unindexed.length;

        let processed = 0;
        let indexed = 0;
        let errors = 0;

        const CONCURRENCY = 3;

        // Process in batches; within each batch use CONCURRENCY parallel requests
        for (let i = 0; i < unindexed.length; i += batchSize) {
          const batch = unindexed.slice(i, i + batchSize);

          for (let j = 0; j < batch.length; j += CONCURRENCY) {
            const chunk = batch.slice(j, j + CONCURRENCY);

            await Promise.all(
              chunk.map(async (article) => {
                controller.enqueue(
                  sseEvent('progress', { processed, total, current: article.title }),
                );
                try {
                  const aiIndex = await generateConceptIndex(article);
                  db.update(articles).set({ aiIndex }).where(eq(articles.id, article.id)).run();
                  indexed++;
                } catch (err) {
                  errors++;
                  logger.warn(
                    { err, event: 'ai_index_backfill_error', articleId: article.id },
                    'Failed to index article',
                  );
                  controller.enqueue(
                    sseEvent('error', {
                      articleId: article.id,
                      title: article.title,
                      error: err instanceof Error ? err.message : 'Unknown error',
                    }),
                  );
                } finally {
                  processed++;
                }
              }),
            );
          }

          // Small delay between batches to avoid API rate limits
          if (i + batchSize < unindexed.length) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }

        controller.enqueue(sseEvent('done', { indexed, skipped: 0, errors }));
        logger.info(
          { event: 'ai_index_backfill_complete', indexed, errors, total },
          'Backfill complete',
        );
      } catch (err) {
        logger.error({ err, event: 'ai_index_backfill_fatal' }, 'Backfill stream failed');
        controller.enqueue(
          sseEvent('error', { error: err instanceof Error ? err.message : 'Unknown error' }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
