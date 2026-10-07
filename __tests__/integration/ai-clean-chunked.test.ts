import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { eq } from 'drizzle-orm';
import { server, setupHandlers } from '../mocks/server';
import { resetClient } from '@/lib/ai';
import { clearSettingsCache } from '@/lib/settings';
import { MISTRAL_REFORMAT_MODEL } from '@/lib/mistral-chat';
import { articles, aiUsage } from '@/db/schema';
import { POST as createArticle } from '@/app/api/articles/route';
import { POST as cleanArticle } from '@/app/api/ai/clean/route';
import { CHUNK_THRESHOLD } from '@/app/api/ai/clean/route';

/**
 * ~18k chars of valid HTML. Chosen to pass validateCleanOutput for chunks of
 * 15k–25k (ratio bounds: 60%–140% of input length).
 */
const LARGE_CLEAN_RESPONSE = Array.from(
  { length: 170 },
  () => '<p>' + 'y'.repeat(100) + '</p>',
).join('\n');

const MISTRAL_SUCCESS = {
  id: 'chat-id',
  model: MISTRAL_REFORMAT_MODEL,
  choices: [
    { message: { content: LARGE_CLEAN_RESPONSE, role: 'assistant' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
};

const HAIKU_SUCCESS = {
  id: 'msg_clean',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: LARGE_CLEAN_RESPONSE }],
  model: 'claude-haiku-4-5-20251001',
  stop_reason: 'end_turn',
  usage: { input_tokens: 200, output_tokens: 50 },
};

setupHandlers(
  http.post('https://api.mistral.ai/v1/chat/completions', () => HttpResponse.json(MISTRAL_SUCCESS)),
  http.post('https://api.anthropic.com/v1/messages', () => HttpResponse.json(HAIKU_SUCCESS)),
);

afterEach(() => {
  vi.unstubAllEnvs();
  clearSettingsCache();
});

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

/** Produce article HTML of ~targetSize chars using uniform 487-char paragraphs. */
function makeLargeHtml(targetSize: number): string {
  const para = '<p>' + 'x'.repeat(480) + '</p>';
  const count = Math.ceil(targetSize / (para.length + 1));
  return Array.from({ length: count }, () => para).join('\n');
}

describe('Chunked reformat path (content > CHUNK_THRESHOLD)', () => {
  let articleId: number;

  beforeEach(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
    dbMock.setup();
    resetClient();

    const largeHtml = makeLargeHtml(CHUNK_THRESHOLD + 5_000);
    const res = await createArticle(
      jsonReq('POST', '/api/articles', {
        url: 'https://example.com/chunked-test',
        title: 'Chunked Test Article',
        contentHtml: largeHtml,
        contentText: 'large article',
        excerpt: 'large',
      }),
    );
    const body = await res.json();
    articleId = body.article.id;
  });

  it('returns chunked:true and updates DB when all chunks succeed on Mistral', async () => {
    const db = dbMock.mock.db!;

    const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.chunked).toBe(true);
    expect(body.chunksTotal).toBeGreaterThan(1);
    expect(body.chunksSkipped).toBe(0);
    expect(body.provider).toBe('mistral');
    expect(body.fallback).toBeUndefined();
    expect(body.contentHtml).toBeTruthy();
    expect(body.contentMarkdown).toBeTruthy();

    const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
    expect(row?.aiCleanedAt).not.toBeNull();
    expect(row?.contentHtml).toBe(body.contentHtml);
  });

  it('records ai_usage rows with a shared runId across all chunks', async () => {
    const db = dbMock.mock.db!;

    const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
    expect(res.status).toBe(200);

    const usageRows = db.select().from(aiUsage).where(eq(aiUsage.resourceId, articleId)).all();

    expect(usageRows.length).toBeGreaterThan(1);
    const runIds = [...new Set(usageRows.map((r) => r.runId).filter(Boolean))];
    expect(runIds).toHaveLength(1);
  });

  it('falls back to Haiku per-chunk when Mistral fails; reports provider:anthropic, fallback:true', async () => {
    server.use(
      http.post('https://api.mistral.ai/v1/chat/completions', () =>
        HttpResponse.json({ message: 'Internal error' }, { status: 500 }),
      ),
    );

    const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.chunked).toBe(true);
    expect(body.chunksSkipped).toBe(0);
    expect(body.provider).toBe('anthropic');
    expect(body.fallback).toBe(true);
  });

  it('keeps original HTML for the failed chunk and returns partial outcome when one chunk fails both providers', async () => {
    let mistralCallCount = 0;
    let haikuCallCount = 0;

    server.use(
      http.post('https://api.mistral.ai/v1/chat/completions', () => {
        mistralCallCount++;
        // Second Mistral call fails
        if (mistralCallCount === 2) {
          return HttpResponse.json({ message: 'error' }, { status: 500 });
        }
        return HttpResponse.json(MISTRAL_SUCCESS);
      }),
      http.post('https://api.anthropic.com/v1/messages', () => {
        haikuCallCount++;
        // First Haiku call (fallback for the failed Mistral) also fails
        if (haikuCallCount === 1) {
          return HttpResponse.json({ error: { message: 'error' } }, { status: 500 });
        }
        return HttpResponse.json(HAIKU_SUCCESS);
      }),
    );

    const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.chunked).toBe(true);
    expect(body.chunksSkipped).toBe(1);
    expect(body.chunksTotal).toBeGreaterThan(1);
    expect(body.contentHtml).toBeTruthy();

    const db = dbMock.mock.db!;
    const row = db.select().from(articles).where(eq(articles.id, articleId)).get();
    expect(row?.aiCleanedAt).not.toBeNull();
  });

  it('returns 422 and leaves DB unchanged when all chunks fail both providers', async () => {
    server.use(
      http.post('https://api.mistral.ai/v1/chat/completions', () =>
        HttpResponse.json({ message: 'error' }, { status: 500 }),
      ),
      http.post('https://api.anthropic.com/v1/messages', () =>
        HttpResponse.json({ error: { message: 'error' } }, { status: 429 }),
      ),
    );

    const db = dbMock.mock.db!;
    const before = db.select().from(articles).where(eq(articles.id, articleId)).get();
    const originalHtml = before?.contentHtml;

    const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.error).toMatch(/chunks failed/i);

    const after = db.select().from(articles).where(eq(articles.id, articleId)).get();
    expect(after?.contentHtml).toBe(originalHtml);
    expect(after?.aiCleanedAt).toBeNull();
  });

  it('returns provider:mixed and fallback:true when some chunks succeed on Mistral and one is rescued by Haiku', async () => {
    let mistralCallCount = 0;
    server.use(
      http.post('https://api.mistral.ai/v1/chat/completions', () => {
        mistralCallCount++;
        // Fail one Mistral call so Haiku rescue kicks in for that chunk
        if (mistralCallCount === 2) {
          return HttpResponse.json({ message: 'error' }, { status: 500 });
        }
        return HttpResponse.json(MISTRAL_SUCCESS);
      }),
    );

    const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.chunked).toBe(true);
    expect(body.chunksSkipped).toBe(0);
    expect(body.provider).toBe('mixed');
    expect(body.fallback).toBe(true);
  });

  it('skips Mistral and goes direct to Haiku on all chunks when provider is anthropic', async () => {
    vi.stubEnv('REFORMAT_PROVIDER', 'anthropic');
    clearSettingsCache();

    let mistralCalled = false;
    server.use(
      http.post('https://api.mistral.ai/v1/chat/completions', () => {
        mistralCalled = true;
        return HttpResponse.json(MISTRAL_SUCCESS);
      }),
    );

    const res = await cleanArticle(jsonReq('POST', '/api/ai/clean', { articleId }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.chunked).toBe(true);
    expect(body.provider).toBe('anthropic');
    expect(body.fallback).toBeUndefined();
    expect(mistralCalled).toBe(false);
  });
});
