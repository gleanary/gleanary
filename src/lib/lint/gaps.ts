import { desc, eq, or, sql } from 'drizzle-orm';
import { articles, highlights, theses, thesisHighlights, thesisResearch } from '@/db/schema';
import { callClaude, LINT_GAPS_PROMPT, parseLintGaps } from '@/lib/ai';
import { UTILITY_MODEL } from '@/lib/models';
import { logger } from '@/lib/logger';
import { truncate } from '@/lib/text-utils';
import type { LintContext, Suggestion } from './types';

/** Upper bound on theses analyzed per run — keeps worst-case cost predictable. */
const MAX_THESES = 30;

/** Cap on highlights pulled per thesis — bounds prompt size. */
const MAX_HIGHLIGHTS_PER_THESIS = 40;

/**
 * Gaps lint check — for each thesis in `developing` or `researched` status,
 * ask Haiku to identify one specific gap: missing counterargument, missing
 * research, vague claim, or imbalanced evidence.
 *
 * Sequential per-thesis calls (not a mega-batch) so suggestions stream in
 * progressively and one malformed response doesn't tank the whole check.
 */
export async function* runGaps(ctx: LintContext): AsyncGenerator<Suggestion> {
  const { db } = ctx;

  const candidates = db
    .select({
      id: theses.id,
      title: theses.title,
      claim: theses.claim,
      counterarguments: theses.counterarguments,
      implications: theses.implications,
    })
    .from(theses)
    .where(or(eq(theses.status, 'developing'), eq(theses.status, 'researched')))
    .orderBy(desc(theses.updatedAt))
    .limit(MAX_THESES)
    .all();

  if (candidates.length === 0) {
    yield {
      type: 'gap',
      description:
        'No developing or researched theses to check. Create a thesis first, or develop existing nascent ones.',
      relatedIds: [],
    };
    return;
  }

  for (const thesis of candidates) {
    // Per-thesis window with LIMIT — avoids the unbounded intermediate join
    // a batched `IN (…)` query would produce for a thesis with thousands of
    // linked highlights. Each query is a cheap index lookup.
    // Order by most-recently-linked first so the dossier emphasizes fresh
    // evidence when a thesis has more than MAX_HIGHLIGHTS_PER_THESIS links.
    const links = db
      .select({
        role: thesisHighlights.role,
        highlightText: highlights.text,
        articleTitle: articles.title,
      })
      .from(thesisHighlights)
      .innerJoin(highlights, eq(highlights.id, thesisHighlights.highlightId))
      .innerJoin(articles, eq(articles.id, highlights.articleId))
      .where(eq(thesisHighlights.thesisId, thesis.id))
      .orderBy(sql`${thesisHighlights.addedAt} DESC`)
      .limit(MAX_HIGHLIGHTS_PER_THESIS)
      .all();

    const research = db
      .select({ title: thesisResearch.title })
      .from(thesisResearch)
      .where(eq(thesisResearch.thesisId, thesis.id))
      .all()
      .map((r) => r.title);

    const byRole: Record<'supporting' | 'opposing' | 'context', typeof links> = {
      supporting: [],
      opposing: [],
      context: [],
    };
    for (const link of links) byRole[link.role].push(link);

    const userMessage = buildThesisDossier(thesis, byRole, research);

    let response: string;
    try {
      response = await callClaude(
        LINT_GAPS_PROMPT,
        userMessage,
        { feature: 'lint_gaps' },
        UTILITY_MODEL,
        512,
      );
    } catch (err) {
      logger.warn(
        { err, event: 'lint_gaps_call_failed', thesisId: thesis.id },
        'Haiku gap analysis failed',
      );
      continue;
    }

    const parsed = parseLintGaps(response);
    if (!parsed || !parsed.hasGap || !parsed.description) continue;

    yield {
      type: 'gap',
      description: `${thesis.title}: ${parsed.description}`,
      relatedIds: [{ type: 'thesis', id: thesis.id }],
      suggestedAction: parsed.suggestedAction ?? 'Review thesis',
    };
  }
}

function buildThesisDossier(
  thesis: {
    title: string;
    claim: string | null;
    counterarguments: string | null;
    implications: string | null;
  },
  byRole: Record<
    'supporting' | 'opposing' | 'context',
    Array<{ highlightText: string; articleTitle: string }>
  >,
  research: string[],
): string {
  const parts: string[] = [];
  parts.push(`Title: ${thesis.title}`);
  if (thesis.claim) parts.push(`Claim: ${thesis.claim}`);
  if (thesis.counterarguments) parts.push(`Counterarguments: ${thesis.counterarguments}`);
  if (thesis.implications) parts.push(`Implications: ${thesis.implications}`);

  parts.push('');
  parts.push(`Supporting highlights (${byRole.supporting.length}):`);
  for (const h of byRole.supporting.slice(0, 15)) {
    parts.push(`  - "${truncate(h.highlightText, 200)}" — ${h.articleTitle}`);
  }
  parts.push('');
  parts.push(`Opposing highlights (${byRole.opposing.length}):`);
  for (const h of byRole.opposing.slice(0, 15)) {
    parts.push(`  - "${truncate(h.highlightText, 200)}" — ${h.articleTitle}`);
  }
  parts.push('');
  parts.push(`Context highlights (${byRole.context.length}):`);
  for (const h of byRole.context.slice(0, 5)) {
    parts.push(`  - "${truncate(h.highlightText, 200)}" — ${h.articleTitle}`);
  }
  parts.push('');
  parts.push(`Research entries (${research.length}):`);
  for (const r of research.slice(0, 10)) {
    parts.push(`  - ${r}`);
  }
  return parts.join('\n');
}
