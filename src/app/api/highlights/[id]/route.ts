import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { highlights } from '@/db/schema';
import { parseIdParam, updateHighlightSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { NotFoundError } from '@/lib/errors';
import { getHighlightTags, replaceHighlightTags } from '@/lib/highlight-utils';
import type { RouteContext } from '@/types';

/**
 * PATCH /api/highlights/[id] — Update highlight text, note, positionData, or tags.
 * @param req - NextRequest with JSON body matching updateHighlightSchema
 * @param context - Route context with id param
 * @returns Updated highlight with tags
 */
export const PATCH = withRoute(
  'PATCH /api/highlights/[id]',
  async (req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const body = await req.json();
    const data = updateHighlightSchema.parse(body);

    // Build update object (exclude tagIds, handle separately)
    const { tagIds, ...fieldUpdates } = data;
    const updates: Record<string, unknown> = {
      ...fieldUpdates,
      updatedAt: sql`(datetime('now'))`,
    };

    const highlight = db
      .update(highlights)
      .set(updates)
      .where(eq(highlights.id, id))
      .returning()
      .get();
    if (!highlight) {
      throw new NotFoundError('Highlight', id);
    }

    // Replace tags if tagIds provided (batch operation)
    if (tagIds !== undefined) {
      replaceHighlightTags(id, tagIds);
    }

    const highlightWithTags = {
      ...highlight,
      tags: getHighlightTags(id),
    };

    logger.info({ event: 'highlight_updated', highlightId: id }, 'Highlight updated');
    return NextResponse.json({ highlight: highlightWithTags });
  },
);

/**
 * DELETE /api/highlights/[id] — Delete a highlight.
 * @param req - NextRequest
 * @param context - Route context with id param
 * @returns Deletion confirmation
 */
export const DELETE = withRoute(
  'DELETE /api/highlights/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);

    const deleted = db
      .delete(highlights)
      .where(eq(highlights.id, id))
      .returning({ id: highlights.id })
      .get();
    if (!deleted) {
      throw new NotFoundError('Highlight', id);
    }

    logger.info({ event: 'highlight_deleted', highlightId: id }, 'Highlight deleted');
    return NextResponse.json({ deleted: true });
  },
);
