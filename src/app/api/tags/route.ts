import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { tags, highlightTags } from '@/db/schema';
import { createTagSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';

/**
 * GET /api/tags — List all tags with usage counts.
 * @returns Array of tags with highlightCount
 */
export const GET = withRoute('GET /api/tags', async (_req?: NextRequest) => {
  const allTags = db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      createdAt: tags.createdAt,
      highlightCount: sql<number>`count(${highlightTags.highlightId})`,
    })
    .from(tags)
    .leftJoin(highlightTags, eq(tags.id, highlightTags.tagId))
    .groupBy(tags.id)
    .all();

  return NextResponse.json({ tags: allTags });
});

/**
 * POST /api/tags — Create a new tag.
 * @param req - NextRequest with JSON body matching createTagSchema
 * @returns Created tag with 201 status
 */
export const POST = withRoute('POST /api/tags', async (req: NextRequest) => {
  const body = await req.json();
  const data = createTagSchema.parse(body);

  const tag = db
    .insert(tags)
    .values({
      name: data.name,
      color: data.color,
    })
    .returning()
    .get()!;

  logger.info({ event: 'tag_created', tagId: tag.id, name: data.name }, 'Tag created');
  return NextResponse.json({ tag }, { status: 201 });
});
