import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';
import { setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { resetClient } from '@/lib/ai';
import { articles, chatSessions, chatMessages, theses, highlights, tags } from '@/db/schema';

// Import route handlers
import { POST as createSession } from '@/app/api/chat/route';
import { POST as fileAction } from '@/app/api/chat/[id]/file/route';

// Mock Claude API responses
setupHandlers(
  http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;

    if (!body.stream) {
      const systemPrompt = typeof body.system === 'string' ? body.system : '';
      if (systemPrompt.includes('search terms')) {
        return HttpResponse.json({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '["testing"]' }],
          model: 'claude-sonnet-4-20250514',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        });
      }
      if (systemPrompt.includes('3-8 word title')) {
        return HttpResponse.json({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Test Chat' }],
          model: 'claude-sonnet-4-20250514',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        });
      }
      return HttpResponse.json({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'A test response.' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 },
      });
    }

    // Streaming response
    const streamBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Test response with [highlight:1] citation."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":20}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    return new HttpResponse(streamBody.join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }),
);

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

function routeContext(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

/** Parse SSE events from a Response stream */
async function parseSSE(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  const events: Array<{ event: string; data: unknown }> = [];
  const lines = text.split('\n');
  let currentEvent = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
      } catch {
        events.push({ event: currentEvent, data: line.slice(6) });
      }
    }
  }
  return events;
}

