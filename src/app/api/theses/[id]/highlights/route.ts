import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { theses, thesisHighlights, highlights } from '@/db/schema';
import { linkHighlightsSchema, parseIdParam } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getThesisOrThrow } from '@/lib/db-helpers';
import { DuplicateError, NotFoundError } from '@/lib/errors';
import type { RouteContext } from '@/types';

/**
 * POST /api/theses/[id]/highlights — Link one or more highlights to a thesis.
 * Auto-advances status nascent→developing when first highlight is linked.
 * @param req - NextRequest with JSON body matching linkHighlightsSchema
 * @param context - Route context with thesis ID
 * @returns Created links, 201 status
 */
export const POST = withRoute(
  'POST /api/theses/[id]/highlights',
  async (req: NextRequest, context: RouteContext) => {
    const thesisId = await parseIdParam(context);
    const thesis = getThesisOrThrow(thesisId);

    const body = await req.json();
    const data = linkHighlightsSchema.parse(body);

    // Verify all highlights exist in one query
    const foundHighlights = db
      .select({ id: highlights.id })
      .from(highlights)
      .where(inArray(highlights.id, data.highlightIds))
      .all();
    if (foundHighlights.length !== data.highlightIds.length) {
      throw new NotFoundError('Highlight');
    }

    // Check for existing links to detect duplicates
    const existingLinks = db
      .select({ highlightId: thesisHighlights.highlightId })
      .from(thesisHighlights)
      .where(eq(thesisHighlights.thesisId, thesisId))
      .all();
    const existingIds = new Set(existingLinks.map((l) => l.highlightId));

    const duplicates = data.highlightIds.filter((id) => existingIds.has(id));
    if (duplicates.length > 0) {
      throw new DuplicateError('ThesisHighlight', 'thesis_id+highlight_id');
    }

    // Bulk insert all links
    const links = db
      .insert(thesisHighlights)
      .values(
        data.highlightIds.map((highlightId) => ({
          thesisId,
          highlightId,
          role: data.role,
          note: data.note,
        })),
      )
      .returning()
      .all();

    // Bulk update highlights.thesis_id where not yet set
    db.update(highlights)
      .set({ thesisId })
      .where(and(inArray(highlights.id, data.highlightIds), isNull(highlights.thesisId)))
      .run();

    // Auto-advance status nascent→developing on first highlight link
    if (thesis.status === 'nascent') {
      db.update(theses)
        .set({ status: 'developing', updatedAt: sql`(datetime('now'))` })
        .where(eq(theses.id, thesisId))
        .run();
    }

    logger.info(
      { event: 'thesis_highlights_linked', thesisId, count: links.length },
      'Highlights linked to thesis',
    );
    return NextResponse.json({ links }, { status: 201 });
  },
);
