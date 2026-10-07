import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { highlights } from '@/db/schema';
import { listReviewSchema, submitReviewSchema } from '@/lib/validators';
import { calculateNextReview, countDueHighlights, getDueHighlights } from '@/lib/spaced-repetition';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { NotFoundError } from '@/lib/errors';

/**
 * GET /api/review — Returns highlights due for spaced repetition review.
 * @param req - NextRequest with optional `limit` query param (default 15, max 50)
 * @returns Due highlights with article context and tags, plus total due count
 */
export const GET = withRoute('GET /api/review', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const { limit } = listReviewSchema.parse(params);

  const result = getDueHighlights(limit);

  return NextResponse.json({
    highlights: result.highlights,
    totalDue: result.totalDue,
  });
});

/**
 * POST /api/review — Record a review action on a highlight.
 * Updates the highlight's spaced repetition fields based on the action.
 * @param req - NextRequest with JSON body: { highlightId, action }
 * @returns Updated highlight review fields and remaining due count
 */
export const POST = withRoute('POST /api/review', async (req: NextRequest) => {
  const body = await req.json();
  const { highlightId, action } = submitReviewSchema.parse(body);

  // Fetch current highlight state
  const current = db
    .select({
      id: highlights.id,
      reviewCount: highlights.reviewCount,
      reviewInterval: highlights.reviewInterval,
    })
    .from(highlights)
    .where(eq(highlights.id, highlightId))
    .get();

  if (!current) {
    throw new NotFoundError('Highlight', highlightId);
  }

  // Calculate new review state
  const next = calculateNextReview(
    {
      reviewCount: current.reviewCount ?? 0,
      currentInterval: current.reviewInterval ?? 0,
    },
    action,
  );

  // Update the highlight
  const updated = db
    .update(highlights)
    .set({
      lastReviewed: next.lastReviewed,
      reviewCount: next.reviewCount,
      reviewInterval: next.interval,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(highlights.id, highlightId))
    .returning({
      id: highlights.id,
      lastReviewed: highlights.lastReviewed,
      reviewCount: highlights.reviewCount,
      reviewInterval: highlights.reviewInterval,
    })
    .get()!;

  // Count remaining due highlights
  const remaining = countDueHighlights();

  logger.info(
    { event: 'highlight_reviewed', highlightId, action, newInterval: next.interval },
    'Highlight reviewed',
  );

  return NextResponse.json({ highlight: updated, remaining });
});
