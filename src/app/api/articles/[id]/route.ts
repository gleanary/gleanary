import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles, highlights } from '@/db/schema';
import { parseIdParam, updateArticleSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { NotFoundError } from '@/lib/errors';
import { getArticleOrThrow } from '@/lib/db-helpers';
import { deleteArticleCache } from '@/lib/tts-cache';
import { deletePdf, deletePdfImages } from '@/lib/pdf-storage';
import type { RouteContext } from '@/types';

/**
 * GET /api/articles/[id] — Get a single article with its highlights.
 * @param req - NextRequest
 * @param context - Route context with id param
 * @returns Article with its highlights
 */
export const GET = withRoute(
  'GET /api/articles/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);

    const article = getArticleOrThrow(id);

    const articleHighlights = db
      .select()
      .from(highlights)
      .where(eq(highlights.articleId, id))
      .all();

    return NextResponse.json({ article, highlights: articleHighlights });
  },
);

/**
 * PATCH /api/articles/[id] — Update article fields.
 * @param req - NextRequest with JSON body matching updateArticleSchema
 * @param context - Route context with id param
 * @returns Updated article
 */
export const PATCH = withRoute(
  'PATCH /api/articles/[id]',
  async (req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const body = await req.json();
    const data = updateArticleSchema.parse(body);

    const existing = getArticleOrThrow(id);

    // Enforce monotonic reading progress — never decrease (except for explicit reset to 0)
    if (data.readingProgress !== undefined) {
      if ((existing.readingProgress ?? 0) >= data.readingProgress && data.readingProgress !== 0) {
        return NextResponse.json({ article: existing });
      }
    }

    const updates: Record<string, unknown> = {
      ...data,
      updatedAt: sql`(datetime('now'))`,
    };
    // Auto-set readAt when archiving for the first time (skip if client supplied one)
    if (data.status === 'archived' && !existing.readAt && data.readAt === undefined) {
      updates.readAt = sql`(datetime('now'))`;
    }

    const article = db.update(articles).set(updates).where(eq(articles.id, id)).returning().get();
    if (!article) {
      throw new NotFoundError('Article', id);
    }

    logger.info({ event: 'article_updated', articleId: id }, 'Article updated');
    return NextResponse.json({ article });
  },
);

/**
 * DELETE /api/articles/[id] — Delete an article and all its highlights.
 * @param req - NextRequest
 * @param context - Route context with id param
 * @returns Deletion confirmation
 */
export const DELETE = withRoute(
  'DELETE /api/articles/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);

    const article = db
      .select({ contentHash: articles.contentHash })
      .from(articles)
      .where(eq(articles.id, id))
      .get();
    if (!article) {
      throw new NotFoundError('Article', id);
    }

    db.delete(articles).where(eq(articles.id, id)).run();

    if (article.contentHash) {
      const results = await Promise.allSettled([
        deletePdf(article.contentHash),
        deletePdfImages(article.contentHash),
      ]);
      results.forEach((r) => {
        if (r.status === 'rejected') {
          logger.warn(
            { err: r.reason, contentHash: article.contentHash },
            'pdf cleanup after article delete failed',
          );
        }
      });
    }

    void deleteArticleCache(id);
    logger.info({ event: 'article_deleted', articleId: id }, 'Article deleted');
    return NextResponse.json({ deleted: true });
  },
);
