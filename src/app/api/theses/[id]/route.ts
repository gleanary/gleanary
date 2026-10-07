import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { theses } from '@/db/schema';
import { updateThesisSchema, parseIdParam } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getThesisOrThrow, getThesisDetail } from '@/lib/db-helpers';
import { NotFoundError } from '@/lib/errors';
import type { RouteContext } from '@/types';

/**
 * GET /api/theses/[id] — Get a single thesis with all linked highlights and research.
 * @param _req - NextRequest (unused)
 * @param context - Route context with thesis ID
 * @returns Thesis detail with highlights and research
 */
export const GET = withRoute(
  'GET /api/theses/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const detail = getThesisDetail(id);
    if (!detail) throw new NotFoundError('Thesis', id);
    return NextResponse.json(detail);
  },
);

/**
 * PATCH /api/theses/[id] — Update thesis fields.
 * Auto-advances status nascent→developing when claim is added.
 * @param req - NextRequest with JSON body matching updateThesisSchema
 * @param context - Route context with thesis ID
 * @returns Updated thesis
 */
export const PATCH = withRoute(
  'PATCH /api/theses/[id]',
  async (req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const thesis = getThesisOrThrow(id);

    const body = await req.json();
    const data = updateThesisSchema.parse(body);

    // Auto-advance status nascent→developing when claim is added (unless status explicitly set)
    let resolvedStatus = data.status ?? thesis.status;
    if (
      !data.status &&
      thesis.status === 'nascent' &&
      data.claim !== undefined &&
      data.claim.trim().length > 0
    ) {
      resolvedStatus = 'developing';
    }

    const updated = db
      .update(theses)
      .set({
        ...data,
        status: resolvedStatus,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(theses.id, id))
      .returning()
      .get()!;

    logger.info({ event: 'thesis_updated', thesisId: id }, 'Thesis updated');
    return NextResponse.json({ thesis: updated });
  },
);

/**
 * DELETE /api/theses/[id] — Delete a thesis.
 * Cascades to thesis_highlights and thesis_research. Highlights/articles preserved.
 * @param _req - NextRequest (unused)
 * @param context - Route context with thesis ID
 * @returns { deleted: true }
 */
export const DELETE = withRoute(
  'DELETE /api/theses/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);

    const result = db.delete(theses).where(eq(theses.id, id)).run();
    if (result.changes === 0) throw new NotFoundError('Thesis', id);

    logger.info({ event: 'thesis_deleted', thesisId: id }, 'Thesis deleted');
    return NextResponse.json({ deleted: true });
  },
);
