import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';
import { setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { resetClient } from '@/lib/ai';
import { articles } from '@/db/schema';

// Import route handlers
import { GET as listSessions, POST as createSession } from '@/app/api/chat/route';
import {
  GET as getSession,
  POST as sendMessage,
  PATCH as updateSession,
  DELETE as deleteSession,
} from '@/app/api/chat/[id]/route';

// Mock Claude API responses
const defaultResponse = {
  id: 'msg_mock',
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'text', text: 'This is a response about [article:1] discussing testing patterns.' },
  ],
  model: 'claude-sonnet-4-20250514',
  stop_reason: 'end_turn',
  usage: { input_tokens: 500, output_tokens: 50 },
};

// For streaming, the Anthropic SDK uses the messages endpoint with stream parameter
setupHandlers(
  http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;

    // Keyword extraction calls are non-streaming
    if (!body.stream) {
      // Check if this is a keyword extraction call
      const systemPrompt = typeof body.system === 'string' ? body.system : '';
      if (systemPrompt.includes('search terms')) {
        return HttpResponse.json({
          ...defaultResponse,
          content: [{ type: 'text', text: '["testing", "patterns", "web", "applications"]' }],
        });
      }
      // Title generation call
      if (systemPrompt.includes('3-8 word title')) {
        return HttpResponse.json({
          ...defaultResponse,
          content: [{ type: 'text', text: 'Testing Patterns Discussion' }],
        });
      }
      return HttpResponse.json(defaultResponse);
    }

    // Streaming response for chat
    const streamBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":500,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"This is a response about "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"[article:1] discussing testing."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":50}}\n\n',
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

describe('Chat API', () => {
  let testArticleId: number;

  beforeEach(() => {
    // Set dummy API key before any imports that initialize the Anthropic client
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    const { db } = dbMock.setup();
    resetClient();

    // Insert a test article for retrieval
    const result = db
      .insert(articles)
      .values({
        url: 'https://example.com/test',
        title: 'Test Article About Testing Patterns',
        contentText: 'This article covers unit testing and integration testing patterns.',
        excerpt: 'Testing patterns overview',
        aiIndex:
          'TOPICS: testing, unit tests, integration tests\nENTITIES: vitest, jest\nRELATED CONCEPTS: TDD, BDD',
      })
      .returning()
      .get()!;
    testArticleId = result.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('GET /api/chat (list sessions)', () => {
    it('returns empty list initially', async () => {
      const res = await listSessions(jsonReq('GET', '/api/chat'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  describe('POST /api/chat (create session)', () => {
    it('creates a session and streams a response', async () => {
      const res = await createSession(
        jsonReq('POST', '/api/chat', { message: 'What articles discuss testing patterns?' }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');

      const events = await parseSSE(res);

      // Should have session, delta(s), done, and title events
      const sessionEvent = events.find((e) => e.event === 'session');
      expect(sessionEvent).toBeDefined();
      const sessionData = sessionEvent!.data as { id: number; scope: string };
      expect(sessionData.id).toBeGreaterThan(0);
      expect(sessionData.scope).toBe('all');

      const deltaEvents = events.filter((e) => e.event === 'delta');
      expect(deltaEvents.length).toBeGreaterThan(0);

      const doneEvent = events.find((e) => e.event === 'done');
      expect(doneEvent).toBeDefined();
      expect((doneEvent!.data as { messageId: number }).messageId).toBeGreaterThan(0);
    });

    it('returns 422 for empty message', async () => {
      const res = await createSession(jsonReq('POST', '/api/chat', { message: '' }));
      expect(res.status).toBe(422);
    });

    it('returns 422 for invalid scope', async () => {
      const res = await createSession(
        jsonReq('POST', '/api/chat', { message: 'Hello', scope: 'invalid' }),
      );
      expect(res.status).toBe(422);
    });

    it('accepts article scope', async () => {
      const res = await createSession(
        jsonReq('POST', '/api/chat', {
          message: 'Summarize this article',
          scope: `article:${testArticleId}`,
        }),
      );
      expect(res.status).toBe(200);
      const events = await parseSSE(res);
      const sessionEvent = events.find((e) => e.event === 'session');
      expect((sessionEvent!.data as { scope: string }).scope).toBe(`article:${testArticleId}`);
    });
  });

  describe('GET /api/chat/[id] (get session)', () => {
    it('returns 404 for nonexistent session', async () => {
      const res = await getSession(jsonReq('GET', '/api/chat/999'), routeContext(999));
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/chat/[id]', () => {
    it('returns 404 for nonexistent session', async () => {
      const res = await updateSession(
        jsonReq('PATCH', '/api/chat/999', { title: 'New title' }),
        routeContext(999),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/chat/[id]', () => {
    it('returns 404 for nonexistent session', async () => {
      const res = await deleteSession(jsonReq('DELETE', '/api/chat/999'), routeContext(999));
      expect(res.status).toBe(404);
    });
  });

  describe('Chat CRUD flow', () => {
    it('creates, lists, gets, updates, and deletes a session', async () => {
      // Create via POST (SSE)
      const createRes = await createSession(
        jsonReq('POST', '/api/chat', { message: 'Tell me about testing' }),
      );
      const events = await parseSSE(createRes);
      const sessionId = (events.find((e) => e.event === 'session')!.data as { id: number }).id;

      // List
      const listRes = await listSessions(jsonReq('GET', '/api/chat'));
      const listBody = await listRes.json();
      expect(listBody.total).toBe(1);
      expect(listBody.sessions[0].id).toBe(sessionId);
      expect(listBody.sessions[0].messageCount).toBeGreaterThanOrEqual(2); // user + assistant

      // Get with messages
      const getRes = await getSession(
        jsonReq('GET', `/api/chat/${sessionId}`),
        routeContext(sessionId),
      );
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.session.id).toBe(sessionId);
      expect(getBody.messages.length).toBeGreaterThanOrEqual(2);
      expect(getBody.messages[0].role).toBe('user');
      expect(getBody.messages[1].role).toBe('assistant');

      // Update title
      const patchRes = await updateSession(
        jsonReq('PATCH', `/api/chat/${sessionId}`, { title: 'Updated Title' }),
        routeContext(sessionId),
      );
      expect(patchRes.status).toBe(200);
      const patchBody = await patchRes.json();
      expect(patchBody.session.title).toBe('Updated Title');

      // Send follow-up message
      const followupRes = await sendMessage(
        jsonReq('POST', `/api/chat/${sessionId}`, { message: 'Tell me more' }),
        routeContext(sessionId),
      );
      expect(followupRes.status).toBe(200);
      const followupEvents = await parseSSE(followupRes);
      expect(followupEvents.filter((e) => e.event === 'delta').length).toBeGreaterThan(0);

      // Verify messages grew
      const getRes2 = await getSession(
        jsonReq('GET', `/api/chat/${sessionId}`),
        routeContext(sessionId),
      );
      const getBody2 = await getRes2.json();
      expect(getBody2.messages.length).toBeGreaterThanOrEqual(4); // 2 original + 2 follow-up

      // Delete
      const deleteRes = await deleteSession(
        jsonReq('DELETE', `/api/chat/${sessionId}`),
        routeContext(sessionId),
      );
      expect(deleteRes.status).toBe(204);

      // Verify deleted
      const getRes3 = await getSession(
        jsonReq('GET', `/api/chat/${sessionId}`),
        routeContext(sessionId),
      );
      expect(getRes3.status).toBe(404);
    });
  });
});
