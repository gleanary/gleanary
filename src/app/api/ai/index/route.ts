import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { indexSchema } from '@/lib/validators';
import { generateConceptIndex } from '@/lib/ai';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { NotFoundError } from '@/lib/errors';

/**
 * POST /api/ai/index — Generate a structured concept index for an article.
 * Stores the result in articles.ai_index for FTS5 retrieval.
 * Idempotent: skips generation if ai_index is already populated unless force=true.
 * @param req - NextRequest with JSON body matching indexSchema
 * @returns { articleId, indexed } where indexed=false means skipped (already exists)
 */
export const POST = withRoute('POST /api/ai/index', async (req: NextRequest) => {
  const body = await req.json();
  const { articleId, force } = indexSchema.parse(body);

  const article = db
    .select({
      id: articles.id,
      aiIndex: articles.aiIndex,
      title: articles.title,
      contentMarkdown: articles.contentMarkdown,
      contentText: articles.contentText,
      contentHtml: articles.contentHtml,
    })
    .from(articles)
    .where(eq(articles.id, articleId))
    .get();

  if (!article) {
    throw new NotFoundError('Article', articleId);
  }

  if (article.aiIndex && !force) {
    return NextResponse.json({ articleId, indexed: false });
  }

  const aiIndex = await generateConceptIndex(article);

  db.update(articles).set({ aiIndex }).where(eq(articles.id, articleId)).run();

  logger.info({ event: 'ai_index_generated', articleId }, 'Concept index generated');
  return NextResponse.json({ articleId, indexed: true });
});
