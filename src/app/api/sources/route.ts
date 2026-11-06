import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { sources } from '@/db/schema';
import { createSourceSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { liveSource } from '@/lib/db-helpers';
import type { CreateSourceResponse } from '@/types';

/**
 * GET /api/sources — List all sources that are not soft-deleted.
 * @returns Array of live sources
 */
export const GET = withRoute('GET /api/sources', async (_req?: NextRequest) => {
  const allSources = db.select().from(sources).where(liveSource).all();
  return NextResponse.json({ sources: allSources });
});

/**
 * POST /api/sources — Create a new source. For an `rss_feed` whose `feedUrl` matches a
 * soft-deleted feed exactly, that feed (the most recently deleted one) is restored instead:
 * `deleted_at` is cleared, name/icon/category/poll interval are overwritten, and its
 * polling state (etag, last_modified, last_polled) is kept.
 * @param req - NextRequest with JSON body matching createSourceSchema
 * @returns 201 `{ source }` when created, 200 `{ source, restored: true }` when restored
 */
export const POST = withRoute('POST /api/sources', async (req: NextRequest) => {
  const body = await req.json();
  const data = createSourceSchema.parse(body);

  // On restore these overwrite the old row, so an omitted field clears it (as on create)
  const values = {
    name: data.name,
    iconUrl: data.iconUrl ?? null,
    category: data.category ?? null,
    pollInterval: data.pollInterval,
  };

  if (data.type === 'rss_feed' && data.feedUrl) {
    const deletedFeed = db
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.type, 'rss_feed'),
          eq(sources.feedUrl, data.feedUrl),
          isNotNull(sources.deletedAt),
        ),
      )
      .orderBy(desc(sources.deletedAt), desc(sources.id))
      .get();

    if (deletedFeed) {
      const source = db
        .update(sources)
        .set({ ...values, deletedAt: null })
        .where(eq(sources.id, deletedFeed.id))
        .returning()
        .get()!;

      logger.info({ event: 'source_restored', sourceId: source.id }, 'Source restored');
      return NextResponse.json<CreateSourceResponse>({ source, restored: true }, { status: 200 });
    }
  }

  const source = db
    .insert(sources)
    .values({ ...values, type: data.type, feedUrl: data.feedUrl })
    .returning()
    .get()!;

  logger.info({ event: 'source_created', sourceId: source.id, type: data.type }, 'Source created');
  return NextResponse.json<CreateSourceResponse>({ source }, { status: 201 });
});
