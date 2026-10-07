import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { GET as listTags, POST as createTag } from '@/app/api/tags/route';
import { POST as createArticle } from '@/app/api/articles/route';
import { POST as createHighlight } from '@/app/api/highlights/route';

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

describe('Tags API', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  describe('POST /api/tags', () => {
    it('creates a tag', async () => {
      const res = await createTag(jsonReq('POST', '/api/tags', { name: 'important' }));
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.tag.name).toBe('important');
      expect(body.tag.id).toBeDefined();
    });

    it('creates a tag with color', async () => {
      const res = await createTag(
        jsonReq('POST', '/api/tags', { name: 'highlight', color: '#FF5733' }),
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.tag.color).toBe('#FF5733');
    });

    it('returns 422 for empty name', async () => {
      const res = await createTag(jsonReq('POST', '/api/tags', { name: '' }));
      expect(res.status).toBe(422);
    });

    it('returns 422 for invalid color format', async () => {
      const res = await createTag(
        jsonReq('POST', '/api/tags', { name: 'bad-color', color: 'red' }),
      );
      expect(res.status).toBe(422);
    });

    it('returns 409 for duplicate name', async () => {
      await createTag(jsonReq('POST', '/api/tags', { name: 'unique' }));
      const res = await createTag(jsonReq('POST', '/api/tags', { name: 'unique' }));
      expect(res.status).toBe(409);
    });
  });

  describe('GET /api/tags', () => {
    it('returns empty list initially', async () => {
      const res = await listTags(jsonReq('GET', '/api/tags'));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.tags).toEqual([]);
    });

    it('returns all tags', async () => {
      await createTag(jsonReq('POST', '/api/tags', { name: 'tag1' }));
      await createTag(jsonReq('POST', '/api/tags', { name: 'tag2' }));

      const res = await listTags(jsonReq('GET', '/api/tags'));
      const body = await res.json();
      expect(body.tags).toHaveLength(2);
    });

    it('includes highlight count', async () => {
      // Create tag, article, and highlight with tag
      const tagRes = await createTag(jsonReq('POST', '/api/tags', { name: 'counted' }));
      const { tag } = await tagRes.json();

      const articleRes = await createArticle(
        jsonReq('POST', '/api/articles', {
          url: 'https://example.com/count-test',
          title: 'Count Test',
        }),
      );
      const { article } = await articleRes.json();

      await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'Tagged highlight',
          tagIds: [tag.id],
        }),
      );

      const res = await listTags(jsonReq('GET', '/api/tags'));
      const body = await res.json();
      expect(body.tags[0].highlightCount).toBe(1);
    });
  });
});
