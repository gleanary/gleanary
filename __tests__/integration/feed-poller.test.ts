import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, setupHandlers } from '../mocks/server';
import {
  validRssFeed,
  validAtomFeed,
  emptyFeed,
  feedWithNoLinkItem,
  invalidXml,
  articleHtml,
} from '../mocks/fixtures/rss-feeds';

// Prevent real DNS lookups (fake test domains hang in dns.resolve4)
vi.mock('dns/promises', () => ({
  default: { resolve4: vi.fn().mockResolvedValue([]), resolve6: vi.fn().mockResolvedValue([]) },
}));

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

// Import after mocking
import { pollFeed, pollAllFeeds } from '@/lib/feed-poller';
import { db } from '@/db';
import { sources, articles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { Source } from '@/types';

setupHandlers(
  // Default: return valid RSS feed
  http.get('https://testblog.com/feed.xml', () => {
    return new HttpResponse(validRssFeed, {
      headers: {
        'Content-Type': 'application/xml',
        ETag: '"feed-etag-123"',
        'Last-Modified': 'Wed, 03 Jan 2024 00:00:00 GMT',
      },
    });
  }),

  // Atom feed
  http.get('https://atomblog.com/feed.xml', () => {
    return new HttpResponse(validAtomFeed, {
      headers: { 'Content-Type': 'application/xml' },
    });
  }),

  // Empty feed
  http.get('https://emptyfeed.com/feed.xml', () => {
    return new HttpResponse(emptyFeed, {
      headers: { 'Content-Type': 'application/xml' },
    });
  }),

  // Feed with broken items
  http.get('https://brokenfeed.com/feed.xml', () => {
    return new HttpResponse(feedWithNoLinkItem, {
      headers: { 'Content-Type': 'application/xml' },
    });
  }),

  // Invalid XML feed
  http.get('https://invalidfeed.com/feed.xml', () => {
    return new HttpResponse(invalidXml, {
      headers: { 'Content-Type': 'application/xml' },
    });
  }),

  // Article pages for feed items
  http.get('https://testblog.com/first-post', () => {
    return HttpResponse.html(articleHtml);
  }),
  http.get('https://testblog.com/second-post', () => {
    return HttpResponse.html(articleHtml);
  }),
  http.get('https://atomblog.com/atom-entry', () => {
    return HttpResponse.html(articleHtml);
  }),
  http.get('https://brokenfeed.com/has-link', () => {
    return HttpResponse.html(articleHtml);
  }),

  // Unreachable feed
  http.get('https://unreachable.com/feed.xml', () => {
    return HttpResponse.error();
  }),

  // Feed that returns 500
  http.get('https://servererror.com/feed.xml', () => {
    return new HttpResponse('Internal Server Error', { status: 500 });
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

// --- Helper ---
function createRssSource(overrides: Partial<Source> = {}): Source {
  const row = db
    .insert(sources)
    .values({
      type: 'rss_feed',
      name: 'Test Blog',
      feedUrl: 'https://testblog.com/feed.xml',
      pollInterval: 30,
      ...overrides,
    })
    .returning()
    .all();
  return row[0]!;
}

describe('feed-poller', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  describe('pollFeed', () => {
    it('polls a valid RSS feed and creates new articles', async () => {
      const source = createRssSource();

      const result = await pollFeed(source);

      expect(result.feedId).toBe(source.id);
      expect(result.feedName).toBe('Test Blog');
      expect(result.newArticles).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify articles were created
      const allArticles = db.select().from(articles).all();
      expect(allArticles).toHaveLength(2);
      expect(allArticles[0]!.sourceId).toBe(source.id);
      expect(allArticles[0]!.status).toBe('inbox');
    });

    it('updates lastPolled, etag, and lastModified on the source after polling', async () => {
      const source = createRssSource();

      await pollFeed(source);

      const updated = db.select().from(sources).where(eq(sources.id, source.id)).all();
      expect(updated[0]!.lastPolled).toBeTruthy();
      expect(updated[0]!.etag).toBe('"feed-etag-123"');
      expect(updated[0]!.lastModified).toBe('Wed, 03 Jan 2024 00:00:00 GMT');
    });

    it('skips articles that already exist (dedup by URL)', async () => {
      const source = createRssSource();

      // Pre-insert one of the articles
      db.insert(articles)
        .values({
          url: 'https://testblog.com/first-post',
          title: 'Already Saved',
          sourceId: source.id,
        })
        .run();

      const result = await pollFeed(source);

      expect(result.newArticles).toBe(1);
      expect(result.skipped).toBe(1);

      // Should be 2 total: 1 pre-existing + 1 new
      const allArticles = db.select().from(articles).all();
      expect(allArticles).toHaveLength(2);
    });

    it('handles Atom feeds', async () => {
      const source = createRssSource({
        name: 'Atom Blog',
        feedUrl: 'https://atomblog.com/feed.xml',
      });

      const result = await pollFeed(source);

      expect(result.newArticles).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('handles empty feeds gracefully', async () => {
      const source = createRssSource({
        name: 'Empty Feed',
        feedUrl: 'https://emptyfeed.com/feed.xml',
      });

      const result = await pollFeed(source);

      expect(result.newArticles).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      // lastPolled should still be updated
      const updated = db.select().from(sources).where(eq(sources.id, source.id)).all();
      expect(updated[0]!.lastPolled).toBeTruthy();
    });

    it('skips feed items with no link', async () => {
      const source = createRssSource({
        name: 'Broken Feed',
        feedUrl: 'https://brokenfeed.com/feed.xml',
      });

      const result = await pollFeed(source);

      // 1 item has no link (skipped), 1 item has a link (created)
      expect(result.newArticles).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('returns error when feed is unreachable', async () => {
      const source = createRssSource({
        name: 'Unreachable',
        feedUrl: 'https://unreachable.com/feed.xml',
      });

      const result = await pollFeed(source);

      expect(result.newArticles).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);

      // lastPolled should NOT be updated on failure
      const updated = db.select().from(sources).where(eq(sources.id, source.id)).all();
      expect(updated[0]!.lastPolled).toBeNull();
    });

    it('returns error when feed returns server error', async () => {
      const source = createRssSource({
        name: 'Server Error',
        feedUrl: 'https://servererror.com/feed.xml',
      });

      const result = await pollFeed(source);

      expect(result.newArticles).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns error when feed returns invalid XML', async () => {
      const source = createRssSource({
        name: 'Invalid Feed',
        feedUrl: 'https://invalidfeed.com/feed.xml',
      });

      const result = await pollFeed(source);

      expect(result.newArticles).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns error for non-rss_feed source type', async () => {
      const source = createRssSource({ type: 'manual' as 'rss_feed', feedUrl: null });

      const result = await pollFeed(source);

      expect(result.newArticles).toBe(0);
      expect(result.errors).toContain('Source is not an RSS feed or has no feed URL');
    });

    it('returns error for source without feedUrl', async () => {
      // Directly insert to bypass schema validation
      const row = db
        .insert(sources)
        .values({
          type: 'rss_feed',
          name: 'No URL Feed',
          feedUrl: null,
        })
        .returning()
        .all();

      const result = await pollFeed(row[0]!);

      expect(result.newArticles).toBe(0);
      expect(result.errors).toContain('Source is not an RSS feed or has no feed URL');
    });

    it('sends conditional headers when etag/lastModified are present', async () => {
      let capturedHeaders: Record<string, string> = {};

      server.use(
        http.get('https://testblog.com/feed.xml', ({ request }) => {
          capturedHeaders = Object.fromEntries(request.headers.entries());
          return new HttpResponse(validRssFeed, {
            headers: { 'Content-Type': 'application/xml' },
          });
        }),
      );

      const source = createRssSource({
        etag: '"old-etag"',
        lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      });

      await pollFeed(source);

      expect(capturedHeaders['if-none-match']).toBe('"old-etag"');
      expect(capturedHeaders['if-modified-since']).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    });

    it('handles 304 Not Modified responses', async () => {
      server.use(
        http.get('https://testblog.com/feed.xml', () => {
          return new HttpResponse(null, { status: 304 });
        }),
      );

      const source = createRssSource({ etag: '"current-etag"' });

      const result = await pollFeed(source);

      expect(result.newArticles).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      // lastPolled should be updated even for 304
      const updated = db.select().from(sources).where(eq(sources.id, source.id)).all();
      expect(updated[0]!.lastPolled).toBeTruthy();
    });

    it('continues processing remaining items when article parser fails for one', async () => {
      server.use(
        http.get('https://r.jina.ai/*', ({ request }) => {
          if (request.url.includes('first-post')) {
            return new HttpResponse('Not Found', { status: 404 });
          }
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

      const source = createRssSource();

      const result = await pollFeed(source);

      // First article fails, second succeeds
      expect(result.newArticles).toBe(1);
      expect(result.errors).toHaveLength(1);
    });

    it('stores publishedAt from feed item pubDate', async () => {
      const source = createRssSource();

      await pollFeed(source);

      const allArticles = db.select().from(articles).all();
      // At least one article should have a publishedAt date
      const articleWithDate = allArticles.find((a) => a.publishedAt !== null);
      expect(articleWithDate).toBeDefined();
    });
  });

  describe('pollAllFeeds', () => {
    it('polls all due feeds', async () => {
      // Create two feeds: one due, one not due
      createRssSource({ name: 'Due Feed' }); // lastPolled is null → due

      const results = await pollAllFeeds();

      expect(results).toHaveLength(1);
      expect(results[0]!.feedName).toBe('Due Feed');
    });

    it('skips feeds that are not yet due', async () => {
      const now = new Date().toISOString();
      createRssSource({
        name: 'Recent Feed',
        lastPolled: now,
        pollInterval: 60, // 60 minutes — not due yet
      });

      const results = await pollAllFeeds();

      expect(results).toHaveLength(0);
    });

    it('polls feeds that have never been polled (lastPolled is null)', async () => {
      createRssSource({ name: 'Never Polled', lastPolled: null });

      const results = await pollAllFeeds();

      expect(results).toHaveLength(1);
      expect(results[0]!.newArticles).toBe(2);
    });

    it('skips non-rss_feed sources', async () => {
      db.insert(sources)
        .values({
          type: 'manual',
          name: 'Manual Source',
        })
        .run();

      const results = await pollAllFeeds();

      expect(results).toHaveLength(0);
    });

    it('returns empty array when no feeds exist', async () => {
      const results = await pollAllFeeds();
      expect(results).toEqual([]);
    });

    it('continues polling remaining feeds when one fails', async () => {
      createRssSource({
        name: 'Failing Feed',
        feedUrl: 'https://unreachable.com/feed.xml',
      });
      createRssSource({
        name: 'Working Feed',
        feedUrl: 'https://testblog.com/feed.xml',
      });

      const results = await pollAllFeeds();

      expect(results).toHaveLength(2);
      const failing = results.find((r) => r.feedName === 'Failing Feed');
      const working = results.find((r) => r.feedName === 'Working Feed');
      expect(failing!.errors.length).toBeGreaterThan(0);
      expect(working!.newArticles).toBe(2);
    });
  });
});
