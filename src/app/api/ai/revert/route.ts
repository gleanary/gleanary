import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { revertArticleSchema } from '@/lib/validators';
import { parseArticleFromHtml } from '@/lib/article-parser';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getArticleOrThrow } from '@/lib/db-helpers';
import { ValidationError } from '@/lib/errors';

/**
 * POST /api/ai/revert — Revert an AI-cleaned article to its original extracted content.
 * Re-runs Defuddle on the stored content_original_html.
 * @param req - NextRequest with JSON body { articleId: number }
 * @returns Restored contentHtml and contentMarkdown
 */
export const POST = withRoute('POST /api/ai/revert', async (req: NextRequest) => {
  const body = await req.json();
  const { articleId } = revertArticleSchema.parse(body);

  const article = getArticleOrThrow(articleId);

  if (article.originalFilePath !== null) {
    throw new ValidationError(
      'Revert is not supported for PDF articles. Re-extract by re-uploading.',
    );
  }

  if (!article.contentOriginalHtml) {
    throw new ValidationError('Article has no original HTML to revert to');
  }

  const parsed = await parseArticleFromHtml(article.contentOriginalHtml, article.url);

  db.update(articles)
    .set({
      contentHtml: parsed.contentHtml,
      contentMarkdown: parsed.contentMarkdown,
      contentText: parsed.contentText,
      wordCount: parsed.wordCount,
      aiCleanedAt: null,
    })
    .where(eq(articles.id, articleId))
    .run();

  logger.info({ event: 'ai_article_reverted', articleId }, 'Article reverted to original');

  return NextResponse.json({
    contentHtml: parsed.contentHtml,
    contentMarkdown: parsed.contentMarkdown,
  });
});
