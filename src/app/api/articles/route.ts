import { NextRequest, NextResponse } from 'next/server';
import { eq, ne, desc, asc, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { createArticleSchema, listArticlesSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { articlesBySourceType, articlesExcludingSourceType } from '@/lib/db-helpers';
import { computeWordCount } from '@/lib/text-utils';

/**
 * GET /api/articles — List articles with filtering, sorting, and pagination.
 * @param req - NextRequest with optional query params: status, sourceId, isFavorite, sort, order, limit, offset
 * @returns Paginated list of articles with total count
 */
export const GET = withRoute('GET /api/articles', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const query = listArticlesSchema.parse(params);

  // Never expose pending_review articles through the standard articles API —
  // they are held for newsletter sender approval and managed via /api/newsletters.
  const conditions = [ne(articles.status, 'pending_review')];

  if (query.status && query.status.length > 0) {
    if (query.status.length === 1) {
      conditions.push(eq(articles.status, query.status[0]!));
    } else {
      conditions.push(inArray(articles.status, query.status));
    }
  }

  if (query.sourceId) {
    conditions.push(eq(articles.sourceId, query.sourceId));
  }

  if (query.sourceType) {
    conditions.push(articlesBySourceType(query.sourceType));
  }

  if (query.excludeSourceType) {
    conditions.push(articlesExcludingSourceType(query.excludeSourceType));
  }

  if (query.isFavorite !== undefined) {
    conditions.push(eq(articles.isFavorite, query.isFavorite === 'true'));
  }

  const sortColumn = {
    savedAt: articles.savedAt,
    title: articles.title,
    readingProgress: articles.readingProgress,
  }[query.sort];

  const orderFn = query.order === 'asc' ? asc : desc;

  const where = conditions.length > 0 ? sql`${sql.join(conditions, sql` AND `)}` : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select({
        id: articles.id,
        sourceId: articles.sourceId,
        url: articles.url,
        title: articles.title,
        author: articles.author,
        excerpt: articles.excerpt,
        siteName: articles.siteName,
        imageUrl: articles.imageUrl,
        wordCount: articles.wordCount,
        pageCount: articles.pageCount,
        originalFilePath: articles.originalFilePath,
        extractionTier: articles.extractionTier,
        readingProgress: articles.readingProgress,
        status: articles.status,
        isFavorite: articles.isFavorite,
        aiSummary: articles.aiSummary,
        aiTags: articles.aiTags,
        publishedAt: articles.publishedAt,
        savedAt: articles.savedAt,
        readAt: articles.readAt,
        createdAt: articles.createdAt,
        updatedAt: articles.updatedAt,
      })
      .from(articles)
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(articles)
      .where(where),
  ]);

  return NextResponse.json({ articles: rows, total: countResult[0]?.count ?? 0 });
});

/**
 * POST /api/articles — Create a new article.
 * @param req - NextRequest with JSON body matching createArticleSchema
 * @returns Created article with 201 status
 */
export const POST = withRoute('POST /api/articles', async (req: NextRequest) => {
  const body = await req.json();
  const data = createArticleSchema.parse(body);

  // Compute word count from contentText if not provided
  const wordCount = data.wordCount ?? computeWordCount(data.contentText ?? '');

  const article = db
    .insert(articles)
    .values({
      url: data.url,
      title: data.title,
      author: data.author,
      contentHtml: data.contentHtml,
      contentText: data.contentText,
      excerpt: data.excerpt,
      siteName: data.siteName,
      imageUrl: data.imageUrl,
      wordCount,
      sourceId: data.sourceId,
      publishedAt: data.publishedAt,
      status: data.status,
    })
    .returning()
    .get()!;

  logger.info({ event: 'article_saved', articleId: article.id, url: data.url }, 'Article saved');
  return NextResponse.json({ article }, { status: 201 });
});
