import { NextRequest, NextResponse } from 'next/server';
import { desc, eq, inArray, sql, max, count } from 'drizzle-orm';
import { db, rawDb } from '@/db';
import { chatSessions, chatMessages } from '@/db/schema';
import { createChatSchema, listChatSessionsSchema } from '@/lib/validators';
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
import { sseEvent, SSE_HEADERS } from '@/lib/sse';
import { emitUsageChanged } from '@/lib/usage-events';
import type { ChatSessionListItem } from '@/types';

/**
 * GET /api/chat — List chat sessions with message counts and last message timestamp.
 * @param req - NextRequest with optional query params: limit, offset
 * @returns Paginated list of chat sessions
 */
export const GET = withRoute('GET /api/chat', async (req: NextRequest) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const query = listChatSessionsSchema.parse(params);

  const rows = db
    .select()
    .from(chatSessions)
    .orderBy(desc(chatSessions.updatedAt))
    .limit(query.limit)
    .offset(query.offset)
    .all();

  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(chatSessions)
    .get();

  const ids = rows.map((s) => s.id);

  const msgStats = ids.length
    ? db
        .select({
          sessionId: chatMessages.sessionId,
          count: count(),
          lastAt: max(chatMessages.createdAt),
        })
        .from(chatMessages)
        .where(inArray(chatMessages.sessionId, ids))
        .groupBy(chatMessages.sessionId)
        .all()
    : [];

  const statsMap = new Map(msgStats.map((r) => [r.sessionId, r]));

  const sessions: ChatSessionListItem[] = rows.map((s) => {
    const stats = statsMap.get(s.id);
    return {
      id: s.id,
      title: s.title,
      scope: s.scope,
      model: s.model,
      messageCount: stats?.count ?? 0,
      lastMessageAt: stats?.lastAt ?? null,
      createdAt: s.createdAt,
    };
  });

  return NextResponse.json({ sessions, total: totalResult?.count ?? 0 });
});

/**
 * POST /api/chat — Create a new chat session and send the first message.
 * Returns an SSE stream with the assistant's response.
 * @param req - NextRequest with JSON body matching createChatSchema
 * @returns SSE stream with session, delta, done, and title events
 */
export async function POST(req: NextRequest) {
  let body: { message: string; scope: string; model: string };
  try {
    const raw = await req.json();
    body = createChatSchema.parse(raw);
  } catch (error) {
    return handleApiError(error, 'POST /api/chat');
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 1. Create session
        const session = db
          .insert(chatSessions)
          .values({ scope: body.scope, model: body.model })
          .returning()
          .get()!;

        controller.enqueue(
          sseEvent('session', {
            id: session.id,
            title: session.title,
            scope: session.scope,
            model: session.model,
          }),
        );

        // 2. Insert user message
        db.insert(chatMessages)
          .values({ sessionId: session.id, role: 'user', content: body.message })
          .run();

        // 3. Retrieve context
        const scope = parseScope(body.scope);
        const keywords = await extractKeywords(body.message, session.id);
        const { historyBudgetChars, maxResponseTokens } = getModelBudget(body.model);
        const context = retrieveContext(scope, keywords, rawDb, body.model);

        // 4. Build prompt
        const systemPrompt = CHAT_SYSTEM_PROMPT + formatContextForPrompt(context);
        const history = buildConversationHistory(
          [{ role: 'user', content: body.message }],
          historyBudgetChars,
        );

        // 5. Stream response
        const result = await callClaudeStreaming({
          system: systemPrompt,
          messages: history,
          model: body.model,
          maxTokens: maxResponseTokens,
          ctx: { feature: 'chat', resourceType: 'chat_session', resourceId: session.id },
          onText(delta) {
            controller.enqueue(sseEvent('delta', { content: delta }));
          },
        });

        // 6. Parse citations and save assistant message
        const citations = parseCitations(result.text, rawDb);
        const assistantMsg = db
          .insert(chatMessages)
          .values({
            sessionId: session.id,
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

        // 7. Auto-generate title (non-blocking, but stream stays open for the title event)
        try {
          const titleInput = `User: ${body.message.slice(0, 200)}\nAssistant: ${result.text.slice(0, 200)}`;
          const title = await callClaude(
            'Given this conversation, write a 3-8 word title. Return ONLY the title, no quotes or punctuation.',
            titleInput,
            {
              feature: 'chat_title_generation',
              resourceType: 'chat_session',
              resourceId: session.id,
            },
            UTILITY_MODEL,
          );
          const cleanTitle = title
            .trim()
            .replace(/^["']|["']$/g, '')
            .slice(0, 200);
          if (cleanTitle) {
            db.update(chatSessions)
              .set({ title: cleanTitle, updatedAt: sql`(datetime('now'))` })
              .where(eq(chatSessions.id, session.id))
              .run();
            controller.enqueue(sseEvent('title', { title: cleanTitle }));
          }
        } catch (err) {
          logger.warn(
            { err, event: 'chat_title_failed', sessionId: session.id },
            'Auto-title generation failed',
          );
        }

        emitUsageChanged();
        logger.info(
          {
            event: 'chat_session_created',
            sessionId: session.id,
            contextTokens: result.usage.inputTokens,
          },
          'Chat session created',
        );
      } catch (err) {
        logger.error({ err, event: 'chat_stream_error' }, 'Chat stream failed');
        controller.enqueue(
          sseEvent('error', { error: err instanceof Error ? err.message : 'Unknown error' }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: SSE_HEADERS,
  });
}
