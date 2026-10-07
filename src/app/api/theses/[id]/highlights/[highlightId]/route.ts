import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { highlights, thesisHighlights } from '@/db/schema';
import { idParamSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getThesisOrThrow } from '@/lib/db-helpers';
import { NotFoundError } from '@/lib/errors';

type HighlightLinkContext = { params: Promise<Record<string, string>> };

/**
 * DELETE /api/theses/[id]/highlights/[highlightId] — Remove a highlight link from a thesis.
 * The highlight itself is preserved.
 * @param _req - NextRequest (unused)
 * @param context - Route context with thesis ID and highlight ID
 * @returns { deleted: true }
 */
export const DELETE = withRoute(
  'DELETE /api/theses/[id]/highlights/[highlightId]',
  async (_req: NextRequest, context: HighlightLinkContext) => {
    const { id: rawId, highlightId: rawHighlightId } = await context.params;
    const { id: thesisId } = idParamSchema.parse({ id: rawId });
    const { id: highlightId } = idParamSchema.parse({ id: rawHighlightId });

    getThesisOrThrow(thesisId);

    const result = db
      .delete(thesisHighlights)
      .where(
        and(eq(thesisHighlights.thesisId, thesisId), eq(thesisHighlights.highlightId, highlightId)),
      )
      .run();

    if (result.changes === 0) {
      throw new NotFoundError('ThesisHighlight');
    }

    // Clear highlights.thesisId if it was pointing to this thesis (quick-link denorm)
    db.update(highlights)
      .set({ thesisId: null })
      .where(and(eq(highlights.id, highlightId), eq(highlights.thesisId, thesisId)))
      .run();

    logger.info(
      { event: 'thesis_highlight_unlinked', thesisId, highlightId },
      'Highlight unlinked from thesis',
    );
    return NextResponse.json({ deleted: true });
  },
);
