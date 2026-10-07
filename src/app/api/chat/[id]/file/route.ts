import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { chatMessages, theses, thesisResearch, thesisHighlights, highlights } from '@/db/schema';
import { parseIdParam, chatFileSchema } from '@/lib/validators';
import { withRoute } from '@/lib/api-error-handler';
import {
  getChatSessionOrThrow,
  getThesisOrThrow,
  getHighlightOrThrow,
  assertHighlightsExist,
  autoAdvanceThesisOnResearch,
} from '@/lib/db-helpers';
import { NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { RouteContext } from '@/types';

/**
 * POST /api/chat/[id]/file — File a chat message back into the knowledge base.
 * Supports creating theses, adding research, annotating highlights, and bookmarking.
 * @param req - NextRequest with JSON body matching chatFileSchema
 * @param context - Route context with session ID
 * @returns The filed entity type and ID, 201 status
 */
export const POST = withRoute(
  'POST /api/chat/[id]/file',
  async (req: NextRequest, context: RouteContext) => {
    const sessionId = await parseIdParam(context);
    getChatSessionOrThrow(sessionId);

    const raw = await req.json();
    const { messageId, action } = chatFileSchema.parse(raw);

    // Verify message belongs to this session and is an assistant message
    const message = db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.sessionId, sessionId)))
      .get();

    if (!message || message.role !== 'assistant') {
      throw new NotFoundError('Assistant message', messageId);
    }

    let result: { type: string; id: number };

    switch (action.type) {
      case 'create_thesis': {
        const thesis = db
          .insert(theses)
          .values({
            title: action.title,
            claim: action.claim,
          })
          .returning()
          .get()!;

        // Link highlights if provided — batch verify then insert
        if (action.highlightIds && action.highlightIds.length > 0) {
          assertHighlightsExist(action.highlightIds);
          db.insert(thesisHighlights)
            .values(action.highlightIds.map((hlId) => ({ thesisId: thesis.id, highlightId: hlId })))
            .run();
        }

        result = { type: 'thesis', id: thesis.id };
        logger.info(
          { event: 'chat_filed_thesis', sessionId, messageId, thesisId: thesis.id },
          'Chat message filed as thesis',
        );
        break;
      }

      case 'add_research': {
        const thesis = getThesisOrThrow(action.thesisId);

        const research = db
          .insert(thesisResearch)
          .values({
            thesisId: action.thesisId,
            title: action.title,
            content: action.content,
            source: 'ai_analysis',
          })
          .returning()
          .get()!;

        autoAdvanceThesisOnResearch(action.thesisId, thesis.status);

        result = { type: 'research', id: research.id };
        logger.info(
          {
            event: 'chat_filed_research',
            sessionId,
            messageId,
            thesisId: action.thesisId,
            researchId: research.id,
          },
          'Chat message filed as research',
        );
        break;
      }

      case 'annotate_highlight': {
        getHighlightOrThrow(action.highlightId);

        db.update(highlights)
          .set({ note: action.note, updatedAt: sql`(datetime('now'))` })
          .where(eq(highlights.id, action.highlightId))
          .run();

        result = { type: 'highlight', id: action.highlightId };
        logger.info(
          {
            event: 'chat_filed_annotation',
            sessionId,
            messageId,
            highlightId: action.highlightId,
          },
          'Chat message filed as highlight annotation',
        );
        break;
      }

      case 'bookmark': {
        db.update(chatMessages)
          .set({ bookmarkedAt: sql`(datetime('now'))` })
          .where(eq(chatMessages.id, messageId))
          .run();

        result = { type: 'bookmark', id: messageId };
        logger.info({ event: 'chat_bookmarked', sessionId, messageId }, 'Chat message bookmarked');
        break;
      }
    }

    return NextResponse.json({ filed: true, result }, { status: 201 });
  },
);
