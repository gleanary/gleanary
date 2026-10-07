import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { createTestDb } from './setup';
import { highlights } from '@/db/schema';
import { POST as createArticle } from '@/app/api/articles/route';
import { GET as getReview, POST as postReview } from '@/app/api/review/route';

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

async function seedArticle(_db: ReturnType<typeof createTestDb>['db']) {
  const res = await createArticle(
    jsonReq('POST', '/api/articles', {
      url: 'https://example.com/test',
      title: 'Test Article',
      contentHtml: '<p>Test content</p>',
      contentText: 'Test content',
    }),
  );
  const body = await res.json();
  return body.article;
}

function seedHighlight(
  db: ReturnType<typeof createTestDb>['db'],
  articleId: number,
  overrides: Record<string, unknown> = {},
) {
  return db
    .insert(highlights)
    .values({
      articleId,
      text: `Highlight ${Math.random().toString(36).slice(2, 8)}`,
      ...overrides,
    })
    .returning()
    .get()!;
}

describe('Review API', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    db = dbMock.setup().db;
  });

  describe('GET /api/review', () => {
    it('returns empty list when no highlights exist', async () => {
      const res = await getReview(jsonReq('GET', '/api/review'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.highlights).toEqual([]);
      expect(body.totalDue).toBe(0);
    });

    it('returns never-reviewed highlights as due', async () => {
      const article = await seedArticle(db);
      seedHighlight(db, article.id);
      seedHighlight(db, article.id);

      const res = await getReview(jsonReq('GET', '/api/review'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.highlights).toHaveLength(2);
      expect(body.totalDue).toBe(2);
    });

    it('returns highlights whose interval has elapsed', async () => {
      const article = await seedArticle(db);
      // Reviewed 2 days ago with 1-day interval → due
      seedHighlight(db, article.id, {
        lastReviewed: '2020-01-01T00:00:00',
        reviewCount: 1,
        reviewInterval: 1,
      });

      const res = await getReview(jsonReq('GET', '/api/review'));
      const body = await res.json();
      expect(body.highlights).toHaveLength(1);
      expect(body.totalDue).toBe(1);
    });

    it('excludes highlights not yet due', async () => {
      const article = await seedArticle(db);
      // Reviewed just now with 30-day interval → not due
      seedHighlight(db, article.id, {
        lastReviewed: new Date().toISOString(),
        reviewCount: 5,
        reviewInterval: 30,
      });

      const res = await getReview(jsonReq('GET', '/api/review'));
      const body = await res.json();
      expect(body.highlights).toHaveLength(0);
      expect(body.totalDue).toBe(0);
    });

    it('respects limit parameter', async () => {
      const article = await seedArticle(db);
      for (let i = 0; i < 5; i++) {
        seedHighlight(db, article.id);
      }

      const res = await getReview(jsonReq('GET', '/api/review?limit=2'));
      const body = await res.json();
      expect(body.highlights).toHaveLength(2);
      expect(body.totalDue).toBe(5);
    });

    it('includes article context with each highlight', async () => {
      const article = await seedArticle(db);
      seedHighlight(db, article.id);

      const res = await getReview(jsonReq('GET', '/api/review'));
      const body = await res.json();
      expect(body.highlights[0].article).toEqual({
        title: 'Test Article',
        url: 'https://example.com/test',
        siteName: null,
      });
    });
  });

  describe('POST /api/review', () => {
    it('updates highlight with got_it action', async () => {
      const article = await seedArticle(db);
      const highlight = seedHighlight(db, article.id);

      const res = await postReview(
        jsonReq('POST', '/api/review', {
          highlightId: highlight.id,
          action: 'got_it',
        }),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.highlight.reviewCount).toBe(1);
      expect(body.highlight.reviewInterval).toBe(1);
      expect(body.highlight.lastReviewed).toBeDefined();
    });

    it('doubles interval on subsequent got_it', async () => {
      const article = await seedArticle(db);
      const highlight = seedHighlight(db, article.id, {
        lastReviewed: '2020-01-01T00:00:00',
        reviewCount: 2,
        reviewInterval: 4,
      });

      const res = await postReview(
        jsonReq('POST', '/api/review', {
          highlightId: highlight.id,
          action: 'got_it',
        }),
      );
      const body = await res.json();
      expect(body.highlight.reviewInterval).toBe(8);
      expect(body.highlight.reviewCount).toBe(3);
    });

    it('resets interval on review_again', async () => {
      const article = await seedArticle(db);
      const highlight = seedHighlight(db, article.id, {
        lastReviewed: '2020-01-01T00:00:00',
        reviewCount: 5,
        reviewInterval: 32,
      });

      const res = await postReview(
        jsonReq('POST', '/api/review', {
          highlightId: highlight.id,
          action: 'review_again',
        }),
      );
      const body = await res.json();
      expect(body.highlight.reviewInterval).toBe(1);
      expect(body.highlight.reviewCount).toBe(6);
    });

    it('returns remaining due count', async () => {
      const article = await seedArticle(db);
      seedHighlight(db, article.id);
      seedHighlight(db, article.id);
      const h3 = seedHighlight(db, article.id);

      const res = await postReview(
        jsonReq('POST', '/api/review', {
          highlightId: h3.id,
          action: 'got_it',
        }),
      );
      const body = await res.json();
      // After reviewing h3, 2 remain due
      expect(body.remaining).toBe(2);
    });

    it('returns 404 for non-existent highlight', async () => {
      const res = await postReview(
        jsonReq('POST', '/api/review', {
          highlightId: 999,
          action: 'got_it',
        }),
      );
      expect(res.status).toBe(404);
    });

    it('returns 422 for invalid action', async () => {
      const res = await postReview(
        jsonReq('POST', '/api/review', {
          highlightId: 1,
          action: 'skip',
        }),
      );
      expect(res.status).toBe(422);
    });

    it('returns 422 for missing fields', async () => {
      const res = await postReview(jsonReq('POST', '/api/review', {}));
      expect(res.status).toBe(422);
    });
  });
});
