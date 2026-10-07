import 'server-only';
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  articles,
  drafts,
  highlights,
  sources,
  theses,
  thesisHighlights,
  thesisResearch,
  chatSessions,
} from '@/db/schema';
import { NotFoundError, ValidationError } from '@/lib/errors';
import type {
  SourceType,
  ThesisDetailResponse,
  ThesisHighlightRole,
  ThesisResearchSource,
  ChatMessage,
  ChatMessageDisplay,
  ChatCitation,
} from '@/types';

/**
 * Fetches an article by ID or throws NotFoundError.
 * @param id - Article ID
 * @returns The full article row
 * @throws NotFoundError if the article does not exist
 */
export function getArticleOrThrow(id: number) {
  const article = db.select().from(articles).where(eq(articles.id, id)).get();
  if (!article) {
    throw new NotFoundError('Article', id);
  }
  return article;
}

/**
 * Fetches a highlight by ID or throws NotFoundError.
 * @param id - Highlight ID
 * @returns The full highlight row
 * @throws NotFoundError if the highlight does not exist
 */
export function getHighlightOrThrow(id: number) {
  const highlight = db.select().from(highlights).where(eq(highlights.id, id)).get();
  if (!highlight) {
    throw new NotFoundError('Highlight', id);
  }
  return highlight;
}

/**
 * Verifies that every ID in the list corresponds to an existing highlight.
 * Throws NotFoundError pointing at the first missing ID. No-op for an empty list.
 * @param ids - Highlight IDs to verify
 * @throws NotFoundError if any ID does not exist
 */
export function assertHighlightsExist(ids: number[]): void {
  if (ids.length === 0) return;
  const count =
    db
      .select({ count: sql<number>`count(*)` })
      .from(highlights)
      .where(inArray(highlights.id, ids))
      .get()?.count ?? 0;
  if (count !== ids.length) {
    // Find the first missing ID to return in the error
    const existing = db
      .select({ id: highlights.id })
      .from(highlights)
      .where(inArray(highlights.id, ids))
      .all();
    const existingIds = new Set(existing.map((h) => h.id));
    const missing = ids.find((id) => !existingIds.has(id));
    throw new NotFoundError('Highlight', missing!);
  }
}

/**
 * Fetches a source by ID or throws NotFoundError.
 * @param id - Source ID
 * @returns The full source row
 * @throws NotFoundError if the source does not exist
 */
export function getSourceOrThrow(id: number) {
  const source = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!source) {
    throw new NotFoundError('Source', id);
  }
  return source;
}

/**
 * Fetches a thesis by ID or throws NotFoundError.
 * @param id - Thesis ID
 * @returns The full thesis row
 * @throws NotFoundError if the thesis does not exist
 */
export function getThesisOrThrow(id: number) {
  const thesis = db.select().from(theses).where(eq(theses.id, id)).get();
  if (!thesis) {
    throw new NotFoundError('Thesis', id);
  }
  return thesis;
}

/**
 * Fetches full thesis detail (thesis + linked highlights + research summaries), or null if not found.
 * Shared between the page server component and the API GET route.
 * @param id - Thesis ID
 * @returns ThesisDetailResponse, or null if the thesis does not exist
 */
export function getThesisDetail(id: number): ThesisDetailResponse | null {
  const thesis = db.select().from(theses).where(eq(theses.id, id)).get();
  if (!thesis) return null;

  const linkedHighlights = db
    .select({
      id: highlights.id,
      text: highlights.text,
      note: highlights.note,
      role: thesisHighlights.role,
      linkNote: thesisHighlights.note,
      articleId: articles.id,
      articleTitle: articles.title,
      articleSiteName: articles.siteName,
    })
    .from(thesisHighlights)
    .innerJoin(highlights, eq(thesisHighlights.highlightId, highlights.id))
    .innerJoin(articles, eq(highlights.articleId, articles.id))
    .where(eq(thesisHighlights.thesisId, id))
    .all();

  const researchRows = db
    .select({
      id: thesisResearch.id,
      title: thesisResearch.title,
      source: thesisResearch.source,
      createdAt: thesisResearch.createdAt,
      wordCount: sql<number>`length(${thesisResearch.content}) - length(replace(${thesisResearch.content}, ' ', '')) + 1`,
    })
    .from(thesisResearch)
    .where(eq(thesisResearch.thesisId, id))
    .all();

  return {
    thesis,
    highlights: linkedHighlights.map((h) => ({
      id: h.id,
      text: h.text,
      note: h.note,
      role: h.role as ThesisHighlightRole,
      linkNote: h.linkNote,
      article: { id: h.articleId, title: h.articleTitle, siteName: h.articleSiteName },
    })),
    research: researchRows.map((r) => ({
      ...r,
      source: r.source as ThesisResearchSource | null,
    })),
  };
}

/**
 * Fetches a chat session by ID or throws NotFoundError.
 * @param id - Chat session ID
 * @returns The full chat session row
 * @throws NotFoundError if the session does not exist
 */
export function getChatSessionOrThrow(id: number) {
  const session = db.select().from(chatSessions).where(eq(chatSessions.id, id)).get();
  if (!session) {
    throw new NotFoundError('Chat session', id);
  }
  return session;
}

