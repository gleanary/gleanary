import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { sources } from '@/db/schema';
import { parseIdParam } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getSourceOrThrow, liveSource } from '@/lib/db-helpers';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { isSingletonSourceType, isUndeletableSourceType } from '@/types';
import type { DeleteSourceResponse, RouteContext } from '@/types';

/**
 * DELETE /api/sources/[id] — Soft-delete a source: sets `deleted_at`, keeps the row, and
 * its articles keep pointing at it. Singleton and newsletter sources can't be deleted.
 * @param req - NextRequest
 * @param context - Route context with id param
 * @returns `{ deleted: true }`; 404 for an unknown or already-deleted source, 422 for an
 *   undeletable type
 */
export const DELETE = withRoute(
  'DELETE /api/sources/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);

    const source = getSourceOrThrow(id); // 404 for unknown or already soft-deleted

    if (isUndeletableSourceType(source.type)) {
      throw new ValidationError(
        isSingletonSourceType(source.type)
          ? "Built-in sources can't be deleted"
          : "Newsletter senders can't be deleted; block them instead",
      );
    }

    // liveSource in the WHERE keeps a concurrent second DELETE a 404
    const deleted = db
      .update(sources)
      .set({ deletedAt: sql`(datetime('now'))` })
      .where(and(eq(sources.id, id), liveSource))
      .returning({ id: sources.id })
      .get();
    if (!deleted) throw new NotFoundError('Source', id);

    logger.info({ event: 'source_deleted', sourceId: id, type: source.type }, 'Source deleted');
    return NextResponse.json<DeleteSourceResponse>({ deleted: true });
  },
);
