import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db, rawDb } from '@/db';
import { chatSessions, chatMessages } from '@/db/schema';
import { parseIdParam, sendChatMessageSchema, updateChatSessionSchema } from '@/lib/validators';
import { callClaude, callClaudeStreaming } from '@/lib/ai';
import {
  parseScope,
  extractKeywords,
  retrieveContext,
  buildConversationHistory,
  formatContextForPrompt,
  parseCitations,
  CHAT_SYSTEM_PROMPT,
} from '@/lib/chat-retrieval';
import { getModelBudget, UTILITY_MODEL } from '@/lib/models';
import { logger } from '@/lib/logger';
import { handleApiError, withRoute } from '@/lib/api-error-handler';
import { NotFoundError } from '@/lib/errors';
import { sseEvent, SSE_HEADERS } from '@/lib/sse';
import { emitUsageChanged } from '@/lib/usage-events';
import { getChatSessionOrThrow, toChatMessageDisplay } from '@/lib/db-helpers';
import type { RouteContext } from '@/types';

/**
 * GET /api/chat/[id] — Get a chat session with all its messages.
 * @param _req - NextRequest (unused)
 * @param context - Route context with session ID
 * @returns Session detail with messages
 */
export const GET = withRoute(
  'GET /api/chat/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const session = getChatSessionOrThrow(id);

    const messages = db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .orderBy(chatMessages.createdAt)
      .all();

    return NextResponse.json({ session, messages: messages.map(toChatMessageDisplay) });
  },
);

/**
 * POST /api/chat/[id] — Send a message in an existing chat session.
 * Returns an SSE stream with the assistant's response.
 * @param req - NextRequest with JSON body matching sendChatMessageSchema
 * @param context - Route context with session ID
 * @returns SSE stream with delta, done, and optionally title events
 */
export async function POST(req: NextRequest, context: RouteContext) {
  let id: number;
  let body: { message: string };
  try {
    id = await parseIdParam(context);
    const raw = await req.json();
    body = sendChatMessageSchema.parse(raw);
  } catch (error) {
    return handleApiError(error, 'POST /api/chat/[id]');
  }

  // Validate session exists before starting stream
  let session;
  try {
    session = getChatSessionOrThrow(id);
  } catch (error) {
    return handleApiError(error, 'POST /api/chat/[id]');
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 1. Insert user message
        db.insert(chatMessages)
          .values({ sessionId: id, role: 'user', content: body.message })
          .run();

        // 2. Update session timestamp
        db.update(chatSessions)
          .set({ updatedAt: sql`(datetime('now'))` })
          .where(eq(chatSessions.id, id))
          .run();

        // 3. Retrieve context
        const scope = parseScope(session.scope);
        const keywords = await extractKeywords(body.message, id);
        const { historyBudgetChars, maxResponseTokens } = getModelBudget(session.model);
        const context = retrieveContext(scope, keywords, rawDb, session.model);

        // 4. Build conversation history from all session messages
        const allMessages = db
          .select({ role: chatMessages.role, content: chatMessages.content })
          .from(chatMessages)
          .where(eq(chatMessages.sessionId, id))
          .orderBy(chatMessages.createdAt)
          .all();

        const history = buildConversationHistory(allMessages, historyBudgetChars);

        // 5. Build prompt and stream
        const systemPrompt = CHAT_SYSTEM_PROMPT + formatContextForPrompt(context);

        const result = await callClaudeStreaming({
          system: systemPrompt,
          messages: history,
          model: session.model,
          maxTokens: maxResponseTokens,
          ctx: { feature: 'chat', resourceType: 'chat_session', resourceId: id },
          onText(delta) {
            controller.enqueue(sseEvent('delta', { content: delta }));
          },
        });

        // 6. Parse citations and save assistant message
        const citations = parseCitations(result.text, rawDb);
        const assistantMsg = db
          .insert(chatMessages)
          .values({
            sessionId: id,
            role: 'assistant',
            content: result.text,
            citations: citations.length > 0 ? JSON.stringify(citations) : null,
            contextTokens: result.usage.inputTokens,
          })
          .returning()
          .get()!;

        controller.enqueue(
          sseEvent('done', { messageId: assistantMsg.id, contextTokens: result.usage.inputTokens }),
        );

        // 7. Auto-title if still "New chat" (first exchange)
        if (session.title === 'New chat') {
          try {
            const firstUserMsg = allMessages.find((m) => m.role === 'user');
            const titleInput = `User: ${(firstUserMsg?.content ?? body.message).slice(0, 200)}\nAssistant: ${result.text.slice(0, 200)}`;
            const title = await callClaude(
              'Given this conversation, write a 3-8 word title. Return ONLY the title, no quotes or punctuation.',
              titleInput,
              { feature: 'chat_title_generation', resourceType: 'chat_session', resourceId: id },
              UTILITY_MODEL,
            );
            const cleanTitle = title
              .trim()
              .replace(/^["']|["']$/g, '')
              .slice(0, 200);
            if (cleanTitle) {
              db.update(chatSessions)
                .set({ title: cleanTitle, updatedAt: sql`(datetime('now'))` })
                .where(eq(chatSessions.id, id))
                .run();
              controller.enqueue(sseEvent('title', { title: cleanTitle }));
            }
          } catch (err) {
            logger.warn(
              { err, event: 'chat_title_failed', sessionId: id },
              'Auto-title generation failed',
            );
          }
        }

        emitUsageChanged();
        logger.info(
          { event: 'chat_message_sent', sessionId: id, contextTokens: result.usage.inputTokens },
          'Chat message processed',
        );
      } catch (err) {
        logger.error({ err, event: 'chat_stream_error', sessionId: id }, 'Chat stream failed');
        controller.enqueue(
          sseEvent('error', { error: err instanceof Error ? err.message : 'Unknown error' }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * PATCH /api/chat/[id] — Update a chat session's title or scope.
 * @param req - NextRequest with JSON body matching updateChatSessionSchema
 * @param context - Route context with session ID
 * @returns Updated session
 */
export const PATCH = withRoute(
  'PATCH /api/chat/[id]',
  async (req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    getChatSessionOrThrow(id);

    const body = await req.json();
    const data = updateChatSessionSchema.parse(body);

    const updated = db
      .update(chatSessions)
      .set({ ...data, updatedAt: sql`(datetime('now'))` })
      .where(eq(chatSessions.id, id))
      .returning()
      .get()!;

    logger.info({ event: 'chat_session_updated', sessionId: id }, 'Chat session updated');
    return NextResponse.json({ session: updated });
  },
);

/**
 * DELETE /api/chat/[id] — Delete a chat session and all its messages.
 * @param _req - NextRequest (unused)
 * @param context - Route context with session ID
 * @returns 204 No Content
 */
export const DELETE = withRoute(
  'DELETE /api/chat/[id]',
  async (_req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);

    const result = db.delete(chatSessions).where(eq(chatSessions.id, id)).run();
    if (result.changes === 0) throw new NotFoundError('Chat session', id);

    logger.info({ event: 'chat_session_deleted', sessionId: id }, 'Chat session deleted');
    return new NextResponse(null, { status: 204 });
  },
);
