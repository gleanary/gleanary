import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { thesisResearch } from '@/db/schema';
import { addResearchSchema, parseIdParam } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getThesisOrThrow, autoAdvanceThesisOnResearch } from '@/lib/db-helpers';
import type { RouteContext } from '@/types';

/**
 * POST /api/theses/[id]/research — Add a research entry to a thesis.
 * Auto-advances status developing→researched on first research entry.
 * @param req - NextRequest with JSON body matching addResearchSchema
 * @param context - Route context with thesis ID
 * @returns Created research entry, 201 status
 */
export const POST = withRoute(
  'POST /api/theses/[id]/research',
  async (req: NextRequest, context: RouteContext) => {
    const thesisId = await parseIdParam(context);
    const thesis = getThesisOrThrow(thesisId);

    const body = await req.json();
    const data = addResearchSchema.parse(body);

    const research = db
      .insert(thesisResearch)
      .values({
        thesisId,
        title: data.title,
        content: data.content,
        source: data.source,
      })
      .returning()
      .get()!;

    // Auto-advance status developing→researched on first research entry
    autoAdvanceThesisOnResearch(thesisId, thesis.status);

    logger.info(
      { event: 'thesis_research_added', thesisId, researchId: research.id },
      'Research added to thesis',
    );
    return NextResponse.json({ research }, { status: 201 });
  },
);
