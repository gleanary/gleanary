import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupHandlers } from '../mocks/server';
import { NextRequest } from 'next/server';
import { validRssFeed, articleHtml } from '../mocks/fixtures/rss-feeds';

// Prevent real DNS lookups (fake test domains hang in dns.resolve4)
vi.mock('dns/promises', () => ({
  default: { resolve4: vi.fn().mockResolvedValue([]), resolve6: vi.fn().mockResolvedValue([]) },
}));

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

// Import after mocking
import { POST } from '@/app/api/feeds/poll/route';
import { db } from '@/db';
import { sources, articles } from '@/db/schema';

setupHandlers(
  http.get('https://testblog.com/feed.xml', () => {
    return new HttpResponse(validRssFeed, {
      headers: { 'Content-Type': 'application/xml' },
    });
  }),
  http.get('https://testblog.com/first-post', () => {
    return HttpResponse.html(articleHtml);
  }),
  http.get('https://testblog.com/second-post', () => {
    return HttpResponse.html(articleHtml);
  }),
  // Mock Jina Reader API for article parsing
  http.get('https://r.jina.ai/*', ({ request }) => {
    const url = request.url.replace('https://r.jina.ai/', '');
    return HttpResponse.json({
      data: {
        title: 'Test Article',
        description: 'A test article description',
        url,
        content: '# Test Article\n\nThis is test article content.',
      },
    });
  }),
);

function jsonReq(body?: object): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/feeds/poll'), {
    method: 'POST',
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

describe('POST /api/feeds/poll', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  it('polls all due feeds when no sourceId provided', async () => {
    db.insert(sources)
      .values({
        type: 'rss_feed',
        name: 'Test Blog',
        feedUrl: 'https://testblog.com/feed.xml',
        pollInterval: 30,
      })
      .run();

    const res = await POST(jsonReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].newArticles).toBe(2);
  });

  it('polls a specific feed when sourceId is provided', async () => {
    const row = db
      .insert(sources)
      .values({
        type: 'rss_feed',
        name: 'Test Blog',
        feedUrl: 'https://testblog.com/feed.xml',
        pollInterval: 30,
      })
      .returning()
      .all();

    const res = await POST(jsonReq({ sourceId: row[0]!.id }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].feedId).toBe(row[0]!.id);
  });

  it('returns 404 when sourceId does not exist', async () => {
    const res = await POST(jsonReq({ sourceId: 999 }));

    expect(res.status).toBe(404);
  });

  it('returns 422 when source is not an RSS feed', async () => {
    const row = db
      .insert(sources)
      .values({
        type: 'manual',
        name: 'Manual Source',
      })
      .returning()
      .all();

    const res = await POST(jsonReq({ sourceId: row[0]!.id }));

    expect(res.status).toBe(422);
  });

  it('returns 422 for invalid sourceId', async () => {
    const res = await POST(jsonReq({ sourceId: -1 }));

    expect(res.status).toBe(422);
  });

  it('creates articles with correct sourceId', async () => {
    const row = db
      .insert(sources)
      .values({
        type: 'rss_feed',
        name: 'Test Blog',
        feedUrl: 'https://testblog.com/feed.xml',
        pollInterval: 30,
      })
      .returning()
      .all();

    await POST(jsonReq({ sourceId: row[0]!.id }));

    const allArticles = db.select().from(articles).all();
    expect(allArticles).toHaveLength(2);
    expect(allArticles[0]!.sourceId).toBe(row[0]!.id);
    expect(allArticles[0]!.status).toBe('inbox');
  });

  it('returns empty results when no feeds are due', async () => {
    // Create a feed that was just polled
    db.insert(sources)
      .values({
        type: 'rss_feed',
        name: 'Recent Feed',
        feedUrl: 'https://testblog.com/feed.xml',
        pollInterval: 60,
        lastPolled: new Date().toISOString(),
      })
      .run();

    const res = await POST(jsonReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(0);
  });

  it('handles request with empty body', async () => {
    db.insert(sources)
      .values({
        type: 'rss_feed',
        name: 'Test Blog',
        feedUrl: 'https://testblog.com/feed.xml',
        pollInterval: 30,
      })
      .run();

    // Send request with no body
    const req = new NextRequest(new URL('http://localhost:3000/api/feeds/poll'), {
      method: 'POST',
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toBeDefined();
  });
});
