import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, rawDb } from '@/db';
import { articles, highlights } from '@/db/schema';
import { lintChatSchema } from '@/lib/validators';
import { handleApiError } from '@/lib/api-error-handler';
import { logger } from '@/lib/logger';
import { sseEvent, SSE_HEADERS } from '@/lib/sse';
import { runStale } from '@/lib/lint/stale';
import { runGaps } from '@/lib/lint/gaps';
import { runConnections } from '@/lib/lint/connections';
import { runContradictions } from '@/lib/lint/contradictions';
import type { LintCheck, LintContext, Suggestion } from '@/lib/lint/types';

/** Minimum articles required for any lint check to make sense. */
const MIN_ARTICLES = 3;

/** Minimum highlights required for any lint check to make sense. */
const MIN_HIGHLIGHTS = 5;

/**
 * POST /api/chat/lint — Run a Knowledge Health check over the user's KB.
 *
 * Streams suggestion findings as SSE events. Dispatches on `check`:
 *   - `stale`         — pure SQL, no LLM
 *   - `gaps`          — per-thesis Haiku calls
 *   - `connections`   — hybrid topic clustering + Haiku validation
 *   - `contradictions`— two-pass Haiku analysis
 *
 * @param req - NextRequest with JSON body matching lintChatSchema
 * @returns Server-Sent Events stream of `suggestion`/`empty`/`error`/`done` events
 */
export async function POST(req: NextRequest) {
  let check: LintCheck;
  try {
    const raw = await req.json();
    ({ check } = lintChatSchema.parse(raw));
  } catch (error) {
    return handleApiError(error, 'POST /api/chat/lint');
  }

  logger.info({ event: 'lint_check_start', check }, 'Knowledge lint check started');

  const ctx: LintContext = { db, rawDb };

  const stream = new ReadableStream({
    async start(controller) {
      let total = 0;
      try {
        // Global empty-KB gate. Needs at least a few articles and highlights
        // for any check to produce meaningful output.
        const counts = {
          articles:
            db
              .select({ c: sql<number>`count(*)` })
              .from(articles)
              .get()?.c ?? 0,
          highlights:
            db
              .select({ c: sql<number>`count(*)` })
              .from(highlights)
              .get()?.c ?? 0,
        };
        if (counts.articles < MIN_ARTICLES || counts.highlights < MIN_HIGHLIGHTS) {
          controller.enqueue(
            sseEvent('empty', {
              reason: `Need at least ${MIN_ARTICLES} articles and ${MIN_HIGHLIGHTS} highlights to run knowledge health checks.`,
              counts,
            }),
          );
          controller.enqueue(sseEvent('done', { totalSuggestions: 0 }));
          return;
        }

        const generator = dispatchCheck(check, ctx);
        for await (const suggestion of generator) {
          controller.enqueue(sseEvent('suggestion', suggestion));
          total++;
        }

        controller.enqueue(sseEvent('done', { totalSuggestions: total }));
        logger.info(
          { event: 'lint_check_done', check, totalSuggestions: total },
          'Knowledge lint check completed',
        );
      } catch (err) {
        logger.error({ err, event: 'lint_check_failed', check }, 'Knowledge lint check failed');
        controller.enqueue(
          sseEvent('error', { error: err instanceof Error ? err.message : 'Unknown error' }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/** Dispatches to the appropriate check helper and returns its async generator. */
function dispatchCheck(check: LintCheck, ctx: LintContext): AsyncGenerator<Suggestion> {
  switch (check) {
    case 'stale':
      return runStale(ctx);
    case 'gaps':
      return runGaps(ctx);
    case 'connections':
      return runConnections(ctx);
    case 'contradictions':
      return runContradictions(ctx);
  }
}
