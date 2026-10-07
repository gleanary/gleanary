import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  articles,
  drafts,
  highlights,
  theses,
  thesisHighlights,
  thesisResearch,
} from '@/db/schema';
import { updateDraftSchema, parseIdParam } from '@/lib/validators';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import {
  getDraftOrThrow,
  getThesisOrThrow,
  assertHighlightsBelongToThesis,
  assertResearchBelongToThesis,
} from '@/lib/db-helpers';
import { NotFoundError } from '@/lib/errors';
import type { DraftContextSnapshot, RouteContext } from '@/types';

/**
 * GET /api/drafts/[id] — Full draft with highlights and research resolved from context_snapshot.
 * Items no longer linked to the thesis appear with deleted: true.
 * @param _req - NextRequest (unused)
 * @param context - Route context with draft ID
 * @returns Draft with resolvedHighlights and resolvedResearch arrays
 */
export const GET = withRoute(
  'GET /api/drafts/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const draft = getDraftOrThrow(id);

    const snapshot: DraftContextSnapshot = draft.contextSnapshot
      ? (JSON.parse(draft.contextSnapshot) as DraftContextSnapshot)
      : { highlightIds: [], researchIds: [] };

    // Resolve highlights via thesisHighlights — highlights not in the join count as deleted
    // (unlinked from thesis = removed, treat as deleted for display purposes)
    const linkedHighlights =
      snapshot.highlightIds.length > 0
        ? db
            .select({
              id: highlights.id,
              text: highlights.text,
              note: highlights.note,
              articleTitle: articles.title,
            })
            .from(thesisHighlights)
            .innerJoin(highlights, eq(thesisHighlights.highlightId, highlights.id))
            .innerJoin(articles, eq(highlights.articleId, articles.id))
            .where(
              and(
                eq(thesisHighlights.thesisId, draft.thesisId),
                inArray(thesisHighlights.highlightId, snapshot.highlightIds),
              ),
            )
            .all()
        : [];

    const hlMap = new Map(linkedHighlights.map((h) => [h.id, h]));
    const resolvedHighlights = snapshot.highlightIds.map((hid) => {
      const found = hlMap.get(hid);
      return found
        ? {
            id: hid,
            deleted: false,
            text: found.text,
            note: found.note,
            articleTitle: found.articleTitle,
          }
        : { id: hid, deleted: true, text: '(deleted)', note: null, articleTitle: null };
    });

    // Resolve research entries from thesisResearch
    const linkedResearch =
      snapshot.researchIds.length > 0
        ? db
            .select({
              id: thesisResearch.id,
              title: thesisResearch.title,
              source: thesisResearch.source,
            })
            .from(thesisResearch)
            .where(
              and(
                eq(thesisResearch.thesisId, draft.thesisId),
                inArray(thesisResearch.id, snapshot.researchIds),
              ),
            )
            .all()
        : [];

    const resMap = new Map(linkedResearch.map((r) => [r.id, r]));
    const resolvedResearch = snapshot.researchIds.map((rid) => {
      const found = resMap.get(rid);
      return found
        ? { id: rid, deleted: false, title: found.title, source: found.source }
        : { id: rid, deleted: true, title: '(deleted)', source: null };
    });

    return NextResponse.json({ draft, resolvedHighlights, resolvedResearch });
  },
);

/**
 * PATCH /api/drafts/[id] — Update draft fields.
 * Sets last_edited_at only when content changes.
 * On status transition to 'published', sets published_at and auto-advances thesis to 'used'.
 * On revert to 'draft', published_at is preserved and thesis status is not rolled back.
 * @param req - NextRequest with JSON body matching updateDraftSchema
 * @param context - Route context with draft ID
 * @returns Updated draft
 */
export const PATCH = withRoute(
  'PATCH /api/drafts/[id]',
  async (req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const draft = getDraftOrThrow(id);

    const body = await req.json();
    const data = updateDraftSchema.parse(body);

    if (data.includedHighlightIds) {
      assertHighlightsBelongToThesis(draft.thesisId, data.includedHighlightIds);
    }
    if (data.includedResearchIds) {
      assertResearchBelongToThesis(draft.thesisId, data.includedResearchIds);
    }

    const updates: Record<string, unknown> = {
      updatedAt: sql`(datetime('now'))`,
    };

    if (data.title !== undefined) updates.title = data.title;
    if (data.angle !== undefined) updates.angle = data.angle;
    if (data.model !== undefined) updates.model = data.model;
    if (data.status !== undefined) updates.status = data.status;

    if (data.content !== undefined) {
      updates.content = data.content;
      updates.lastEditedAt = sql`(datetime('now'))`;
    }

    if (data.includedHighlightIds !== undefined || data.includedResearchIds !== undefined) {
      const prevSnapshot: DraftContextSnapshot = draft.contextSnapshot
        ? (JSON.parse(draft.contextSnapshot) as DraftContextSnapshot)
        : { highlightIds: [], researchIds: [] };
      const newSnapshot: DraftContextSnapshot = {
        highlightIds: data.includedHighlightIds ?? prevSnapshot.highlightIds,
        researchIds: data.includedResearchIds ?? prevSnapshot.researchIds,
      };
      updates.contextSnapshot = JSON.stringify(newSnapshot);
    }

    if (data.status === 'published' && draft.status !== 'published') {
      updates.publishedAt = sql`(datetime('now'))`;
      // Auto-advance thesis to 'used' (no rollback on revert — thesis advancement is one-way)
      const thesis = getThesisOrThrow(draft.thesisId);
      if (thesis.status !== 'used') {
        db.update(theses)
          .set({ status: 'used', updatedAt: sql`(datetime('now'))` })
          .where(eq(theses.id, draft.thesisId))
          .run();
        logger.info(
          { event: 'thesis_advanced', thesisId: draft.thesisId, status: 'used' },
          'Thesis advanced to used on draft publish',
        );
      }
    }

    const updated = db.update(drafts).set(updates).where(eq(drafts.id, id)).returning().get()!;

    logger.info({ event: 'draft_updated', draftId: id }, 'Draft updated');
    return NextResponse.json({ draft: updated });
  },
);

/**
 * DELETE /api/drafts/[id] — Hard delete a draft.
 * @param _req - NextRequest (unused)
 * @param context - Route context with draft ID
 * @returns `{ deleted: true }`
 */
export const DELETE = withRoute(
  'DELETE /api/drafts/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);

    const result = db.delete(drafts).where(eq(drafts.id, id)).run();
    if (result.changes === 0) throw new NotFoundError('Draft', id);

    logger.info({ event: 'draft_deleted', draftId: id }, 'Draft deleted');
    return NextResponse.json({ deleted: true });
  },
);
