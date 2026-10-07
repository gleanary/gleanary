import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { isNull } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { createTestDb } from './setup';
import { resetClient } from '@/lib/ai';
import { articles } from '@/db/schema';
import { POST as createArticle } from '@/app/api/articles/route';
import { POST as backfill } from '@/app/api/ai/index/backfill/route';

// Anthropic handler: fails (500) when the article input mentions the FAIL marker,
// otherwise returns a deterministic concept index string.
setupHandlers(
  http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    const body = (await request.json()) as { messages: { content: string }[] };
    const input = body.messages.map((m) => m.content).join('\n');
    if (input.includes('FAIL_MARKER')) {
      return HttpResponse.json({ error: { message: 'Server error' } }, { status: 500 });
    }
    return HttpResponse.json({
      id: 'msg_backfill',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'concept index generated' }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
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

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Consume a Response's SSE body stream to the end and parse each event. */
async function readSseEvents(res: Response): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  buffer += decoder.decode();

  const events: SseEvent[] = [];
  for (const chunk of buffer.split('\n\n')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    let event = 'message';
    let data = '{}';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data = line.slice('data:'.length).trim();
    }
    events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

async function seedArticle(slug: string, title: string): Promise<number> {
  const res = await createArticle(
    jsonReq('POST', '/api/articles', {
      url: `https://example.com/${slug}`,
      title,
      contentHtml: `<p>Body for ${title}.</p>`,
      contentText: `Body for ${title}. Detailed content describing ${title} for indexing.`,
      excerpt: `Excerpt for ${title}`,
    }),
  );
  const body = await res.json();
  return body.article.id;
}

describe('POST /api/ai/index/backfill', () => {
  let currentDb: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    const { db } = dbMock.setup();
    currentDb = db;
    resetClient();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns an SSE stream for an empty/absent JSON body', async () => {
    const res = await backfill(jsonReq('POST', '/api/ai/index/backfill'));
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const events = await readSseEvents(res);
    const done = events.find((e) => e.event === 'done');
    expect(done?.data).toEqual({ indexed: 0, skipped: 0, errors: 0 });
  });

  it('returns a non-SSE 422 before the stream starts for an invalid batchSize', async () => {
    const res = await backfill(jsonReq('POST', '/api/ai/index/backfill', { batchSize: 0 }));
    expect(res.status).toBe(422);
    expect(res.headers.get('Content-Type')).not.toBe('text/event-stream');
  });

  it('emits an immediate done event when there are zero unindexed articles', async () => {
    const res = await backfill(jsonReq('POST', '/api/ai/index/backfill', { batchSize: 10 }));
    const events = await readSseEvents(res);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('done');
    expect(events[0]?.data).toEqual({ indexed: 0, skipped: 0, errors: 0 });
  });

  it('indexes all unindexed articles within a single batch', async () => {
    await seedArticle('bf-1', 'First');
    await seedArticle('bf-2', 'Second');

    const res = await backfill(jsonReq('POST', '/api/ai/index/backfill', { batchSize: 10 }));
    const events = await readSseEvents(res);

    const done = events.find((e) => e.event === 'done');
    expect(done?.data).toEqual({ indexed: 2, skipped: 0, errors: 0 });

    const stillNull = currentDb
      .select({ id: articles.id })
      .from(articles)
      .where(isNull(articles.aiIndex))
      .all();
    expect(stillNull).toHaveLength(0);
  });

  it('caps processing with the limit param', async () => {
    await seedArticle('lim-1', 'One');
    await seedArticle('lim-2', 'Two');
    await seedArticle('lim-3', 'Three');

    const res = await backfill(
      jsonReq('POST', '/api/ai/index/backfill', { batchSize: 10, limit: 1 }),
    );
    const events = await readSseEvents(res);

    const done = events.find((e) => e.event === 'done');
    expect(done?.data).toEqual({ indexed: 1, skipped: 0, errors: 0 });

    const stillNull = currentDb
      .select({ id: articles.id })
      .from(articles)
      .where(isNull(articles.aiIndex))
      .all();
    expect(stillNull).toHaveLength(2);
  });

  it('reports an error event for a failing article and continues', async () => {
    await seedArticle('ok-1', 'Healthy Article');
    await seedArticle('bad-1', 'FAIL_MARKER Article');

    const res = await backfill(jsonReq('POST', '/api/ai/index/backfill', { batchSize: 10 }));
    const events = await readSseEvents(res);

    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.data.title).toBe('FAIL_MARKER Article');

    const done = events.find((e) => e.event === 'done');
    expect(done?.data).toEqual({ indexed: 1, skipped: 0, errors: 1 });

    // The healthy article was indexed; the failing one stays unindexed
    const stillNull = currentDb
      .select({ id: articles.id })
      .from(articles)
      .where(isNull(articles.aiIndex))
      .all();
    expect(stillNull).toHaveLength(1);
  });
});
