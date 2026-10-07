import { NextRequest, NextResponse } from 'next/server';
import { and, desc, asc, inArray, sql } from 'drizzle-orm';
import { db, rawDb } from '@/db';
import { theses, thesisHighlights, thesisResearch } from '@/db/schema';
import { createThesisSchema, listThesesSchema } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { escapeFts5Query } from '@/lib/search';
import { assertHighlightsExist } from '@/lib/db-helpers';
import type { ThesisListItem } from '@/types';

/**
 * GET /api/theses — List theses with optional filtering, search, and pagination.
 * Returns each thesis with its linked highlight and research counts.
 * @param req - NextRequest with optional query params
 * @returns Paginated list of theses with total count
 */
export const GET = withRoute('GET /api/theses', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const query = listThesesSchema.parse(params);

  let thesisIds: number[] | null = null;

  // FTS5 search — find matching thesis IDs first
  if (query.search) {
    const escaped = escapeFts5Query(query.search);
    if (escaped) {
      const rows = rawDb
        .prepare('SELECT rowid FROM theses_fts WHERE theses_fts MATCH ? ORDER BY rank')
        .all(`${escaped}*`) as Array<{ rowid: number }>;
      thesisIds = rows.map((r) => r.rowid);
      if (thesisIds.length === 0) {
        return NextResponse.json({ theses: [], total: 0 });
      }
    }
  }

  // Build base query
  let baseQuery = db.select().from(theses);

  const conditions = [];

  if (query.status && query.status.length > 0) {
    conditions.push(inArray(theses.status, query.status));
  }

  if (thesisIds !== null) {
    conditions.push(inArray(theses.id, thesisIds));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  if (whereClause) {
    baseQuery = baseQuery.where(whereClause) as typeof baseQuery;
  }

  const sortColumn = {
    updatedAt: theses.updatedAt,
    createdAt: theses.createdAt,
    title: theses.title,
    status: theses.status,
  }[query.sort];

  const orderFn = query.order === 'asc' ? asc : desc;

  const rows = baseQuery.orderBy(orderFn(sortColumn)).limit(query.limit).offset(query.offset).all();

  // Count
  let countQuery = db.select({ count: sql<number>`count(*)` }).from(theses);
  if (whereClause) {
    countQuery = countQuery.where(whereClause) as typeof countQuery;
  }
  const totalResult = countQuery.get();

  // Batch-fetch highlight and research counts
  const ids = rows.map((t) => t.id);

  const highlightCounts = ids.length
    ? db
        .select({ thesisId: thesisHighlights.thesisId, count: sql<number>`count(*)` })
        .from(thesisHighlights)
        .where(inArray(thesisHighlights.thesisId, ids))
        .groupBy(thesisHighlights.thesisId)
        .all()
    : [];

  const researchCounts = ids.length
    ? db
        .select({ thesisId: thesisResearch.thesisId, count: sql<number>`count(*)` })
        .from(thesisResearch)
        .where(inArray(thesisResearch.thesisId, ids))
        .groupBy(thesisResearch.thesisId)
        .all()
    : [];

  const hlMap = new Map(highlightCounts.map((r) => [r.thesisId, r.count]));
  const resMap = new Map(researchCounts.map((r) => [r.thesisId, r.count]));

  const thesisList: ThesisListItem[] = rows.map((t) => ({
    id: t.id,
    title: t.title,
    claim: t.claim,
    status: t.status,
    highlightCount: hlMap.get(t.id) ?? 0,
    researchCount: resMap.get(t.id) ?? 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));

  return NextResponse.json({ theses: thesisList, total: totalResult?.count ?? 0 });
});

/**
 * POST /api/theses — Create a new thesis, optionally linking highlights.
 * When `highlightIds` is provided, the thesis and its highlight links are
 * created atomically — all-or-nothing via a SQLite transaction.
 * @param req - NextRequest with JSON body matching createThesisSchema
 * @returns Created thesis, 201 status
 */
export const POST = withRoute('POST /api/theses', async (req: NextRequest) => {
  const body = await req.json();
  const data = createThesisSchema.parse(body);

  // Pre-validate highlight IDs outside the transaction so we throw a typed
  // NotFoundError with the missing ID, rather than surfacing a raw SQLite
  // foreign-key failure from the thesis_highlights insert.
  // TOCTOU risk is acceptable in this single-user context.
  if (data.highlightIds && data.highlightIds.length > 0) {
    assertHighlightsExist(data.highlightIds);
  }

  const thesis = rawDb.transaction(() => {
    const inserted = db
      .insert(theses)
      .values({
        title: data.title,
        claim: data.claim,
        counterarguments: data.counterarguments,
        implications: data.implications,
        notes: data.notes,
        status: data.status,
      })
      .returning()
      .get()!;

    if (data.highlightIds && data.highlightIds.length > 0) {
      db.insert(thesisHighlights)
        .values(data.highlightIds.map((hlId) => ({ thesisId: inserted.id, highlightId: hlId })))
        .run();
    }

    return inserted;
  })();

  logger.info(
    {
      event: 'thesis_created',
      thesisId: thesis.id,
      linkedHighlights: data.highlightIds?.length ?? 0,
    },
    'Thesis created',
  );
  return NextResponse.json({ thesis }, { status: 201 });
});
