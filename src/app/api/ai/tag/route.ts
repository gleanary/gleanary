import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles, tags } from '@/db/schema';
import { autoTagSchema } from '@/lib/validators';
import { callClaude, truncateContent, parseTagsResponse, AUTO_TAG_PROMPT } from '@/lib/ai';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { ValidationError } from '@/lib/errors';
import { getArticleOrThrow } from '@/lib/db-helpers';

/**
 * POST /api/ai/tag — Auto-tag an article using Claude.
 * Reuses existing tags when possible, creates new ones as needed.
 * @param req - NextRequest with JSON body { articleId: number }
 * @returns Array of matched/created tags and list of newly created tag names
 */
export const POST = withRoute('POST /api/ai/tag', async (req: NextRequest) => {
  const body = await req.json();
  const { articleId } = autoTagSchema.parse(body);

  const article = getArticleOrThrow(articleId);

  const content = article.contentMarkdown ?? article.contentText;
  if (!content) {
    throw new ValidationError('Article has no content to analyze');
  }

  // Fetch existing tags to provide vocabulary
  const existingTags = db.select().from(tags).all();
  const existingTagNames = existingTags.map((t) => t.name);

  const userMessage = `Article title: ${article.title}\n\nExisting tags: ${JSON.stringify(existingTagNames)}\n\nArticle content:\n${truncateContent(content)}`;

  const response = await callClaude(AUTO_TAG_PROMPT, userMessage, {
    feature: 'tag',
    resourceType: 'article',
    resourceId: articleId,
  });
  const suggestedNames = parseTagsResponse(response);

  if (suggestedNames.length === 0) {
    return NextResponse.json({ tags: [], created: [] });
  }

  // Match existing or create new tags
  const resultTags: Array<{ id: number; name: string; color: string | null }> = [];
  const created: string[] = [];

  for (const name of suggestedNames) {
    // Case-insensitive match against existing tags
    const existing = existingTags.find((t) => t.name.toLowerCase() === name.toLowerCase());

    if (existing) {
      resultTags.push({ id: existing.id, name: existing.name, color: existing.color });
    } else {
      const newTag = db.insert(tags).values({ name }).returning().get()!;
      resultTags.push({ id: newTag.id, name: newTag.name, color: newTag.color });
      created.push(name);
    }
  }

  // Cache tag names in the article's ai_tags field
  db.update(articles)
    .set({
      aiTags: JSON.stringify(suggestedNames),
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(articles.id, articleId))
    .run();

  logger.info(
    { event: 'ai_auto_tag', articleId, tagCount: resultTags.length, newTags: created.length },
    'Article auto-tagged',
  );
  return NextResponse.json({ tags: resultTags, created });
});
