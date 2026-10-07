import { NextRequest, NextResponse } from 'next/server';
import { inArray, eq, and } from 'drizzle-orm';
import { db } from '@/db';
import { highlights, highlightTags } from '@/db/schema';
import { bulkTagHighlightsSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';

/**
 * POST /api/highlights/bulk-tag — Add or replace tags on multiple highlights.
 * @param req - NextRequest with JSON body matching bulkTagHighlightsSchema
 * @returns Count of updated highlights
 */
export const POST = withRoute('POST /api/highlights/bulk-tag', async (req: NextRequest) => {
  const body = await req.json();
  const { ids, tagIds: rawTagIds, mode } = bulkTagHighlightsSchema.parse(body);
  // Dedupe: a repeated tag id would violate the highlight_tags_unique index in replace mode.
  const tagIds = [...new Set(rawTagIds)];

  // Find which highlights actually exist
  const existing = db
    .select({ id: highlights.id })
    .from(highlights)
    .where(inArray(highlights.id, ids))
    .all();

  const existingIds = existing.map((h) => h.id);

  for (const highlightId of existingIds) {
    if (mode === 'replace') {
      db.delete(highlightTags).where(eq(highlightTags.highlightId, highlightId)).run();
    }

    for (const tagId of tagIds) {
      if (mode === 'add') {
        // Check if association already exists to avoid duplicates
        const exists = db
          .select({ highlightId: highlightTags.highlightId })
          .from(highlightTags)
          .where(and(eq(highlightTags.highlightId, highlightId), eq(highlightTags.tagId, tagId)))
          .get();
        if (exists) continue;
      }
      db.insert(highlightTags).values({ highlightId, tagId }).run();
    }
  }

  logger.info(
    { event: 'highlights_bulk_tagged', count: existingIds.length, mode, tagIds },
    'Bulk tagged highlights',
  );
  return NextResponse.json({ updated: existingIds.length });
});
