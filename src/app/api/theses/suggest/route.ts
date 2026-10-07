import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { theses, thesisHighlights, highlights, articles } from '@/db/schema';
import { suggestThesesSchema } from '@/lib/validators';
import { callClaude, THESIS_SUGGEST_PROMPT, parseThesisSuggestions } from '@/lib/ai';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';

/** Maximum unlinked highlights to send to AI */
const MAX_UNLINKED = 50;

/**
 * POST /api/theses/suggest — AI suggests new theses from unlinked highlights.
 * Fetches up to 50 recent unlinked highlights and asks Claude to propose arguable theses.
 * @param req - NextRequest with optional { limit: number }
 * @returns Array of thesis suggestions
 */
export const POST = withRoute('POST /api/theses/suggest', async (req: NextRequest) => {
  const body = await req.json();
  const { limit, strategy } = suggestThesesSchema.parse(body);

  // Find highlights not linked to any thesis
  const linkedIds = db.select({ highlightId: thesisHighlights.highlightId }).from(thesisHighlights);

  const baseSelect = db
    .select({
      id: highlights.id,
      text: highlights.text,
      note: highlights.note,
      articleTitle: articles.title,
      articleSiteName: articles.siteName,
    })
    .from(highlights)
    .innerJoin(articles, sql`${highlights.articleId} = ${articles.id}`)
    .where(sql`${highlights.id} NOT IN (${linkedIds})`);

  let unlinkedHighlights;
  if (strategy === 'recent') {
    unlinkedHighlights = baseSelect
      .orderBy(sql`${highlights.createdAt} DESC`)
      .limit(MAX_UNLINKED)
      .all();
  } else if (strategy === 'random') {
    unlinkedHighlights = baseSelect
      .orderBy(sql`RANDOM()`)
      .limit(MAX_UNLINKED)
      .all();
  } else {
    // diverse: 25 most recent + 25 random, deduplicated
    const half = MAX_UNLINKED / 2;
    const recent = baseSelect
      .orderBy(sql`${highlights.createdAt} DESC`)
      .limit(half)
      .all();
    const recentIds = new Set(recent.map((h) => h.id));
    const random = baseSelect
      .orderBy(sql`RANDOM()`)
      .limit(half * 2)
      .all();
    const randomFill = random.filter((h) => !recentIds.has(h.id)).slice(0, half);
    unlinkedHighlights = [...recent, ...randomFill];
  }

  if (unlinkedHighlights.length === 0) {
    return NextResponse.json({ suggestions: [] });
  }

  // Existing thesis titles to avoid duplicates
  const existingTheses = db.select({ title: theses.title }).from(theses).all();

  const highlightList = unlinkedHighlights
    .map(
      (h) =>
        `[ID:${h.id}] "${h.text}"${h.note ? ` (note: ${h.note})` : ''} — from: ${h.articleTitle}${h.articleSiteName ? ` (${h.articleSiteName})` : ''}`,
    )
    .join('\n');

  const existingList =
    existingTheses.length > 0
      ? `\n\nExisting theses (avoid duplicates):\n${existingTheses.map((t) => `- ${t.title}`).join('\n')}`
      : '';

  const userMessage = `Highlights:\n${highlightList}${existingList}\n\nSuggest ${limit} theses.`;

  let response = await callClaude(THESIS_SUGGEST_PROMPT, userMessage, {
    feature: 'thesis_suggest',
  });
  let suggestions = parseThesisSuggestions(response);

  // If parsing returned nothing but the response was non-empty, the JSON was likely
  // truncated. Retry once with half the suggestions to reduce output size.
  if (suggestions.length === 0 && response.length > 0) {
    const retryLimit = Math.max(1, Math.ceil(limit / 2));
    const retryMessage = `Highlights:\n${highlightList}${existingList}\n\nSuggest ${retryLimit} theses.`;
    response = await callClaude(THESIS_SUGGEST_PROMPT, retryMessage, {
      feature: 'thesis_suggest',
    });
    suggestions = parseThesisSuggestions(response);
  }

  logger.info(
    { event: 'thesis_suggestions_generated', count: suggestions.length },
    'Thesis suggestions generated',
  );
  return NextResponse.json({ suggestions });
});
