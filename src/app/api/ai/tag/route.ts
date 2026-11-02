import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { autoTagSchema } from '@/lib/validators';
import {
  callClaude,
  truncateContent,
  parseTagsResponse,
  normalizeTagName,
  AUTO_TAG_PROMPT,
} from '@/lib/ai';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { ValidationError } from '@/lib/errors';
import { getArticleOrThrow } from '@/lib/db-helpers';
import { parseAiTags } from '@/lib/text-utils';
import type { AutoTagResponse } from '@/types';

/** Most frequent article tags sent as the vocabulary hint, so the prompt stays bounded. */
const ARTICLE_TAG_VOCABULARY_LIMIT = 200;

/**
 * Article tag names already used by other articles, keyed by trimmed lower case (first
 * spelling wins) and limited to the {@link ARTICLE_TAG_VOCABULARY_LIMIT} most frequent.
 * Article tags are their own vocabulary: the highlight `tags` table is not read.
 * @param articleId - The article being tagged (its own previous tags are left out)
 * @returns Map from lower-cased name to its existing spelling, most frequent first
 */
function getArticleTagVocabulary(articleId: number): Map<string, string> {
  // Only the ai_tags column: whole rows would load every article's full HTML
  const rows = db
    .select({ id: articles.id, aiTags: articles.aiTags })
    .from(articles)
    .where(and(isNotNull(articles.aiTags), ne(articles.id, articleId)))
    .all();
  const tally = new Map<string, { name: string; count: number }>();
  for (const row of rows) {
    const names = parseAiTags(row.aiTags, () =>
      logger.warn(
        { event: 'ai_tags_malformed', articleId: row.id },
        'Ignoring malformed article ai_tags',
      ),
    );
    for (const name of names) {
      const key = normalizeTagName(name);
      if (!key) continue;
      const entry = tally.get(key);
      if (entry) entry.count++;
      else tally.set(key, { name: name.trim(), count: 1 });
    }
  }
  // Stable sort: ties keep first-seen order
  return new Map(
    [...tally]
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, ARTICLE_TAG_VOCABULARY_LIMIT)
      .map(([key, { name }]) => [key, name]),
  );
}

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
