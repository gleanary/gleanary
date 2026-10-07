import { sql } from 'drizzle-orm';
import { articles, highlights, theses } from '@/db/schema';
import { truncate } from '@/lib/text-utils';
import type { LintContext, Suggestion } from './types';

/** Rows per stale category — caps the worst case on a neglected KB. */
const LIMIT_PER_CATEGORY = 10;

/** Days a thesis can go untouched before it's considered stale. */
const STALE_THESIS_DAYS = 30;

/** Days an article in `reading` status can go untouched before it's stale. */
const STALE_ARTICLE_DAYS = 14;

/** Highlights on intervals above this threshold are "mature memories." */
const MATURE_HIGHLIGHT_INTERVAL = 30;

/**
 * Stale lint check — pure SQL, no LLM involvement.
 *
 * Surfaces three categories of neglected content:
 *   1. Theses not touched in 30+ days (excluding `used`)
 *   2. Articles stuck in `reading` for 14+ days
 *   3. Mature highlights (review interval > 30d) that are now overdue
 *
 * Each category is capped at 10 rows and yielded as a `Suggestion` with a
 * pre-baked description string. No network calls.
 */
export async function* runStale(ctx: LintContext): AsyncGenerator<Suggestion> {
  const { db } = ctx;

  // 1. Stale theses — oldest first so the worst offenders bubble up.
  const staleTheses = db
    .select({
      id: theses.id,
      title: theses.title,
      updatedAt: theses.updatedAt,
    })
    .from(theses)
    .where(
      sql`${theses.status} != 'used' AND datetime(${theses.updatedAt}) < datetime('now', '-' || ${STALE_THESIS_DAYS} || ' days')`,
    )
    .orderBy(theses.updatedAt)
    .limit(LIMIT_PER_CATEGORY)
    .all();

  for (const t of staleTheses) {
    const days = daysSince(t.updatedAt);
    yield {
      type: 'stale',
      description: `Thesis "${t.title}" hasn't been updated in ${days} days`,
      relatedIds: [{ type: 'thesis', id: t.id }],
      suggestedAction: 'Review thesis',
    };
  }

  // 2. Stale articles in the reading pile.
  const staleArticles = db
    .select({
      id: articles.id,
      title: articles.title,
      updatedAt: articles.updatedAt,
    })
    .from(articles)
    .where(
      sql`${articles.status} = 'reading' AND datetime(${articles.updatedAt}) < datetime('now', '-' || ${STALE_ARTICLE_DAYS} || ' days')`,
    )
    .orderBy(articles.updatedAt)
    .limit(LIMIT_PER_CATEGORY)
    .all();

  for (const a of staleArticles) {
    const days = daysSince(a.updatedAt);
    yield {
      type: 'stale',
      description: `Article "${a.title}" has been open for ${days} days without progress`,
      relatedIds: [{ type: 'article', id: a.id }],
      suggestedAction: 'Resume reading',
    };
  }

  // 3. Mature highlights that are overdue. Mirrors the spaced-repetition
  //    dueCondition from src/lib/spaced-repetition.ts.
  const overdue = db
    .select({
      id: highlights.id,
      text: highlights.text,
      reviewInterval: highlights.reviewInterval,
    })
    .from(highlights)
    .where(
      sql`${highlights.reviewInterval} > ${MATURE_HIGHLIGHT_INTERVAL}
          AND (
            ${highlights.lastReviewed} IS NULL
            OR datetime(${highlights.lastReviewed}, '+' || ${highlights.reviewInterval} || ' days') < datetime('now')
          )`,
    )
    .orderBy(sql`${highlights.reviewInterval} DESC`)
    .limit(LIMIT_PER_CATEGORY)
    .all();

  for (const h of overdue) {
    const snippet = truncate(h.text, 80);
    yield {
      type: 'stale',
      description: `Mature highlight overdue for review: "${snippet}"`,
      relatedIds: [{ type: 'highlight', id: h.id }],
      suggestedAction: 'Start a review session',
    };
  }
}

/** Rough day-delta from a SQLite datetime string to now. */
function daysSince(datetime: string): number {
  const then = new Date(datetime.includes('T') ? datetime : datetime + 'Z').getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}
