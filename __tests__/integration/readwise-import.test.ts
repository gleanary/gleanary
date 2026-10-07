import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { createTestDb } from './setup';
import { server, setupHandlers } from '../mocks/server';
import { POST } from '@/app/api/import/readwise/route';
import { db } from '@/db';
import { articles, highlights } from '@/db/schema';
import { clearSettingsCache } from '@/lib/settings';

// --- MSW Server ---
const READER_LIST_URL = 'https://readwise.io/api/v3/list/';

function makeArticleDoc(id: number, url = `https://example.com/${id}`) {
  return {
    id: `doc-article-${id}`,
    url,
    source_url: url,
    title: `Article ${id}`,
    author: `Author ${id}`,
    category: 'article',
    location: 'archive',
    tags: {},
    site_name: null,
    word_count: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    notes: null,
    published_date: null,
    summary: null,
    image_url: null,
    parent_id: null,
    reading_progress: 1,
    content: null,
    html_content: `<p>Content for article ${id}</p>`,
  };
}

function makeHighlightDoc(id: number, parentId: string) {
  return {
    id: `doc-highlight-${id}`,
    url: `https://readwise.io/reader/read/doc-highlight-${id}`,
    source_url: null,
    title: null,
    author: null,
    category: 'highlight',
    location: 'archive',
    tags: {},
    site_name: null,
    word_count: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    notes: null,
    published_date: null,
    summary: null,
    image_url: null,
    parent_id: parentId,
    reading_progress: 0,
    content: `Highlight ${id} text`,
    html_content: '',
  };
}

setupHandlers(
  http.get(READER_LIST_URL, () =>
    HttpResponse.json({
      count: 4,
      results: [
        makeArticleDoc(1),
        makeHighlightDoc(1, 'doc-article-1'),
        makeArticleDoc(2),
        makeHighlightDoc(2, 'doc-article-2'),
      ],
      nextPageCursor: null,
    }),
  ),
);

describe('POST /api/import/readwise', () => {
  beforeEach(() => {
    dbMock.setup();
    clearSettingsCache();
    vi.stubEnv('READWISE_API_TOKEN', 'test-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeRequest(mode = 'full') {
    return new NextRequest(new URL(`http://localhost:3000/api/import/readwise?mode=${mode}`), {
      method: 'POST',
    });
  }

  async function consumeSSE(response: Response): Promise<{ event: string; data: unknown }[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: { event: string; data: unknown }[] = [];
    let buffer = '';
    let eventName = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventName = line.slice(7).trim();
        } else if (line.startsWith('data: ') && eventName) {
          events.push({ event: eventName, data: JSON.parse(line.slice(6)) });
          eventName = '';
        }
      }
    }

    return events;
  }

  it('returns SSE stream with correct content-type', async () => {
    const resp = await POST(makeRequest());
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Content-Type')).toBe('text/event-stream');
    await consumeSSE(resp);
  });

  it('imports articles and highlights, emits complete event', async () => {
    const resp = await POST(makeRequest());
    const events = await consumeSSE(resp);

    const completeEvent = events.find((e) => e.event === 'complete');
    expect(completeEvent).toBeDefined();
    const data = completeEvent!.data as { articles: number; highlights: number };
    expect(data.articles).toBe(2);
    expect(data.highlights).toBe(2);

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    expect(testDb.select().from(articles).all()).toHaveLength(2);
    expect(testDb.select().from(highlights).all()).toHaveLength(2);
  });

  it('stores html_content on imported articles', async () => {
    const resp = await POST(makeRequest());
    await consumeSSE(resp);

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    const allArticles = testDb.select().from(articles).all();
    expect(allArticles.every((a) => a.contentHtml !== null)).toBe(true);
  });

  it('skips non-article, non-highlight documents', async () => {
    server.use(
      http.get(READER_LIST_URL, () =>
        HttpResponse.json({
          count: 3,
          results: [
            makeArticleDoc(1),
            makeHighlightDoc(1, 'doc-article-1'),
            { ...makeArticleDoc(2), category: 'book', parent_id: null },
          ],
          nextPageCursor: null,
        }),
      ),
    );

    const resp = await POST(makeRequest());
    const events = await consumeSSE(resp);

    const completeEvent = events.find((e) => e.event === 'complete')!;
    const data = completeEvent.data as { articles: number; skippedNonArticles: number };
    expect(data.articles).toBe(1);
    expect(data.skippedNonArticles).toBe(1);
  });

  it('does not create duplicate articles on re-run', async () => {
    await consumeSSE(await POST(makeRequest()));
    await consumeSSE(await POST(makeRequest()));

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    expect(testDb.select().from(articles).all()).toHaveLength(2);
  });

  it('returns 503 when readwise_api_token is not configured', async () => {
    vi.stubEnv('READWISE_API_TOKEN', undefined);
    clearSettingsCache();

    const resp = await POST(makeRequest());
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.error).toContain('token');
  });

  it('emits fetching and importing progress events', async () => {
    const resp = await POST(makeRequest());
    const events = await consumeSSE(resp);

    const progressEvents = events.filter((e) => e.event === 'progress');
    expect(progressEvents.length).toBeGreaterThan(0);

    const phases = progressEvents.map((e) => (e.data as { phase: string }).phase);
    expect(phases).toContain('fetching');
    expect(phases).toContain('importing');
  });

  it('paginates through multiple pages', async () => {
    server.use(
      http.get(READER_LIST_URL, ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get('pageCursor');
        return HttpResponse.json(
          cursor
            ? {
                count: 2,
                results: [makeArticleDoc(2), makeHighlightDoc(2, 'doc-article-2')],
                nextPageCursor: null,
              }
            : {
                count: 2,
                results: [makeArticleDoc(1), makeHighlightDoc(1, 'doc-article-1')],
                nextPageCursor: 'page-2',
              },
        );
      }),
    );

    const resp = await POST(makeRequest());
    const events = await consumeSSE(resp);

    const fetchingEvents = events.filter(
      (e) => e.event === 'progress' && (e.data as { phase: string }).phase === 'fetching',
    );
    expect(fetchingEvents).toHaveLength(2);

    const testDb = db as ReturnType<typeof createTestDb>['db'];
    expect(testDb.select().from(articles).all()).toHaveLength(2);
  });
});
