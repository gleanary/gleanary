import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { autoTagSchema } from '@/lib/validators';
import { callClaude, truncateContent, parseTagsResponse, AUTO_TAG_PROMPT } from '@/lib/ai';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { ValidationError } from '@/lib/errors';
import { getArticleOrThrow, getArticleTagVocabulary } from '@/lib/db-helpers';
import type { AutoTagResponse } from '@/types';

/**
 * POST /api/ai/tag — Auto-tag an article using Claude.
 * Other articles' tags are sent as the vocabulary hint, and suggestions that match one
 * case-insensitively take its spelling. The names are stored in `articles.ai_tags` only;
 * the highlight `tags` table is never written.
 * @param req - NextRequest with JSON body { articleId: number }
 * @returns The article's tag names
 */
export const POST = withRoute('POST /api/ai/tag', async (req: NextRequest) => {
  const body = await req.json();
  const { articleId } = autoTagSchema.parse(body);

  const article = getArticleOrThrow(articleId);

  const content = article.contentMarkdown ?? article.contentText;
  if (!content) {
    throw new ValidationError('Article has no content to analyze');
  }

  const vocabulary = getArticleTagVocabulary(articleId);

  const userMessage = `Article title: ${article.title}\n\nExisting tags: ${JSON.stringify([...vocabulary.values()])}\n\nArticle content:\n${truncateContent(content)}`;

  const response = await callClaude(AUTO_TAG_PROMPT, userMessage, {
    feature: 'tag',
    resourceType: 'article',
    resourceId: articleId,
  });
  // parseTagsResponse already applies normalizeTagName and de-duplicates, so each
  // suggestion maps to a distinct spelling: "testing" and "Testing" become one "Testing"
  const suggested = parseTagsResponse(response);
  const reused = suggested.filter((key) => vocabulary.has(key)).length;
  const names = suggested.map((key) => vocabulary.get(key) ?? key);

  if (names.length === 0) {
    return NextResponse.json<AutoTagResponse>({ tags: [] });
  }

  db.update(articles)
    .set({
      aiTags: JSON.stringify(names),
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(articles.id, articleId))
    .run();

  logger.info(
    {
      event: 'ai_auto_tag',
      articleId,
      tagCount: names.length,
      reused,
    },
    'Article auto-tagged',
  );
  return NextResponse.json<AutoTagResponse>({ tags: names });
});
