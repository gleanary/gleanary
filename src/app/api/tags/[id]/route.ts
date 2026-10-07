import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { tags } from '@/db/schema';
import { parseIdParam, updateTagSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { NotFoundError } from '@/lib/errors';
import type { RouteContext } from '@/types';

/**
 * PATCH /api/tags/[id] — Update a tag's name or color.
 * @param req - NextRequest with JSON body matching updateTagSchema
 * @param context - Route context with id param
 * @returns Updated tag
 */
export const PATCH = withRoute(
  'PATCH /api/tags/[id]',
  async (req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const body = await req.json();
    const data = updateTagSchema.parse(body);

    const tag = db.update(tags).set(data).where(eq(tags.id, id)).returning().get();
    if (!tag) {
      throw new NotFoundError('Tag', id);
    }

    logger.info({ event: 'tag_updated', tagId: id }, 'Tag updated');
    return NextResponse.json({ tag });
  },
);

/**
 * DELETE /api/tags/[id] — Delete a tag. Cascade removes highlight_tags associations.
 * @param _req - NextRequest
 * @param context - Route context with id param
 * @returns Deletion confirmation
 */
export const DELETE = withRoute(
  'DELETE /api/tags/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);

    const deleted = db.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id }).get();
    if (!deleted) {
      throw new NotFoundError('Tag', id);
    }

    logger.info({ event: 'tag_deleted', tagId: id }, 'Tag deleted');
    return NextResponse.json({ deleted: true });
  },
);
