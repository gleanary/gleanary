import { NextRequest, NextResponse } from 'next/server';
import { eq, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { thesisHighlights, highlights, articles } from '@/db/schema';
import { suggestHighlightsSchema, parseIdParam } from '@/lib/validators';
import { callClaude, HIGHLIGHT_SUGGEST_PROMPT, parseHighlightSuggestions } from '@/lib/ai';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getThesisOrThrow } from '@/lib/db-helpers';
import type { RouteContext } from '@/types';

/** Maximum candidate highlights to send to AI */
const MAX_CANDIDATES = 100;

/**
 * POST /api/theses/[id]/suggest-highlights — AI suggests highlights relevant to a thesis.
 * Fetches highlights not already linked to this thesis and asks Claude to rank them.
 * @param req - NextRequest with optional { limit: number }
 * @param context - Route context with thesis ID
 * @returns Array of highlight suggestions with suggested roles
 */
export const POST = withRoute(
  'POST /api/theses/[id]/suggest-highlights',
  async (req: NextRequest, context: RouteContext) => {
    const thesisId = await parseIdParam(context);
    const thesis = getThesisOrThrow(thesisId);

    const body = await req.json();
    const { limit } = suggestHighlightsSchema.parse(body);

    // Get already-linked highlight IDs
    const linkedIds = db
      .select({ highlightId: thesisHighlights.highlightId })
      .from(thesisHighlights)
      .where(eq(thesisHighlights.thesisId, thesisId))
      .all()
      .map((r) => r.highlightId);

    // Candidate highlights (not already linked)
    const candidateQuery = db
      .select({
        id: highlights.id,
        text: highlights.text,
        note: highlights.note,
        articleTitle: articles.title,
        articleSiteName: articles.siteName,
      })
      .from(highlights)
      .innerJoin(articles, eq(highlights.articleId, articles.id))
      .orderBy(sql`${highlights.createdAt} DESC`)
      .limit(MAX_CANDIDATES);

    const candidates =
      linkedIds.length > 0
        ? candidateQuery.where(notInArray(highlights.id, linkedIds)).all()
        : candidateQuery.all();

    if (candidates.length === 0) {
      return NextResponse.json({ suggestions: [] });
    }

    const thesisContext = [
      `Title: ${thesis.title}`,
      thesis.claim ? `Claim: ${thesis.claim}` : null,
      thesis.counterarguments ? `Counterarguments: ${thesis.counterarguments}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const highlightList = candidates
      .map(
        (h) =>
          `[ID:${h.id}] "${h.text}"${h.note ? ` (note: ${h.note})` : ''} — from: ${h.articleTitle}`,
      )
      .join('\n');

    const userMessage = `Thesis:\n${thesisContext}\n\nCandidate highlights (suggest up to ${limit}):\n${highlightList}`;

    const response = await callClaude(HIGHLIGHT_SUGGEST_PROMPT, userMessage, {
      feature: 'highlight_suggest',
      resourceType: 'thesis',
      resourceId: thesisId,
    });
    const allSuggestions = parseHighlightSuggestions(response);
    const suggestions = allSuggestions.slice(0, limit);

    // Enrich suggestions with highlight text for the UI
    const highlightMap = new Map(candidates.map((h) => [h.id, h]));
    const enriched = suggestions.map((s) => {
      const h = highlightMap.get(s.highlightId);
      return {
        ...s,
        text: h?.text ?? '',
        articleTitle: h?.articleTitle ?? '',
      };
    });

    logger.info(
      { event: 'highlight_suggestions_generated', thesisId, count: enriched.length },
      'Highlight suggestions generated',
    );
    return NextResponse.json({ suggestions: enriched });
  },
);
