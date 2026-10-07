import { NextRequest, NextResponse } from 'next/server';
import { eq, desc, asc, sql, gte, lte } from 'drizzle-orm';
import { db } from '@/db';
import { articles, highlights, highlightTags } from '@/db/schema';
import { createHighlightSchema, listHighlightsSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getArticleOrThrow } from '@/lib/db-helpers';
import { getHighlightTags, getTagsForHighlights, linkHighlightTags } from '@/lib/highlight-utils';

/**
 * GET /api/highlights — List highlights with filtering, sorting, and pagination.
 * Returns article context (title, url, siteName) and tags with each highlight.
 * @param req - NextRequest with optional query params
 * @returns Paginated list of highlights with total count
 */
export const GET = withRoute('GET /api/highlights', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const query = listHighlightsSchema.parse(params);

  const conditions = [];

  if (query.articleId) {
    conditions.push(eq(highlights.articleId, query.articleId));
  }
  if (query.color) {
    conditions.push(eq(highlights.color, query.color));
  }
  if (query.sourceId) {
    conditions.push(eq(articles.sourceId, query.sourceId));
  }
  if (query.dateFrom) {
    conditions.push(gte(highlights.createdAt, query.dateFrom));
  }
  if (query.dateTo) {
    // Include the full day for date-only strings by adding a day
    const toValue = query.dateTo.length === 10 ? `${query.dateTo}T23:59:59` : query.dateTo;
    conditions.push(lte(highlights.createdAt, toValue));
  }

  const where = conditions.length > 0 ? sql`${sql.join(conditions, sql` AND `)}` : undefined;

  // Always join articles for context; optionally join highlightTags for tag filter
  const needsTagJoin = !!query.tagId;
  const tagCondition = query.tagId ? eq(highlightTags.tagId, query.tagId) : undefined;
  const fullWhere =
    where && tagCondition
      ? sql`${where} AND ${tagCondition}`
      : (where ?? tagCondition ?? undefined);

  let baseQuery = db
    .select({
      highlight: highlights,
      articleTitle: articles.title,
      articleUrl: articles.url,
      articleSiteName: articles.siteName,
    })
    .from(highlights)
    .innerJoin(articles, eq(highlights.articleId, articles.id));

  if (needsTagJoin) {
    baseQuery = baseQuery.innerJoin(
      highlightTags,
      eq(highlights.id, highlightTags.highlightId),
    ) as typeof baseQuery;
  }

  baseQuery = baseQuery.where(fullWhere) as typeof baseQuery;

  const sortColumn = {
    createdAt: highlights.createdAt,
    updatedAt: highlights.updatedAt,
  }[query.sort];

  const orderFn = query.order === 'asc' ? asc : desc;

  const rows = baseQuery.orderBy(orderFn(sortColumn)).limit(query.limit).offset(query.offset).all();

  // Count query
  let countQuery = db
    .select({
      count: needsTagJoin ? sql<number>`count(DISTINCT ${highlights.id})` : sql<number>`count(*)`,
    })
    .from(highlights)
    .innerJoin(articles, eq(highlights.articleId, articles.id));

  if (needsTagJoin) {
    countQuery = countQuery.innerJoin(
      highlightTags,
      eq(highlights.id, highlightTags.highlightId),
    ) as typeof countQuery;
  }

  const totalResult = countQuery.where(fullWhere).get();

  // Batch-fetch tags for all highlights (avoids N+1)
  const highlightIds = rows.map((r) => r.highlight.id);
  const tagsMap = getTagsForHighlights(highlightIds);

  const highlightList = rows.map((r) => ({
    ...r.highlight,
    article: {
      title: r.articleTitle,
      url: r.articleUrl,
      siteName: r.articleSiteName,
    },
    tags: tagsMap.get(r.highlight.id) ?? [],
  }));

  return NextResponse.json({
    highlights: highlightList,
    total: totalResult?.count ?? 0,
  });
});

/**
 * POST /api/highlights — Create a highlight on an article.
 * @param req - NextRequest with JSON body matching createHighlightSchema
 * @returns Created highlight with tags, 201 status
 */
export const POST = withRoute('POST /api/highlights', async (req: NextRequest) => {
  const body = await req.json();
  const data = createHighlightSchema.parse(body);

  // Verify article exists
  getArticleOrThrow(data.articleId);

  const highlight = db
    .insert(highlights)
    .values({
      articleId: data.articleId,
      text: data.text,
      note: data.note,
      color: data.color,
      positionData: data.positionData,
    })
    .returning()
    .get()!;

  // Link tags if provided (batch insert)
  if (data.tagIds) {
    linkHighlightTags(highlight.id, data.tagIds);
  }

  const highlightWithTags = {
    ...highlight,
    tags: getHighlightTags(highlight.id),
  };

  logger.info(
    { event: 'highlight_created', highlightId: highlight.id, articleId: data.articleId },
    'Highlight created',
  );
  return NextResponse.json({ highlight: highlightWithTags }, { status: 201 });
});
