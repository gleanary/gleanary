import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

const { mockDeletePdf, mockDeletePdfImages } = vi.hoisted(() => ({
  mockDeletePdf: vi.fn().mockResolvedValue(undefined),
  mockDeletePdfImages: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/pdf-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf-storage')>();
  return { ...actual, deletePdf: mockDeletePdf, deletePdfImages: mockDeletePdfImages };
});

import { eq } from 'drizzle-orm';
import { articles } from '@/db/schema';

// Import route handlers after mock setup
import { GET as listArticles, POST as createArticle } from '@/app/api/articles/route';
import {
  GET as getArticle,
  PATCH as updateArticle,
  DELETE as deleteArticle,
} from '@/app/api/articles/[id]/route';

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

const validArticle = {
  url: 'https://example.com/test-article',
  title: 'Test Article',
  author: 'Test Author',
  contentHtml: '<p>Hello world</p>',
  contentText: 'Hello world',
  excerpt: 'A test article',
};

describe('Articles API', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  describe('POST /api/articles', () => {
    it('creates an article with valid data', async () => {
      const res = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.article.title).toBe('Test Article');
      expect(body.article.url).toBe('https://example.com/test-article');
      expect(body.article.status).toBe('inbox');
      expect(body.article.id).toBeDefined();
    });

    it('returns 422 for missing required fields', async () => {
      const res = await createArticle(jsonReq('POST', '/api/articles', { title: 'No URL' }));
      expect(res.status).toBe(422);
    });

    it('returns 422 for invalid URL', async () => {
      const res = await createArticle(
        jsonReq('POST', '/api/articles', { url: 'not-a-url', title: 'Bad URL' }),
      );
      expect(res.status).toBe(422);
    });

    it('returns 409 for duplicate URL', async () => {
      await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const res = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      expect(res.status).toBe(409);
    });

    it('computes word count from contentText when not provided', async () => {
      const res = await createArticle(
        jsonReq('POST', '/api/articles', {
          url: 'https://example.com/wc-test',
          title: 'Word Count Test',
          contentText: 'one two three four five',
        }),
      );
      const body = await res.json();
      expect(body.article.wordCount).toBe(5);
    });

    it('uses provided word count over computed', async () => {
      const res = await createArticle(
        jsonReq('POST', '/api/articles', {
          url: 'https://example.com/wc-override',
          title: 'Override',
          contentText: 'one two three',
          wordCount: 99,
        }),
      );
      const body = await res.json();
      expect(body.article.wordCount).toBe(99);
    });
  });

  describe('GET /api/articles', () => {
    beforeEach(async () => {
      await createArticle(jsonReq('POST', '/api/articles', validArticle));
      await createArticle(
        jsonReq('POST', '/api/articles', {
          url: 'https://example.com/second',
          title: 'Second Article',
          status: 'reading',
        }),
      );
      await createArticle(
        jsonReq('POST', '/api/articles', {
          url: 'https://example.com/third',
          title: 'Third Article',
          status: 'archived',
        }),
      );
    });

    it('returns all articles with total count', async () => {
      const res = await listArticles(jsonReq('GET', '/api/articles'));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.articles).toHaveLength(3);
      expect(body.total).toBe(3);
    });

    it('filters by status', async () => {
      const res = await listArticles(jsonReq('GET', '/api/articles?status=inbox'));
      const body = await res.json();
      expect(body.articles).toHaveLength(1);
      expect(body.articles[0].status).toBe('inbox');
    });

    it('filters by multiple statuses', async () => {
      const res = await listArticles(jsonReq('GET', '/api/articles?status=inbox,reading'));
      const body = await res.json();
      expect(body.articles).toHaveLength(2);
    });

    it('paginates with limit and offset', async () => {
      const res = await listArticles(jsonReq('GET', '/api/articles?limit=1&offset=1'));
      const body = await res.json();
      expect(body.articles).toHaveLength(1);
      expect(body.total).toBe(3);
    });

    it('sorts by title ascending', async () => {
      const res = await listArticles(jsonReq('GET', '/api/articles?sort=title&order=asc'));
      const body = await res.json();
      expect(body.articles[0].title).toBe('Second Article');
      expect(body.articles[2].title).toBe('Third Article');
    });

    it('filters by isFavorite', async () => {
      // Favorite the first article
      const allRes = await listArticles(jsonReq('GET', '/api/articles'));
      const allBody = await allRes.json();
      const firstId = allBody.articles[0].id;
      await updateArticle(
        jsonReq('PATCH', `/api/articles/${firstId}`, { isFavorite: true }),
        routeParams(firstId),
      );

      // Filter by isFavorite=true
      const favRes = await listArticles(jsonReq('GET', '/api/articles?isFavorite=true'));
      const favBody = await favRes.json();
      expect(favBody.articles).toHaveLength(1);
      expect(favBody.articles[0].id).toBe(firstId);
      expect(favBody.articles[0].isFavorite).toBe(true);
      expect(favBody.total).toBe(1);

      // Filter by isFavorite=false
      const nonFavRes = await listArticles(jsonReq('GET', '/api/articles?isFavorite=false'));
      const nonFavBody = await nonFavRes.json();
      expect(nonFavBody.articles).toHaveLength(2);
      expect(nonFavBody.total).toBe(2);
    });
  });

  describe('GET /api/articles/[id]', () => {
    it('returns article with highlights', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const res = await getArticle(
        jsonReq('GET', `/api/articles/${article.id}`),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.article.id).toBe(article.id);
      expect(body.highlights).toEqual([]);
    });

    it('returns 404 for nonexistent article', async () => {
      const res = await getArticle(jsonReq('GET', '/api/articles/9999'), routeParams(9999));
      expect(res.status).toBe(404);
    });

    it('returns 422 for invalid id', async () => {
      const res = await getArticle(jsonReq('GET', '/api/articles/abc'), {
        params: Promise.resolve({ id: 'abc' }),
      });
      expect(res.status).toBe(422);
    });
  });

  describe('PATCH /api/articles/[id]', () => {
    it('updates article status', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { status: 'reading' }),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.article.status).toBe('reading');
    });

    it('auto-sets readAt when archiving for the first time', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { status: 'archived' }),
        routeParams(article.id),
      );
      const body = await res.json();
      expect(body.article.readAt).toBeDefined();
    });

    it('does not overwrite readAt on direct re-archive', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const firstRes = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { status: 'archived' }),
        routeParams(article.id),
      );
      const { article: archived } = await firstRes.json();
      const firstReadAt = archived.readAt;

      const secondRes = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { status: 'archived' }),
        routeParams(article.id),
      );
      const { article: reArchived } = await secondRes.json();
      expect(reArchived.readAt).toBe(firstReadAt);
    });

    it('does not overwrite readAt after unarchive and re-archive', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const firstRes = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { status: 'archived' }),
        routeParams(article.id),
      );
      const { article: archived } = await firstRes.json();
      const firstReadAt = archived.readAt;

      await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { status: 'inbox' }),
        routeParams(article.id),
      );
      const secondRes = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { status: 'archived' }),
        routeParams(article.id),
      );
      const { article: reArchived } = await secondRes.json();
      expect(reArchived.readAt).toBe(firstReadAt);
    });

    it('respects client-supplied readAt when archiving', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();
      const clientReadAt = '2024-01-15T10:00:00.000Z';

      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, {
          status: 'archived',
          readAt: clientReadAt,
        }),
        routeParams(article.id),
      );
      const body = await res.json();
      expect(body.article.readAt).toBe(clientReadAt);
    });

    it('rejects status=read with 422', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { status: 'read' }),
        routeParams(article.id),
      );
      expect(res.status).toBe(422);
    });

    it('updates reading progress', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { readingProgress: 0.75 }),
        routeParams(article.id),
      );
      const body = await res.json();
      expect(body.article.readingProgress).toBe(0.75);
    });

    it('returns 404 for nonexistent article', async () => {
      const res = await updateArticle(
        jsonReq('PATCH', '/api/articles/9999', { status: 'reading' }),
        routeParams(9999),
      );
      expect(res.status).toBe(404);
    });

    it('returns 422 for empty body', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, {}),
        routeParams(article.id),
      );
      expect(res.status).toBe(422);
    });

    it('ignores reading progress lower than current value', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      // Set progress to 0.75
      await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { readingProgress: 0.75 }),
        routeParams(article.id),
      );

      // Try to set lower progress (0.30) — should be ignored
      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { readingProgress: 0.3 }),
        routeParams(article.id),
      );
      const body = await res.json();
      expect(body.article.readingProgress).toBe(0.75);
    });

    it('accepts reading progress higher than current value', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      // Set progress to 0.50
      await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { readingProgress: 0.5 }),
        routeParams(article.id),
      );

      // Set higher progress (0.80) — should succeed
      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { readingProgress: 0.8 }),
        routeParams(article.id),
      );
      const body = await res.json();
      expect(body.article.readingProgress).toBe(0.8);
    });

    it('returns 422 for invalid reading progress', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, { readingProgress: 1.5 }),
        routeParams(article.id),
      );
      expect(res.status).toBe(422);
    });

    it('saves TTS position (paragraph + time offset)', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, {
          ttsParagraph: 3,
          ttsTimeOffset: 12.5,
        }),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.article.ttsParagraph).toBe(3);
      expect(body.article.ttsTimeOffset).toBe(12.5);
    });

    it('clears TTS position when set to null', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      // Set a position first
      await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, {
          ttsParagraph: 5,
          ttsTimeOffset: 8.3,
        }),
        routeParams(article.id),
      );

      // Clear it
      const res = await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, {
          ttsParagraph: null,
          ttsTimeOffset: null,
        }),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.article.ttsParagraph).toBeNull();
      expect(body.article.ttsTimeOffset).toBeNull();
    });

    it('returns TTS position in GET response', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      await updateArticle(
        jsonReq('PATCH', `/api/articles/${article.id}`, {
          ttsParagraph: 2,
          ttsTimeOffset: 5.7,
        }),
        routeParams(article.id),
      );

      const getRes = await getArticle(
        jsonReq('GET', `/api/articles/${article.id}`),
        routeParams(article.id),
      );
      const body = await getRes.json();
      expect(body.article.ttsParagraph).toBe(2);
      expect(body.article.ttsTimeOffset).toBe(5.7);
    });
  });

  describe('DELETE /api/articles/[id]', () => {
    it('deletes an article', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      const res = await deleteArticle(
        jsonReq('DELETE', `/api/articles/${article.id}`),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.deleted).toBe(true);

      // Verify it's gone
      const getRes = await getArticle(
        jsonReq('GET', `/api/articles/${article.id}`),
        routeParams(article.id),
      );
      expect(getRes.status).toBe(404);
    });

    it('returns 404 for nonexistent article', async () => {
      const res = await deleteArticle(jsonReq('DELETE', '/api/articles/9999'), routeParams(9999));
      expect(res.status).toBe(404);
    });

    it('calls deletePdf and deletePdfImages with contentHash when deleting a PDF article', async () => {
      const db = dbMock.mock.db!;
      const contentHash = 'e'.repeat(64);

      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      db.update(articles)
        .set({ contentHash, originalFilePath: `/data/originals/${contentHash}.pdf` })
        .where(eq(articles.id, article.id))
        .run();

      mockDeletePdf.mockClear();
      mockDeletePdfImages.mockClear();

      const res = await deleteArticle(
        jsonReq('DELETE', `/api/articles/${article.id}`),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);

      expect(mockDeletePdf).toHaveBeenCalledWith(contentHash);
      expect(mockDeletePdfImages).toHaveBeenCalledWith(contentHash);
    });

    it('does not call deletePdf or deletePdfImages for non-PDF articles', async () => {
      const createRes = await createArticle(jsonReq('POST', '/api/articles', validArticle));
      const { article } = await createRes.json();

      mockDeletePdf.mockClear();
      mockDeletePdfImages.mockClear();

      await deleteArticle(
        jsonReq('DELETE', `/api/articles/${article.id}`),
        routeParams(article.id),
      );

      expect(mockDeletePdf).not.toHaveBeenCalled();
      expect(mockDeletePdfImages).not.toHaveBeenCalled();
    });
  });
});
