import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';
import { eq } from 'drizzle-orm';
import { server, setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { insertTestArticle } from './setup';
import { articles } from '@/db/schema';
import { resetClient } from '@/lib/ai';
import { clearSettingsCache } from '@/lib/settings';
import { POST as enrich } from '@/app/api/articles/[id]/enrich/route';
import toolFixture from '../mocks/fixtures/claude-tool-response.json';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
let claudeCalls = 0;

setupHandlers(
  http.post(MESSAGES_URL, () => {
    claudeCalls += 1;
    return HttpResponse.json(toolFixture);
  }),
);

function req(id: string | number, body?: string) {
  const request = new NextRequest(new URL(`/api/articles/${id}/enrich`, 'http://localhost:3000'), {
    method: 'POST',
    ...(body !== undefined ? { body, headers: { 'Content-Type': 'application/json' } } : {}),
  });
  return enrich(request, { params: Promise.resolve({ id: String(id) }) });
}

function seed(values: Partial<Parameters<typeof insertTestArticle>[1]> = {}) {
  return insertTestArticle(dbMock.mock.db!, {
    url: `https://example.com/${Math.random().toString(36).slice(2)}`,
    title: 'Route article',
    contentMarkdown: 'Some content worth summarizing.\n\nSecond paragraph.',
    ...values,
  });
}

function row(id: number) {
  return dbMock.mock.db!.select().from(articles).where(eq(articles.id, id)).get()!;
}

describe('POST /api/articles/[id]/enrich', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    dbMock.setup();
    clearSettingsCache();
    resetClient();
    claudeCalls = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('enriches the article and returns the view with cached: false (empty body accepted)', async () => {
    const article = seed();
    const res = await req(article.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(false);
    expect(body.article).toMatchObject({
      id: article.id,
      enrichStatus: 'done',
      enrichTruncated: false,
      aiTags: ['testing', 'software-engineering'],
    });
    expect(typeof body.article.enrichedAt).toBe('string');
    expect(body.article.aiSummary).toContain('**Unit tests catch regressions');
    expect(claudeCalls).toBe(1);
  });

  it('accepts a whitespace-only body as empty', async () => {
    const article = seed();
    const res = await req(article.id, '  \n');
    expect(res.status).toBe(200);
  });

  it('returns the cached result without a call for a done article', async () => {
    const article = seed({ enrichStatus: 'done', aiSummary: '**Old**', aiTags: '["a"]' });
    const res = await req(article.id, '{}');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ cached: true, article: { aiSummary: '**Old**', aiTags: ['a'] } });
    expect(claudeCalls).toBe(0);
  });

  it('regenerates a done article with force: true', async () => {
    const article = seed({ enrichStatus: 'done', aiSummary: '**Old**' });
    const res = await req(article.id, JSON.stringify({ force: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(false);
    expect(body.article.aiSummary).not.toBe('**Old**');
    expect(claudeCalls).toBe(1);
  });

  it('returns 404 for an unknown article', async () => {
    const res = await req(99_999);
    expect(res.status).toBe(404);
  });

  it('returns 422 for an invalid id and for a non-boolean force', async () => {
    expect((await req('abc')).status).toBe(422);
    const article = seed();
    expect((await req(article.id, JSON.stringify({ force: 'yes' }))).status).toBe(422);
    expect(claudeCalls).toBe(0);
  });

  it('returns 400 for malformed non-empty JSON', async () => {
    const article = seed();
    expect((await req(article.id, '{not json')).status).toBe(400);
  });

  it('returns 409 for a pending_review article with nothing written', async () => {
    const article = seed({ status: 'pending_review' });
    const res = await req(article.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Article is waiting for sender approval');
    expect(row(article.id).enrichStatus).toBe('none');
    expect(claudeCalls).toBe(0);
  });

  it('returns 422 for an article without content and marks it failed with attempts 3', async () => {
    const article = seed({ contentMarkdown: '', contentText: '' });
    const res = await req(article.id);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Article has no content to analyze');
    expect(row(article.id)).toMatchObject({ enrichStatus: 'failed', enrichAttempts: 3 });
  });

  it('returns 503 with nothing written when no API key is configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const article = seed();
    const res = await req(article.id);
    expect(res.status).toBe(503);
    expect(row(article.id)).toMatchObject({ enrichStatus: 'none', enrichAttempts: 0 });
  });

  it('returns 503 and failed/1 on a provider error', async () => {
    server.use(
      http.post(MESSAGES_URL, () =>
        HttpResponse.json({ error: { type: 'api_error', message: 'boom' } }, { status: 500 }),
      ),
    );
    const article = seed();
    const res = await req(article.id);
    expect(res.status).toBe(503);
    expect(row(article.id)).toMatchObject({ enrichStatus: 'failed', enrichAttempts: 1 });
  });

  it('returns 502 and failed/1 when the model stops on max_tokens', async () => {
    server.use(
      http.post(MESSAGES_URL, () =>
        HttpResponse.json({ ...toolFixture, stop_reason: 'max_tokens' }),
      ),
    );
    const article = seed();
    const res = await req(article.id);
    expect(res.status).toBe(502);
    expect(row(article.id)).toMatchObject({ enrichStatus: 'failed', enrichAttempts: 1 });
  });
});
