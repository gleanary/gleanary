import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { thesisResearch } from '@/db/schema';
import { idParamSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getThesisOrThrow } from '@/lib/db-helpers';
import { NotFoundError } from '@/lib/errors';

type ResearchContext = { params: Promise<Record<string, string>> };

/**
 * DELETE /api/theses/[id]/research/[researchId] — Remove a research entry from a thesis.
 * @param _req - NextRequest (unused)
 * @param context - Route context with thesis ID and research ID
 * @returns { deleted: true }
 */
export const DELETE = withRoute(
  'DELETE /api/theses/[id]/research/[researchId]',
  async (_req: NextRequest, context: ResearchContext) => {
    const { id: rawId, researchId: rawResearchId } = await context.params;
    const { id: thesisId } = idParamSchema.parse({ id: rawId });
    const { id: researchId } = idParamSchema.parse({ id: rawResearchId });

    getThesisOrThrow(thesisId);

    const result = db
      .delete(thesisResearch)
      .where(and(eq(thesisResearch.id, researchId), eq(thesisResearch.thesisId, thesisId)))
      .run();

    if (result.changes === 0) {
      throw new NotFoundError('ThesisResearch');
    }

    logger.info(
      { event: 'thesis_research_deleted', thesisId, researchId },
      'Research entry deleted',
    );
    return NextResponse.json({ deleted: true });
  },
);
