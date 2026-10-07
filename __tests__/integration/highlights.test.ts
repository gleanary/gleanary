import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { POST as createArticle } from '@/app/api/articles/route';
import { POST as createTag } from '@/app/api/tags/route';
import { GET as listHighlights, POST as createHighlight } from '@/app/api/highlights/route';
import {
  PATCH as updateHighlight,
  DELETE as deleteHighlight,
} from '@/app/api/highlights/[id]/route';

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

async function seedArticle() {
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

async function seedTag(name: string) {
  const res = await createTag(jsonReq('POST', '/api/tags', { name }));
  const body = await res.json();
  return body.tag;
}

describe('Highlights API', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  describe('POST /api/highlights', () => {
    it('creates a highlight with valid data', async () => {
      const article = await seedArticle();
      const res = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'This is highlighted text',
        }),
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.highlight.text).toBe('This is highlighted text');
      expect(body.highlight.color).toBe('yellow');
      expect(body.highlight.articleId).toBe(article.id);
    });

    it('creates a highlight with tags', async () => {
      const article = await seedArticle();
      const tag1 = await seedTag('important');
      const tag2 = await seedTag('review');

      const res = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'Tagged highlight',
          tagIds: [tag1.id, tag2.id],
        }),
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.highlight.tags).toHaveLength(2);
    });

    it('returns 422 for missing articleId', async () => {
      const res = await createHighlight(jsonReq('POST', '/api/highlights', { text: 'No article' }));
      expect(res.status).toBe(422);
    });

    it('returns 404 for nonexistent article', async () => {
      const res = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: 9999,
          text: 'Ghost article',
        }),
      );
      expect(res.status).toBe(404);
    });

    it('creates a highlight with note and color', async () => {
      const article = await seedArticle();
      const res = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'Important passage',
          note: 'Remember this',
          color: 'yellow',
        }),
      );
      const body = await res.json();
      expect(body.highlight.note).toBe('Remember this');
      expect(body.highlight.color).toBe('yellow');
    });
  });

  describe('GET /api/highlights', () => {
    beforeEach(async () => {
      const article = await seedArticle();
      await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'First highlight',
          color: 'yellow',
        }),
      );
      await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'Second highlight',
          color: 'yellow',
        }),
      );
    });

    it('returns all highlights with total count', async () => {
      const res = await listHighlights(jsonReq('GET', '/api/highlights'));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.highlights).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('filters by color', async () => {
      const res = await listHighlights(jsonReq('GET', '/api/highlights?color=yellow'));
      const body = await res.json();
      expect(body.highlights).toHaveLength(2);
      expect(body.highlights[0].color).toBe('yellow');
    });

    it('filters by articleId', async () => {
      const res = await listHighlights(jsonReq('GET', '/api/highlights?articleId=1'));
      const body = await res.json();
      expect(body.highlights).toHaveLength(2);
    });

    it('paginates with limit and offset', async () => {
      const res = await listHighlights(jsonReq('GET', '/api/highlights?limit=1&offset=0'));
      const body = await res.json();
      expect(body.highlights).toHaveLength(1);
      expect(body.total).toBe(2);
    });
  });

  describe('PATCH /api/highlights/[id]', () => {
    it('updates highlight note', async () => {
      const article = await seedArticle();
      const createRes = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'To update',
        }),
      );
      const { highlight } = await createRes.json();

      const res = await updateHighlight(
        jsonReq('PATCH', `/api/highlights/${highlight.id}`, { note: 'New note' }),
        routeParams(highlight.id),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.highlight.note).toBe('New note');
    });

    it('replaces highlight tags', async () => {
      const article = await seedArticle();
      const tag1 = await seedTag('old-tag');
      const tag2 = await seedTag('new-tag');

      const createRes = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'Tag test',
          tagIds: [tag1.id],
        }),
      );
      const { highlight } = await createRes.json();

      const res = await updateHighlight(
        jsonReq('PATCH', `/api/highlights/${highlight.id}`, { tagIds: [tag2.id] }),
        routeParams(highlight.id),
      );
      const body = await res.json();
      expect(body.highlight.tags).toHaveLength(1);
      expect(body.highlight.tags[0].id).toBe(tag2.id);
    });

    it('returns 404 for nonexistent highlight', async () => {
      const res = await updateHighlight(
        jsonReq('PATCH', '/api/highlights/9999', { note: 'Nope' }),
        routeParams(9999),
      );
      expect(res.status).toBe(404);
    });

    it('updates highlight text and positionData', async () => {
      const article = await seedArticle();
      const createRes = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'Original text',
          positionData: JSON.stringify({
            startContainerPath: [0, 0],
            startOffset: 0,
            endContainerPath: [0, 0],
            endOffset: 13,
            text: 'Original text',
          }),
        }),
      );
      const { highlight } = await createRes.json();

      const newPosData = JSON.stringify({
        startContainerPath: [0, 0],
        startOffset: 0,
        endContainerPath: [0, 0],
        endOffset: 20,
        text: 'Original text extend',
      });

      const res = await updateHighlight(
        jsonReq('PATCH', `/api/highlights/${highlight.id}`, {
          text: 'Original text extend',
          positionData: newPosData,
        }),
        routeParams(highlight.id),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.highlight.text).toBe('Original text extend');
      expect(body.highlight.positionData).toBe(newPosData);
    });

    it('returns 422 for empty body', async () => {
      const article = await seedArticle();
      const createRes = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'Test',
        }),
      );
      const { highlight } = await createRes.json();

      const res = await updateHighlight(
        jsonReq('PATCH', `/api/highlights/${highlight.id}`, {}),
        routeParams(highlight.id),
      );
      expect(res.status).toBe(422);
    });
  });

  describe('DELETE /api/highlights/[id]', () => {
    it('deletes a highlight', async () => {
      const article = await seedArticle();
      const createRes = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'To delete',
        }),
      );
      const { highlight } = await createRes.json();

      const res = await deleteHighlight(
        jsonReq('DELETE', `/api/highlights/${highlight.id}`),
        routeParams(highlight.id),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).deleted).toBe(true);
    });

    it('returns 404 for nonexistent highlight', async () => {
      const res = await deleteHighlight(
        jsonReq('DELETE', '/api/highlights/9999'),
        routeParams(9999),
      );
      expect(res.status).toBe(404);
    });
  });
});
