import { NextRequest, NextResponse } from 'next/server';
import { searchSchema } from '@/lib/validators';
import { escapeFts5Query, applyPrefixStar } from '@/lib/search';
import { withRoute } from '@/lib/api-error-handler';
import {
  searchArticles,
  searchHighlights,
  searchTheses,
  searchDrafts,
  type SearchQueryInput,
} from '@/lib/search-query';
import type { SearchResponse } from '@/types';

const PALETTE_CAP = 5;

const EMPTY_RESPONSE = (q: string): SearchResponse => ({
  query: q,
  results: { articles: [], highlights: [], theses: [], drafts: [] },
  totals: { article: 0, highlight: 0, thesis: 0, draft: 0 },
});

/**
 * GET /api/search — Full-text search across articles, highlights, theses, and drafts.
 * Results are grouped by entity type and ranked within each group by BM25 score.
 * @param req - NextRequest with query params per spec §2
 * @returns SearchResponse with grouped results and per-type totals
 */
export const GET = withRoute('GET /api/search', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const query = searchSchema.parse(params);

  const escaped = escapeFts5Query(query.q);
  if (!escaped.trim()) {
    return NextResponse.json(EMPTY_RESPONSE(query.q));
  }

  const isPalette = query.mode === 'palette';
  const ftsQuery = isPalette ? applyPrefixStar(escaped) : escaped;
  const cap = isPalette ? PALETTE_CAP : query.limit;
  const off = isPalette ? 0 : query.offset;

  const input: SearchQueryInput = {
    ftsQuery,
    isPalette,
    cap,
    off,
    status: query.status,
    sourceId: query.sourceId,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
  };

  const article = query.types.includes('article')
    ? searchArticles(input)
    : { results: [], total: 0 };
  const highlight = query.types.includes('highlight')
    ? searchHighlights(input)
    : { results: [], total: 0 };
  const thesis = query.types.includes('thesis') ? searchTheses(input) : { results: [], total: 0 };
  const draft = query.types.includes('draft') ? searchDrafts(input) : { results: [], total: 0 };

  return NextResponse.json({
    query: query.q,
    results: {
      articles: article.results,
      highlights: highlight.results,
      theses: thesis.results,
      drafts: draft.results,
    },
    totals: {
      article: article.total,
      highlight: highlight.total,
      thesis: thesis.total,
      draft: draft.total,
    },
  } satisfies SearchResponse);
});
