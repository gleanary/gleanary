import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { drafts, theses } from '@/db/schema';
import { createDraftSchema, listDraftsSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import {
  getThesisOrThrow,
  assertHighlightsBelongToThesis,
  assertResearchBelongToThesis,
} from '@/lib/db-helpers';
import { DEFAULT_DRAFT_MODEL } from '@/lib/models';
import type { DraftContextSnapshot } from '@/types';

/**
 * GET /api/drafts — List drafts with optional filters, joined with parent thesis title.
 * @param req - NextRequest with optional query params (thesisId, templateId, status, limit)
 * @returns List of drafts with total count
 */
export const GET = withRoute('GET /api/drafts', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const query = listDraftsSchema.parse(params);

  const conditions = [];
  if (query.thesisId !== undefined) conditions.push(eq(drafts.thesisId, query.thesisId));
  if (query.templateId !== undefined) conditions.push(eq(drafts.templateId, query.templateId));
  if (query.status !== undefined) conditions.push(eq(drafts.status, query.status));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db
    .select({
      id: drafts.id,
      thesisId: drafts.thesisId,
      thesisTitle: theses.title,
      templateId: drafts.templateId,
      title: drafts.title,
      angle: drafts.angle,
      status: drafts.status,
      generatedAt: drafts.generatedAt,
      lastEditedAt: drafts.lastEditedAt,
      publishedAt: drafts.publishedAt,
      createdAt: drafts.createdAt,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .innerJoin(theses, eq(drafts.thesisId, theses.id))
    .where(whereClause)
    .orderBy(desc(drafts.createdAt))
    .limit(query.limit)
    .offset(query.offset)
    .all();

  const totalResult = whereClause
    ? db
        .select({ count: sql<number>`count(*)` })
        .from(drafts)
        .where(whereClause)
        .get()
    : db
        .select({ count: sql<number>`count(*)` })
        .from(drafts)
        .get();

  return NextResponse.json({ drafts: rows, total: totalResult?.count ?? 0 });
});

/**
 * POST /api/drafts — Create a new draft shell (no generation).
 * Validates thesis exists, all highlight/research IDs belong to the thesis.
 * Seeds title from thesis title and writes context_snapshot.
 * @param req - NextRequest with JSON body matching createDraftSchema
 * @returns Created draft, 201 status
 */
export const POST = withRoute('POST /api/drafts', async (req: NextRequest) => {
  const body = await req.json();
  const data = createDraftSchema.parse(body);

  const thesis = getThesisOrThrow(data.thesisId);
  assertHighlightsBelongToThesis(data.thesisId, data.includedHighlightIds);
  assertResearchBelongToThesis(data.thesisId, data.includedResearchIds);

  const contextSnapshot: DraftContextSnapshot = {
    highlightIds: data.includedHighlightIds,
    researchIds: data.includedResearchIds,
  };

  const draft = db
    .insert(drafts)
    .values({
      thesisId: data.thesisId,
      templateId: data.templateId,
      model: data.model ?? DEFAULT_DRAFT_MODEL,
      title: thesis.title,
      angle: data.angle,
      contextSnapshot: JSON.stringify(contextSnapshot),
    })
    .returning()
    .get()!;

  logger.info(
    { event: 'draft_created', draftId: draft.id, thesisId: data.thesisId },
    'Draft created',
  );
  return NextResponse.json({ draft }, { status: 201 });
});
