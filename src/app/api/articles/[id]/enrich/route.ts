import { NextRequest, NextResponse } from 'next/server';
import { enrichArticleSchema, parseIdParam, readOptionalJsonBody } from '@/lib/validators';
import { withRoute } from '@/lib/api-error-handler';
import { enrichArticle } from '@/lib/enrichment';
import type { EnrichArticleResponse, RouteContext } from '@/types';

/**
 * POST /api/articles/[id]/enrich — Enrich one article now (summary, tags and concept index in
 * one Claude call). A `done` article returns its stored fields with `cached: true` unless
 * `force` is set. An empty or whitespace-only body means `{}`.
 * See docs/modules/article-enrichment.md §5.
 * @param req - NextRequest with optional JSON body { force?: boolean }
 * @param context - Route context with id param
 * @returns The enriched article view and the cached flag
 */
export const POST = withRoute(
  'POST /api/articles/[id]/enrich',
  async (req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const { force } = enrichArticleSchema.parse(await readOptionalJsonBody(req));

    const result = await enrichArticle(id, { force: force ?? false, manual: true });
    return NextResponse.json<EnrichArticleResponse>(result);
  },
);
