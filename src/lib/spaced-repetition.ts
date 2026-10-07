import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles, highlights } from '@/db/schema';
import { getTagsForHighlights } from '@/lib/highlight-utils';
import type { HighlightWithContext, ReviewAction } from '@/types';

/** Input state for calculating the next review */
interface ReviewState {
  reviewCount: number;
  currentInterval: number;
}

/** Result of a review calculation */
interface ReviewResult {
  interval: number;
  reviewCount: number;
  lastReviewed: string;
}

/**
 * Calculates the next review interval using simplified SM-2.
 * - "got_it": first review → interval 1; subsequent → double interval
 * - "review_again": always reset interval to 1
 * Both actions increment reviewCount and set lastReviewed to now.
 * @param state - Current review state of the highlight
 * @param action - User's review action
 * @returns Updated review fields
 */
export function calculateNextReview(state: ReviewState, action: ReviewAction): ReviewResult {
  const reviewCount = state.reviewCount + 1;
  const lastReviewed = new Date().toISOString().replace('T', ' ').slice(0, 19);

  if (action === 'review_again') {
    return { interval: 1, reviewCount, lastReviewed };
  }

  // got_it: first review starts at 1, then doubles
  const interval = state.reviewCount === 0 ? 1 : state.currentInterval * 2;
  return { interval, reviewCount, lastReviewed };
}

/**
 * Queries highlights that are due for review.
 * A highlight is due when: lastReviewed IS NULL OR lastReviewed + interval days <= now.
 * Results include article context and tags.
 * @param limit - Maximum number of highlights to return
 * @returns Due highlights with context, and total due count
 */
export function getDueHighlights(limit: number): {
  highlights: HighlightWithContext[];
  totalDue: number;
} {
  const dueCondition = sql`(
    ${highlights.lastReviewed} IS NULL
    OR datetime(${highlights.lastReviewed}, '+' || ${highlights.reviewInterval} || ' days') <= datetime('now')
  )`;

  // Get total due count
  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(highlights)
    .where(dueCondition)
    .get();
  const totalDue = countResult?.count ?? 0;

  if (totalDue === 0) {
    return { highlights: [], totalDue: 0 };
  }

  // Fetch due highlights with article context, ordered randomly
  const rows = db
    .select({
      highlight: highlights,
      articleTitle: articles.title,
      articleUrl: articles.url,
      articleSiteName: articles.siteName,
    })
    .from(highlights)
    .innerJoin(articles, sql`${highlights.articleId} = ${articles.id}`)
    .where(dueCondition)
    .orderBy(sql`RANDOM()`)
    .limit(limit)
    .all();

  // Batch-fetch tags to avoid N+1
  const highlightIds = rows.map((r) => r.highlight.id);
  const tagsMap = getTagsForHighlights(highlightIds);

  const result: HighlightWithContext[] = rows.map((r) => ({
    ...r.highlight,
    color: r.highlight.color as HighlightWithContext['color'],
    article: {
      title: r.articleTitle,
      url: r.articleUrl,
      siteName: r.articleSiteName,
    },
    tags: tagsMap.get(r.highlight.id) ?? [],
  }));

  return { highlights: result, totalDue };
}

/**
 * Counts highlights currently due for review.
 * @returns Number of due highlights
 */
export function countDueHighlights(): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(highlights)
    .where(
      sql`(
      ${highlights.lastReviewed} IS NULL
      OR datetime(${highlights.lastReviewed}, '+' || ${highlights.reviewInterval} || ' days') <= datetime('now')
    )`,
    )
    .get();
  return result?.count ?? 0;
}
