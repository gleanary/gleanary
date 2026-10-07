import { NextRequest, NextResponse } from 'next/server';
import { inArray } from 'drizzle-orm';
import { db } from '@/db';
import { highlights } from '@/db/schema';
import { bulkDeleteHighlightsSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';

/**
 * POST /api/highlights/bulk-delete — Delete multiple highlights by ID.
 * @param req - NextRequest with JSON body matching bulkDeleteHighlightsSchema
 * @returns Count of actually deleted highlights
 */
export const POST = withRoute('POST /api/highlights/bulk-delete', async (req: NextRequest) => {
  const body = await req.json();
  const { ids } = bulkDeleteHighlightsSchema.parse(body);

  const deleted = db
    .delete(highlights)
    .where(inArray(highlights.id, ids))
    .returning({ id: highlights.id })
    .all();

  logger.info(
    { event: 'highlights_bulk_deleted', count: deleted.length, requestedIds: ids },
    'Bulk deleted highlights',
  );
  return NextResponse.json({ deleted: deleted.length });
});
