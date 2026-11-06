import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);
// The parse route schedules a background concept index; keep it out of these tests
vi.mock('@/lib/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai')>()),
  scheduleConceptIndex: vi.fn(),
}));

import { eq } from 'drizzle-orm';
import { GET as listSources, POST as createSource } from '@/app/api/sources/route';
import { DELETE as deleteSource } from '@/app/api/sources/[id]/route';
import { POST as createArticle } from '@/app/api/articles/route';
import { POST as parseArticle } from '@/app/api/articles/parse/route';
import { POST as pollFeeds } from '@/app/api/feeds/poll/route';
import { GET as listNewsletters } from '@/app/api/newsletters/route';
import { pollAllFeeds } from '@/lib/feed-poller';
import { listSidebarFeeds } from '@/lib/db-helpers';
import { articles, sources } from '@/db/schema';
import { SINGLETON_SOURCE_TYPES, UNDELETABLE_SOURCE_TYPES } from '@/types';
import { insertTestArticle, webSaveSourceId } from './setup';

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

function routeParams(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

const validRssSource = {
  type: 'rss_feed' as const,
  name: 'Test RSS Feed',
  feedUrl: 'https://example.com/feed.xml',
  category: 'Tech',
};

function db() {
  return dbMock.mock.db!;
}

function sourceRow(id: number) {
  return db().select().from(sources).where(eq(sources.id, id)).get();
}

async function createRss(overrides: Record<string, unknown> = {}) {
  const res = await createSource(
    jsonReq('POST', '/api/sources', { ...validRssSource, ...overrides }),
  );
  return (await res.json()).source as { id: number; name: string };
}

describe('Sources API', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  describe('POST /api/sources', () => {
    it('creates an RSS source', async () => {
      const res = await createSource(jsonReq('POST', '/api/sources', validRssSource));
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.source.name).toBe('Test RSS Feed');
      expect(body.source.type).toBe('rss_feed');
      expect(body.source.feedUrl).toBe('https://example.com/feed.xml');
      expect(body.source.pollInterval).toBe(30);
    });

    it('creates a manual source without feedUrl', async () => {
      const res = await createSource(
        jsonReq('POST', '/api/sources', { type: 'manual', name: 'Manual Source' }),
      );
      expect(res.status).toBe(201);
    });

    it('returns 422 when rss_feed type lacks feedUrl', async () => {
      const res = await createSource(
        jsonReq('POST', '/api/sources', { type: 'rss_feed', name: 'No Feed URL' }),
      );
      expect(res.status).toBe(422);
    });

    it('returns 422 for missing name', async () => {
      const res = await createSource(jsonReq('POST', '/api/sources', { type: 'manual' }));
      expect(res.status).toBe(422);
    });

    it.each(UNDELETABLE_SOURCE_TYPES)('returns 422 for built-in type %s', async (type) => {
      const before = db().select().from(sources).all();

      const res = await createSource(jsonReq('POST', '/api/sources', { type, name: 'Second' }));

      expect(res.status).toBe(422);
      expect(db().select().from(sources).all()).toEqual(before);
    });

    it('restores a soft-deleted feed with the same feed_url instead of inserting', async () => {
      const feed = await createRss();
      db()
        .update(sources)
        .set({ etag: '"etag-1"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' })
        .where(eq(sources.id, feed.id))
        .run();
      await deleteSource(jsonReq('DELETE', `/api/sources/${feed.id}`), routeParams(feed.id));

      const res = await createSource(
        jsonReq('POST', '/api/sources', {
          ...validRssSource,
          name: 'Renamed Feed',
          category: 'News',
          pollInterval: 60,
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.restored).toBe(true);
      expect(body.source.id).toBe(feed.id);
      expect(body.source.deletedAt).toBeNull();
      expect(body.source.name).toBe('Renamed Feed');
      expect(body.source.category).toBe('News');
      expect(body.source.pollInterval).toBe(60);
      expect(body.source.etag).toBe('"etag-1"');
      const row = sourceRow(feed.id)!;
      expect(row.deletedAt).toBeNull();
      expect(row.name).toBe('Renamed Feed');
      expect(row.etag).toBe('"etag-1"');
      expect(row.lastModified).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
      expect(db().select().from(sources).where(eq(sources.type, 'rss_feed')).all()).toHaveLength(1);
    });

    it('restores the most recently deleted feed when several share the feed_url', async () => {
      const older = await createRss({ name: 'Older' });
      const newer = await createRss({ name: 'Newer' });
      db()
        .update(sources)
        .set({ deletedAt: '2026-01-01 00:00:00' })
        .where(eq(sources.id, older.id))
        .run();
      db()
        .update(sources)
        .set({ deletedAt: '2026-06-01 00:00:00' })
        .where(eq(sources.id, newer.id))
        .run();

      const res = await createSource(jsonReq('POST', '/api/sources', validRssSource));

      expect(res.status).toBe(200);
      expect((await res.json()).source.id).toBe(newer.id);
      expect(sourceRow(older.id)!.deletedAt).toBe('2026-01-01 00:00:00');
    });

    it('creates a new feed (201) when only a different feed_url or a live duplicate exists', async () => {
      const deleted = await createRss({ feedUrl: 'https://other.example.com/feed.xml' });
      await deleteSource(jsonReq('DELETE', `/api/sources/${deleted.id}`), routeParams(deleted.id));
      const live = await createRss();

      const res = await createSource(jsonReq('POST', '/api/sources', validRssSource));

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.restored).toBeUndefined();
      expect(body.source.id).not.toBe(live.id);
      expect(body.source.id).not.toBe(deleted.id);
      expect(sourceRow(deleted.id)!.deletedAt).not.toBeNull();
    });

    it('does not restore a soft-deleted non-feed source', async () => {
      const manualRes = await createSource(
        jsonReq('POST', '/api/sources', {
          type: 'manual',
          name: 'Manual',
          feedUrl: 'https://example.com/feed.xml',
        }),
      );
      const manual = (await manualRes.json()).source;
      await deleteSource(jsonReq('DELETE', `/api/sources/${manual.id}`), routeParams(manual.id));

      const res = await createSource(jsonReq('POST', '/api/sources', validRssSource));

      expect(res.status).toBe(201);
      expect((await res.json()).source.id).not.toBe(manual.id);
      expect(sourceRow(manual.id)!.deletedAt).not.toBeNull();
    });

    it('returns 422 for invalid feedUrl', async () => {
      const res = await createSource(
        jsonReq('POST', '/api/sources', {
          type: 'rss_feed',
          name: 'Bad URL',
          feedUrl: 'not-a-url',
        }),
      );
      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/sources', () => {
    it('returns only the web_save singleton initially', async () => {
      const res = await listSources(jsonReq('GET', '/api/sources'));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.sources).toEqual([
        expect.objectContaining({ type: 'web_save', name: 'Web saves', deletedAt: null }),
      ]);
    });

    it('returns all sources', async () => {
      await createSource(jsonReq('POST', '/api/sources', validRssSource));
      await createSource(jsonReq('POST', '/api/sources', { type: 'manual', name: 'Manual' }));

      const res = await listSources(jsonReq('GET', '/api/sources'));
      const body = await res.json();
      expect(body.sources).toHaveLength(3);
    });
  });

  describe('DELETE /api/sources/[id]', () => {
    it('deletes a source', async () => {
      const createRes = await createSource(jsonReq('POST', '/api/sources', validRssSource));
      const { source } = await createRes.json();

      const res = await deleteSource(
        jsonReq('DELETE', `/api/sources/${source.id}`),
        routeParams(source.id),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).deleted).toBe(true);

      // Verify it's gone from the listing (only the web_save singleton remains)
      const listRes = await listSources(jsonReq('GET', '/api/sources'));
      const body = await listRes.json();
      expect(body.sources).toHaveLength(1);
      expect(body.sources.map((s: { id: number }) => s.id)).not.toContain(source.id);
    });

    it('soft-deletes a feed: row kept, articles keep their source, hidden everywhere', async () => {
      const feed = await createRss();
      const article = insertTestArticle(db(), {
        url: 'https://example.com/from-feed',
        title: 'From feed',
        sourceId: feed.id,
      });

      const res = await deleteSource(
        jsonReq('DELETE', `/api/sources/${feed.id}`),
        routeParams(feed.id),
      );
      expect(res.status).toBe(200);

      const row = sourceRow(feed.id);
      expect(row).toBeDefined();
      expect(row!.deletedAt).not.toBeNull();
      expect(db().select().from(articles).where(eq(articles.id, article.id)).get()!.sourceId).toBe(
        feed.id,
      );

      // Feed poller skips it (it was never polled, so it would otherwise be due)
      expect(await pollAllFeeds()).toEqual([]);
      expect(sourceRow(feed.id)!.lastPolled).toBeNull();

      // Listings omit it
      const listBody = await (await listSources(jsonReq('GET', '/api/sources'))).json();
      expect(listBody.sources.map((s: { id: number }) => s.id)).not.toContain(feed.id);
      expect(listSidebarFeeds().map((f) => f.id)).not.toContain(feed.id);

      // A manual poll of it is a 404, like an unknown id
      const pollRes = await pollFeeds(jsonReq('POST', '/api/feeds/poll', { sourceId: feed.id }));
      expect(pollRes.status).toBe(404);

      // A second delete is a 404
      const again = await deleteSource(
        jsonReq('DELETE', `/api/sources/${feed.id}`),
        routeParams(feed.id),
      );
      expect(again.status).toBe(404);
    });

    it.each(SINGLETON_SOURCE_TYPES)(
      'returns 422 for the %s singleton and leaves the row unchanged',
      async (type) => {
        const id =
          type === 'web_save'
            ? webSaveSourceId(db())
            : db()
                .insert(sources)
                .values({ type, name: `${type} source` })
                .returning()
                .get()!.id;
        const before = sourceRow(id);

        const res = await deleteSource(jsonReq('DELETE', `/api/sources/${id}`), routeParams(id));

        expect(res.status).toBe(422);
        expect((await res.json()).error).toBe("Built-in sources can't be deleted");
        expect(sourceRow(id)).toEqual(before);
      },
    );

    it.each([
      ['pending', null],
      ['approved', false],
      ['blocked', true],
    ] as const)(
      'returns 422 for a newsletter sender in %s state and leaves it listed',
      async (status, isBlocked) => {
        const sender = db()
          .insert(sources)
          .values({
            type: 'newsletter',
            name: 'Sender',
            senderAddress: 'sender@example.com',
            isBlocked,
          })
          .returning()
          .get()!;
        const before = sourceRow(sender.id);

        const res = await deleteSource(
          jsonReq('DELETE', `/api/sources/${sender.id}`),
          routeParams(sender.id),
        );

        expect(res.status).toBe(422);
        expect((await res.json()).error).toBe(
          "Newsletter senders can't be deleted; block them instead",
        );
        const after = sourceRow(sender.id)!;
        expect(after).toEqual(before);
        expect(after.isBlocked).toBe(isBlocked);
        const listed = await (await listNewsletters(jsonReq('GET', '/api/newsletters'))).json();
        expect(listed.newsletters).toEqual([expect.objectContaining({ id: sender.id, status })]);
      },
    );

    it('returns 404 for nonexistent source', async () => {
      const res = await deleteSource(jsonReq('DELETE', '/api/sources/9999'), routeParams(9999));
      expect(res.status).toBe(404);
    });
  });
});