describe('Chat Filing API', () => {
  let db: ReturnType<typeof dbMock.setup>['db'];
  let sessionId: number;
  let assistantMessageId: number;
  let testHighlightId: number;

  beforeEach(async () => {
    // Set dummy API key before any imports that initialize the Anthropic client
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    db = dbMock.setup().db;
    resetClient();

    // Insert a test article
    const article = db
      .insert(articles)
      .values({
        url: 'https://example.com/test',
        title: 'Test Article',
        contentText: 'Test content about testing patterns.',
        excerpt: 'Testing overview',
      })
      .returning()
      .get()!;

    // Insert a test highlight
    const highlight = db
      .insert(highlights)
      .values({
        articleId: article.id,
        text: 'An important test highlight about patterns',
        note: null,
      })
      .returning()
      .get()!;
    testHighlightId = highlight.id;

    // Create a chat session with a user + assistant message
    const session = db
      .insert(chatSessions)
      .values({ title: 'Test session', scope: 'all' })
      .returning()
      .get()!;
    sessionId = session.id;

    db.insert(chatMessages)
      .values({ sessionId, role: 'user', content: 'Tell me about testing' })
      .run();

    const assistantMsg = db
      .insert(chatMessages)
      .values({
        sessionId,
        role: 'assistant',
        content: `Here is analysis about testing patterns.\n\nThis highlight [highlight:${testHighlightId}] shows patterns.\n\nMore content here.`,
        citations: JSON.stringify([
          { type: 'highlight', id: testHighlightId, title: 'An important test highlight' },
        ]),
      })
      .returning()
      .get()!;
    assistantMessageId = assistantMsg.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('POST /api/chat/[id]/file - create_thesis', () => {
    it('creates a thesis from a chat message', async () => {
      const res = await fileAction(
        jsonReq('POST', `/api/chat/${sessionId}/file`, {
          messageId: assistantMessageId,
          action: {
            type: 'create_thesis',
            title: 'Testing is important',
            claim: 'Good tests prevent bugs',
          },
        }),
        routeContext(sessionId),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.filed).toBe(true);
      expect(body.result.type).toBe('thesis');
      expect(body.result.id).toBeGreaterThan(0);

      // Verify thesis was created
      const created = db.select().from(theses).all();
      expect(created).toHaveLength(1);
      expect(created[0]!.title).toBe('Testing is important');
      expect(created[0]!.claim).toBe('Good tests prevent bugs');
    });

    it('creates a thesis with linked highlights', async () => {
      const res = await fileAction(
        jsonReq('POST', `/api/chat/${sessionId}/file`, {
          messageId: assistantMessageId,
          action: { type: 'create_thesis', title: 'Test thesis', highlightIds: [testHighlightId] },
        }),
        routeContext(sessionId),
      );
      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/chat/[id]/file - add_research', () => {
    it('adds research to an existing thesis', async () => {
      // Create a thesis first
      const thesis = db
        .insert(theses)
        .values({ title: 'Existing thesis', status: 'developing' })
        .returning()
        .get()!;

      const res = await fileAction(
        jsonReq('POST', `/api/chat/${sessionId}/file`, {
          messageId: assistantMessageId,
          action: {
            type: 'add_research',
            thesisId: thesis.id,
            title: 'Chat insight',
            content: 'Analysis from the chat session...',
          },
        }),
        routeContext(sessionId),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.result.type).toBe('research');
    });

    it('returns 404 for nonexistent thesis', async () => {
      const res = await fileAction(
        jsonReq('POST', `/api/chat/${sessionId}/file`, {
          messageId: assistantMessageId,
          action: {
            type: 'add_research',
            thesisId: 999,
            title: 'Test',
            content: 'Content',
          },
        }),
        routeContext(sessionId),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/chat/[id]/file - annotate_highlight', () => {
    it('updates a highlight note', async () => {
      const res = await fileAction(
        jsonReq('POST', `/api/chat/${sessionId}/file`, {
          messageId: assistantMessageId,
          action: {
            type: 'annotate_highlight',
            highlightId: testHighlightId,
            note: 'AI analysis: this highlight reveals key patterns',
          },
        }),
        routeContext(sessionId),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.result.type).toBe('highlight');

      // Verify note was updated
      const updated = db.select().from(highlights).all();
      expect(updated[0]!.note).toBe('AI analysis: this highlight reveals key patterns');
    });

    it('returns 404 for nonexistent highlight', async () => {
      const res = await fileAction(
        jsonReq('POST', `/api/chat/${sessionId}/file`, {
          messageId: assistantMessageId,
          action: {
            type: 'annotate_highlight',
            highlightId: 999,
            note: 'Test note',
          },
        }),
        routeContext(sessionId),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/chat/[id]/file - bookmark', () => {
    it('bookmarks a message', async () => {
      const res = await fileAction(
        jsonReq('POST', `/api/chat/${sessionId}/file`, {
          messageId: assistantMessageId,
          action: { type: 'bookmark' },
        }),
        routeContext(sessionId),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.result.type).toBe('bookmark');

      // Verify bookmarked_at was set
      const msg = db
        .select()
        .from(chatMessages)
        .all()
        .find((m) => m.id === assistantMessageId);
      expect(msg!.bookmarkedAt).toBeTruthy();
    });
  });

  describe('POST /api/chat/[id]/file - validation', () => {
    it('returns 404 for message not in session', async () => {
      // Create another session
      const other = db.insert(chatSessions).values({ title: 'Other' }).returning().get()!;
      const res = await fileAction(
        jsonReq('POST', `/api/chat/${other.id}/file`, {
          messageId: assistantMessageId,
          action: { type: 'bookmark' },
        }),
        routeContext(other.id),
      );
      expect(res.status).toBe(404);
    });

    it('returns 404 for user message (not assistant)', async () => {
      const userMsg = db
        .select()
        .from(chatMessages)
        .all()
        .find((m) => m.role === 'user')!;
      const res = await fileAction(
        jsonReq('POST', `/api/chat/${sessionId}/file`, {
          messageId: userMsg.id,
          action: { type: 'bookmark' },
        }),
        routeContext(sessionId),
      );
      expect(res.status).toBe(404);
    });

    it('returns 422 for invalid action', async () => {
      const res = await fileAction(
        jsonReq('POST', `/api/chat/${sessionId}/file`, {
          messageId: assistantMessageId,
          action: { type: 'invalid_action' },
        }),
        routeContext(sessionId),
      );
      expect(res.status).toBe(422);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await fileAction(
        jsonReq('POST', '/api/chat/999/file', {
          messageId: assistantMessageId,
          action: { type: 'bookmark' },
        }),
        routeContext(999),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('Scope validation', () => {
    it('accepts thesis scope', async () => {
      const thesis = db.insert(theses).values({ title: 'Test thesis' }).returning().get()!;
      const res = await createSession(
        jsonReq('POST', '/api/chat', {
          message: 'Tell me about this thesis',
          scope: `thesis:${thesis.id}`,
        }),
      );
      expect(res.status).toBe(200);
      const events = await parseSSE(res);
      const sessionEvent = events.find((e) => e.event === 'session');
      expect((sessionEvent!.data as { scope: string }).scope).toBe(`thesis:${thesis.id}`);
    });

    it('accepts tag scope', async () => {
      const tag = db.insert(tags).values({ name: 'testing' }).returning().get()!;
      const res = await createSession(
        jsonReq('POST', '/api/chat', {
          message: 'What highlights are tagged testing?',
          scope: `tag:${tag.name}`,
        }),
      );
      expect(res.status).toBe(200);
      const events = await parseSSE(res);
      const sessionEvent = events.find((e) => e.event === 'session');
      expect((sessionEvent!.data as { scope: string }).scope).toBe('tag:testing');
    });

    it('accepts recent scope', async () => {
      const res = await createSession(
        jsonReq('POST', '/api/chat', {
          message: 'What have I been reading?',
          scope: 'recent:7',
        }),
      );
      expect(res.status).toBe(200);
      const events = await parseSSE(res);
      const sessionEvent = events.find((e) => e.event === 'session');
      expect((sessionEvent!.data as { scope: string }).scope).toBe('recent:7');
    });

    it('rejects invalid scope formats', async () => {
      const res = await createSession(
        jsonReq('POST', '/api/chat', {
          message: 'Test',
          scope: 'thesis:abc',
        }),
      );
      expect(res.status).toBe(422);
    });
  });
});
