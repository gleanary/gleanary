import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { sources } from '@/db/schema';
import { createSourceSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';

/**
 * GET /api/sources — List all sources.
 * @returns Array of all sources
 */
export const GET = withRoute('GET /api/sources', async (_req?: NextRequest) => {
  const allSources = db.select().from(sources).all();
  return NextResponse.json({ sources: allSources });
});

/**
 * POST /api/sources — Create a new source.
 * @param req - NextRequest with JSON body matching createSourceSchema
 * @returns Created source with 201 status
 */
export const POST = withRoute('POST /api/sources', async (req: NextRequest) => {
  const body = await req.json();
  const data = createSourceSchema.parse(body);

  const source = db
    .insert(sources)
    .values({
      type: data.type,
      name: data.name,
      feedUrl: data.feedUrl,
      iconUrl: data.iconUrl,
      category: data.category,
      pollInterval: data.pollInterval,
    })
    .returning()
    .get()!;

  logger.info({ event: 'source_created', sourceId: source.id, type: data.type }, 'Source created');
  return NextResponse.json({ source }, { status: 201 });
});