describe('Article source resolution', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  it('POST /api/articles without sourceId assigns the web_save singleton', async () => {
    const res = await createArticle(
      jsonReq('POST', '/api/articles', { url: 'https://example.com/a', title: 'A' }),
    );

    expect(res.status).toBe(201);
    expect((await res.json()).article.sourceId).toBe(webSaveSourceId(db()));
  });

  it('POST /api/articles with an existing sourceId keeps it', async () => {
    const feed = await createRss();

    const res = await createArticle(
      jsonReq('POST', '/api/articles', {
        url: 'https://example.com/a',
        title: 'A',
        sourceId: feed.id,
      }),
    );

    expect(res.status).toBe(201);
    expect((await res.json()).article.sourceId).toBe(feed.id);
  });

  it('POST /api/articles with an unknown or soft-deleted sourceId returns 422', async () => {
    const feed = await createRss();
    await deleteSource(jsonReq('DELETE', `/api/sources/${feed.id}`), routeParams(feed.id));

    for (const sourceId of [9999, feed.id]) {
      const res = await createArticle(
        jsonReq('POST', '/api/articles', { url: 'https://example.com/a', title: 'A', sourceId }),
      );
      expect(res.status).toBe(422);
    }
    expect(db().select().from(articles).all()).toHaveLength(0);
  });

  it('POST /api/articles/parse with an unknown sourceId returns 422 before fetching', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/never-fetched',
        html: '<html><body><p>Body</p></body></html>',
        sourceId: 9999,
      }),
    );

    expect(res.status).toBe(422);
    expect(db().select().from(articles).all()).toHaveLength(0);
  });

  it('POST /api/articles/parse keeps the URL-duplicate 409 ahead of source validation', async () => {
    const existing = insertTestArticle(db(), { url: 'https://example.com/dup', title: 'Dup' });

    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', { url: 'https://example.com/dup', sourceId: 9999 }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).existingId).toBe(existing.id);
  });

  it('POST /api/articles/parse with provided HTML and no sourceId assigns web_save', async () => {
    const res = await parseArticle(
      jsonReq('POST', '/api/articles/parse', {
        url: 'https://example.com/with-html',
        html: '<html><head><title>T</title></head><body><article><p>Some body text here.</p></article></body></html>',
      }),
    );

    expect(res.status).toBe(201);
    expect((await res.json()).article.sourceId).toBe(webSaveSourceId(db()));
  });
});
