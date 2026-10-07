import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { sources } from '@/db/schema';
import { parseIdParam } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { NotFoundError } from '@/lib/errors';
import type { RouteContext } from '@/types';

/**
 * DELETE /api/sources/[id] — Remove a source (articles remain with null sourceId).
 * @param req - NextRequest
 * @param context - Route context with id param
 * @returns Deletion confirmation
 */
export const DELETE = withRoute(
  'DELETE /api/sources/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);

    const deleted = db
      .delete(sources)
      .where(eq(sources.id, id))
      .returning({ id: sources.id })
      .get();
    if (!deleted) {
      throw new NotFoundError('Source', id);
    }

    logger.info({ event: 'source_deleted', sourceId: id }, 'Source deleted');
    return NextResponse.json({ deleted: true });
  },
);
