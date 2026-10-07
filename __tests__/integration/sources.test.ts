import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { GET as listSources, POST as createSource } from '@/app/api/sources/route';
import { DELETE as deleteSource } from '@/app/api/sources/[id]/route';

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
    it('returns empty list initially', async () => {
      const res = await listSources(jsonReq('GET', '/api/sources'));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.sources).toEqual([]);
    });

    it('returns all sources', async () => {
      await createSource(jsonReq('POST', '/api/sources', validRssSource));
      await createSource(jsonReq('POST', '/api/sources', { type: 'manual', name: 'Manual' }));

      const res = await listSources(jsonReq('GET', '/api/sources'));
      const body = await res.json();
      expect(body.sources).toHaveLength(2);
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

      // Verify it's gone
      const listRes = await listSources(jsonReq('GET', '/api/sources'));
      const body = await listRes.json();
      expect(body.sources).toHaveLength(0);
    });

    it('returns 404 for nonexistent source', async () => {
      const res = await deleteSource(jsonReq('DELETE', '/api/sources/9999'), routeParams(9999));
      expect(res.status).toBe(404);
    });
  });
});