/**
 * Fetches a draft by ID or throws NotFoundError.
 * @param id - Draft ID
 * @returns The full draft row
 * @throws NotFoundError if the draft does not exist
 */
export function getDraftOrThrow(id: number) {
  const draft = db.select().from(drafts).where(eq(drafts.id, id)).get();
  if (!draft) throw new NotFoundError('Draft', id);
  return draft;
}

const DRAFT_SUMMARY_PROJECTION = {
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
};

/**
 * Fetches all draft summaries ordered by updatedAt desc, or filters to one thesis
 * when thesisId is provided (ordered by createdAt desc for the thesis view).
 * Excludes the large `content` field.
 * @param thesisId - When provided, limits results to that thesis
 * @returns Array of draft summaries
 */
export function getDraftSummaries(thesisId?: number) {
  const base = db
    .select(DRAFT_SUMMARY_PROJECTION)
    .from(drafts)
    .innerJoin(theses, eq(drafts.thesisId, theses.id));

  if (thesisId !== undefined) {
    return base.where(eq(drafts.thesisId, thesisId)).orderBy(desc(drafts.createdAt)).all();
  }
  return base.orderBy(desc(drafts.updatedAt)).all();
}

/**
 * Fetches draft summaries for a given thesis, ordered by createdAt desc.
 * @param thesisId - The thesis whose drafts to list
 * @returns Array of draft summaries (newest first)
 */
export function getDraftsForThesis(thesisId: number) {
  return getDraftSummaries(thesisId);
}

/**
 * Verifies that every highlight ID is linked to the given thesis via thesis_highlights.
 * Throws ValidationError on the first ID not found in the join table.
 * @param thesisId - The thesis to check membership against
 * @param ids - Highlight IDs to verify
 * @throws ValidationError if any ID is not linked to the thesis
 */
export function assertHighlightsBelongToThesis(thesisId: number, ids: number[]): void {
  if (ids.length === 0) return;
  const linked = db
    .select({ highlightId: thesisHighlights.highlightId })
    .from(thesisHighlights)
    .where(and(eq(thesisHighlights.thesisId, thesisId), inArray(thesisHighlights.highlightId, ids)))
    .all();
  if (linked.length !== ids.length) {
    const linkedSet = new Set(linked.map((r) => r.highlightId));
    const missing = ids.find((id) => !linkedSet.has(id));
    throw new ValidationError(`Highlight ${missing} does not belong to thesis ${thesisId}`);
  }
}

/**
 * Verifies that every research ID belongs to the given thesis via thesis_research.
 * Throws ValidationError on the first ID not found.
 * @param thesisId - The thesis to check membership against
 * @param ids - Research IDs to verify
 * @throws ValidationError if any ID is not linked to the thesis
 */
export function assertResearchBelongToThesis(thesisId: number, ids: number[]): void {
  if (ids.length === 0) return;
  const linked = db
    .select({ id: thesisResearch.id })
    .from(thesisResearch)
    .where(and(eq(thesisResearch.thesisId, thesisId), inArray(thesisResearch.id, ids)))
    .all();
  if (linked.length !== ids.length) {
    const linkedSet = new Set(linked.map((r) => r.id));
    const missing = ids.find((id) => !linkedSet.has(id));
    throw new ValidationError(`Research ${missing} does not belong to thesis ${thesisId}`);
  }
}

/**
 * Maps a raw chat message row to a display-ready object with parsed citations.
 * @param m - Raw chat message from DB
 * @returns Display-ready message with parsed citations array
 */
export function toChatMessageDisplay(m: ChatMessage): ChatMessageDisplay {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    citations: m.citations ? (JSON.parse(m.citations) as ChatCitation[]) : [],
    createdAt: m.createdAt,
    bookmarkedAt: m.bookmarkedAt ?? null,
  };
}

/**
 * Auto-advances thesis status when research is added:
 * developing → researched. No-op for other statuses.
 * @param thesisId - Thesis ID to potentially advance
 * @param currentStatus - Current thesis status
 */
export function autoAdvanceThesisOnResearch(thesisId: number, currentStatus: string): void {
  if (currentStatus === 'developing') {
    db.update(theses)
      .set({ status: 'researched', updatedAt: sql`(datetime('now'))` })
      .where(eq(theses.id, thesisId))
      .run();
  }
}

/**
 * Returns a Drizzle condition that filters articles by source type via subquery.
 * @param sourceType - The source type to filter by
 * @returns An `inArray` condition on `articles.sourceId`
 */
export function articlesBySourceType(sourceType: SourceType) {
  const sourceIds = db.select({ id: sources.id }).from(sources).where(eq(sources.type, sourceType));
  return inArray(articles.sourceId, sourceIds);
}

/**
 * Returns a Drizzle condition that excludes articles from a given source type.
 * @param sourceType - The source type to exclude
 * @returns A `notInArray` condition on `articles.sourceId`
 */
export function articlesExcludingSourceType(sourceType: SourceType) {
  const sourceIds = db.select({ id: sources.id }).from(sources).where(eq(sources.type, sourceType));
  return or(notInArray(articles.sourceId, sourceIds), isNull(articles.sourceId))!;
}
