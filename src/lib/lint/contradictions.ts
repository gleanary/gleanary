import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { articles, highlights } from '@/db/schema';
import {
  callClaude,
  LINT_CONTRADICTIONS_NOTES_PROMPT,
  LINT_CONTRADICTIONS_TENSION_PROMPT,
  parseLintContradictions,
  parseLintTensions,
} from '@/lib/ai';
import { UTILITY_MODEL } from '@/lib/models';
import { logger } from '@/lib/logger';
import { truncate } from '@/lib/text-utils';
import type { LintContext, Suggestion } from './types';

/** Upper bound on annotated highlights sent to Haiku in the notes-contradictions call. */
const MAX_ANNOTATED_HIGHLIGHTS = 60;

/** Upper bound on supporting/opposing pairs sent to Haiku in the tension call. */
const MAX_TENSION_PAIRS = 30;

/**
 * Contradictions lint check — two independent passes:
 *
 *   A. User-note contradictions: highlights the user has annotated where the
 *      notes themselves disagree with each other (Haiku detects).
 *   B. Thesis role tensions: supporting/opposing highlight pairs already
 *      marked by the user — Haiku just explains each tension in one sentence.
 *
 * The two passes answer different questions and are kept separate so prompt
 * quality on each stays sharp.
 */
export async function* runContradictions(ctx: LintContext): AsyncGenerator<Suggestion> {
  const { db } = ctx;

  let emitted = 0;

  // --- Pass A: user-note contradictions ---
  const annotated = db
    .select({
      id: highlights.id,
      text: highlights.text,
      note: highlights.note,
      articleTitle: articles.title,
    })
    .from(highlights)
    .innerJoin(articles, eq(articles.id, highlights.articleId))
    .where(and(isNotNull(highlights.note), ne(highlights.note, '')))
    .orderBy(sql`${highlights.createdAt} DESC`)
    .limit(MAX_ANNOTATED_HIGHLIGHTS)
    .all();

  if (annotated.length >= 2) {
    const body = [
      'Annotated highlights:',
      ...annotated.map(
        (h) =>
          `[${h.id}] highlight: "${truncate(h.text, 180)}" — note: "${truncate(h.note ?? '', 180)}" — from "${h.articleTitle}"`,
      ),
    ].join('\n');

    let response: string;
    try {
      response = await callClaude(
        LINT_CONTRADICTIONS_NOTES_PROMPT,
        body,
        { feature: 'lint_contradictions' },
        UTILITY_MODEL,
        800,
      );
    } catch (err) {
      logger.warn(
        { err, event: 'lint_contradictions_notes_failed' },
        'Haiku notes-contradiction call failed',
      );
      response = '';
    }

    const annotatedIds = new Set(annotated.map((h) => h.id));
    const items = parseLintContradictions(response);
    for (const item of items) {
      const validIds = item.highlightIds.filter((id) => annotatedIds.has(id));
      if (validIds.length < 2) continue;
      yield {
        type: 'contradiction',
        description: item.description,
        relatedIds: validIds.map((id) => ({ type: 'highlight' as const, id })),
        suggestedAction: 'Compare highlights',
      };
      emitted++;
    }
  }

  // --- Pass B: thesis role tensions (supporting vs opposing) ---
  // Self-join thesis_highlights to find same-thesis supporting/opposing pairs.
  // Drizzle's query builder can't express self-joins with aliases cleanly, so
  // we drop to raw SQL through better-sqlite3 here. The query is trivial and
  // all values are static — no injection risk.
  const pairRows = ctx.rawDb
    .prepare(
      `SELECT
         th1.thesis_id       AS thesisId,
         t.title             AS thesisTitle,
         th1.highlight_id    AS supportingId,
         th2.highlight_id    AS opposingId,
         h1.text             AS supportingText,
         h2.text             AS opposingText
       FROM thesis_highlights th1
       INNER JOIN thesis_highlights th2
         ON th1.thesis_id = th2.thesis_id
       INNER JOIN highlights h1 ON h1.id = th1.highlight_id
       INNER JOIN highlights h2 ON h2.id = th2.highlight_id
       INNER JOIN theses     t  ON t.id = th1.thesis_id
       WHERE th1.role = 'supporting' AND th2.role = 'opposing'
       ORDER BY t.updated_at DESC, th1.id DESC
       LIMIT ?`,
    )
    .all(MAX_TENSION_PAIRS) as Array<{
    thesisId: number;
    thesisTitle: string;
    supportingId: number;
    opposingId: number;
    supportingText: string;
    opposingText: string;
  }>;

  if (pairRows.length > 0) {
    const body = [
      'Supporting/opposing highlight pairs:',
      ...pairRows.map(
        (p, i) =>
          `[${i}] thesis "${p.thesisTitle}" — supporting: "${truncate(p.supportingText, 180)}" vs opposing: "${truncate(p.opposingText, 180)}"`,
      ),
    ].join('\n');

    let response: string;
    try {
      response = await callClaude(
        LINT_CONTRADICTIONS_TENSION_PROMPT,
        body,
        { feature: 'lint_contradictions' },
        UTILITY_MODEL,
        800,
      );
    } catch (err) {
      logger.warn(
        { err, event: 'lint_contradictions_tension_failed' },
        'Haiku tension explanation call failed',
      );
      response = '';
    }

    const tensions = parseLintTensions(response);
    for (const t of tensions) {
      const pair = pairRows[t.pairIndex];
      if (!pair) continue;
      yield {
        type: 'contradiction',
        description: `"${pair.thesisTitle}": ${t.description}`,
        relatedIds: [
          { type: 'highlight', id: pair.supportingId },
          { type: 'highlight', id: pair.opposingId },
          { type: 'thesis', id: pair.thesisId },
        ],
      };
      emitted++;
    }
  }

  if (emitted === 0) {
    yield {
      type: 'contradiction',
      description:
        'No contradictions found. Your notes are consistent and no thesis has both supporting and opposing highlights.',
      relatedIds: [],
    };
  }
}
