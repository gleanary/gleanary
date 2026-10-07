import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { createTestDb } from './setup';
import { resetClient } from '@/lib/ai';
import { articles } from '@/db/schema';
import { POST as createArticle } from '@/app/api/articles/route';
import { POST as indexArticle } from '@/app/api/ai/index/route';

let aiCallCount = 0;
let indexText = 'topics: testing, entities: vitest, arguments: coverage';

setupHandlers(
  http.post('https://api.anthropic.com/v1/messages', () => {
    aiCallCount++;
    return HttpResponse.json({
      id: 'msg_index',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: indexText }],
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

const validArticle = {
  url: 'https://example.com/index-test',
  title: 'Index Test Article',
  contentHtml: '<p>Content about testing patterns for indexing.</p>',
  contentText:
    'Content about testing patterns for indexing. It covers concept extraction for FTS5 retrieval.',
  excerpt: 'Indexing test',
};

describe('POST /api/ai/index', () => {
  let currentDb: ReturnType<typeof createTestDb>['db'];
  let articleId: number;

  beforeEach(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    const { db } = dbMock.setup();
    currentDb = db;
    resetClient();
    aiCallCount = 0;
    indexText = 'topics: testing, entities: vitest, arguments: coverage';

    const res = await createArticle(jsonReq('POST', '/api/articles', validArticle));
    const body = await res.json();
    articleId = body.article.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 404 for an unknown articleId', async () => {
    const res = await indexArticle(jsonReq('POST', '/api/ai/index', { articleId: 999999 }));
    expect(res.status).toBe(404);
    expect(aiCallCount).toBe(0);
  });

  it('returns 422 for a missing articleId', async () => {
    const res = await indexArticle(jsonReq('POST', '/api/ai/index', {}));
    expect(res.status).toBe(422);
    expect(aiCallCount).toBe(0);
  });

  it('generates and persists an index on the article row', async () => {
    const res = await indexArticle(jsonReq('POST', '/api/ai/index', { articleId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ articleId, indexed: true });
    expect(aiCallCount).toBe(1);

    const row = currentDb
      .select({ aiIndex: articles.aiIndex })
      .from(articles)
      .where(eq(articles.id, articleId))
      .get();
    expect(row?.aiIndex).toBe('topics: testing, entities: vitest, arguments: coverage');
  });

  it('skips generation when aiIndex exists and force is not set', async () => {
    currentDb
      .update(articles)
      .set({ aiIndex: 'EXISTING INDEX' })
      .where(eq(articles.id, articleId))
      .run();
    aiCallCount = 0;

    const res = await indexArticle(jsonReq('POST', '/api/ai/index', { articleId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ articleId, indexed: false });
    // No AI call was made
    expect(aiCallCount).toBe(0);

    const row = currentDb
      .select({ aiIndex: articles.aiIndex })
      .from(articles)
      .where(eq(articles.id, articleId))
      .get();
    expect(row?.aiIndex).toBe('EXISTING INDEX');
  });

  it('regenerates and updates the row when force is true', async () => {
    currentDb
      .update(articles)
      .set({ aiIndex: 'OLD INDEX' })
      .where(eq(articles.id, articleId))
      .run();
    aiCallCount = 0;
    indexText = 'FRESH INDEX';

    const res = await indexArticle(jsonReq('POST', '/api/ai/index', { articleId, force: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ articleId, indexed: true });
    expect(aiCallCount).toBe(1);

    const row = currentDb
      .select({ aiIndex: articles.aiIndex })
      .from(articles)
      .where(eq(articles.id, articleId))
      .get();
    expect(row?.aiIndex).toBe('FRESH INDEX');
  });
});
