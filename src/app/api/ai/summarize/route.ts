import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { summarizeSchema } from '@/lib/validators';
import { callClaude, truncateContent, SUMMARIZE_PROMPT } from '@/lib/ai';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { NotFoundError, ValidationError } from '@/lib/errors';

/**
 * POST /api/ai/summarize — Summarize an article using Claude.
 * Returns cached summary if already generated.
 * @param req - NextRequest with JSON body { articleId: number }
 * @returns Summary text with cached flag
 */
export const POST = withRoute('POST /api/ai/summarize', async (req: NextRequest) => {
  const body = await req.json();
  const { articleId } = summarizeSchema.parse(body);

  // Lightweight cache check — avoid loading full content on cache hit
  const meta = db
    .select({ id: articles.id, aiSummary: articles.aiSummary })
    .from(articles)
    .where(eq(articles.id, articleId))
    .get();
  if (!meta) {
    throw new NotFoundError('Article', articleId);
  }

  if (meta.aiSummary) {
    return NextResponse.json({ summary: meta.aiSummary, cached: true });
  }

  // Cache miss — load content for Claude
  const article = db
    .select({
      contentMarkdown: articles.contentMarkdown,
      contentText: articles.contentText,
    })
    .from(articles)
    .where(eq(articles.id, articleId))
    .get()!;

  const content = article.contentMarkdown ?? article.contentText;
  if (!content) {
    throw new ValidationError('Article has no content to analyze');
  }

  const summary = await callClaude(SUMMARIZE_PROMPT, truncateContent(content), {
    feature: 'summarize',
    resourceType: 'article',
    resourceId: articleId,
  });

  // Cache the result
  db.update(articles).set({ aiSummary: summary }).where(eq(articles.id, articleId)).run();

  logger.info({ event: 'ai_summarize', articleId }, 'Article summarized');
  return NextResponse.json({ summary, cached: false });
});
