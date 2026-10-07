import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { POST as createArticle } from '@/app/api/articles/route';
import { GET as listHighlights } from '@/app/api/highlights/route';
import { POST as createHighlight } from '@/app/api/highlights/route';
import { POST as createTag, GET as listTags } from '@/app/api/tags/route';
import { POST as bulkDeleteHighlights } from '@/app/api/highlights/bulk-delete/route';
import { POST as bulkTagHighlights } from '@/app/api/highlights/bulk-tag/route';
import { PATCH as updateTag, DELETE as deleteTag } from '@/app/api/tags/[id]/route';
import { POST as createSource } from '@/app/api/sources/route';

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

async function seedArticle(overrides?: { url?: string; title?: string; sourceId?: number }) {
  const res = await createArticle(
    jsonReq('POST', '/api/articles', {
      url: overrides?.url ?? 'https://example.com/test',
      title: overrides?.title ?? 'Test Article',
      contentHtml: '<p>Test content</p>',
      contentText: 'Test content',
      sourceId: overrides?.sourceId,
    }),
  );
  const body = await res.json();
  return body.article;
}

async function seedTag(name: string, color?: string) {
  const res = await createTag(jsonReq('POST', '/api/tags', { name, color }));
  const body = await res.json();
  return body.tag;
}

async function seedHighlight(
  articleId: number,
  text: string,
  opts?: { color?: string; note?: string; tagIds?: number[] },
) {
  const res = await createHighlight(
    jsonReq('POST', '/api/highlights', {
      articleId,
      text,
      ...opts,
    }),
  );
  const body = await res.json();
  return body.highlight;
}

async function seedSource(name: string) {
  const res = await createSource(
    jsonReq('POST', '/api/sources', {
      type: 'manual',
      name,
    }),
  );
  const body = await res.json();
  return body.source;
}

describe('Highlight Library', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  describe('GET /api/highlights — enhanced with context', () => {
    it('returns article context and tags with each highlight', async () => {
      const tag = await seedTag('important');
      const article = await seedArticle({ title: 'My Article' });
      await seedHighlight(article.id, 'Some text', { tagIds: [tag.id] });

      const res = await listHighlights(jsonReq('GET', '/api/highlights'));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.highlights).toHaveLength(1);
      const h = body.highlights[0];
      expect(h.article).toBeDefined();
      expect(h.article.title).toBe('My Article');
      expect(h.tags).toHaveLength(1);
      expect(h.tags[0].name).toBe('important');
    });

    it('filters by sourceId', async () => {
      const source1 = await seedSource('Source A');
      const source2 = await seedSource('Source B');
      const article1 = await seedArticle({
        url: 'https://a.com/1',
        title: 'A1',
        sourceId: source1.id,
      });
      const article2 = await seedArticle({
        url: 'https://b.com/1',
        title: 'B1',
        sourceId: source2.id,
      });

      await seedHighlight(article1.id, 'From source A');
      await seedHighlight(article2.id, 'From source B');

      const res = await listHighlights(jsonReq('GET', `/api/highlights?sourceId=${source1.id}`));
      const body = await res.json();
      expect(body.highlights).toHaveLength(1);
      expect(body.highlights[0].text).toBe('From source A');
    });

    it('filters by date range (dateFrom and dateTo)', async () => {
      const article = await seedArticle();
      await seedHighlight(article.id, 'Old highlight');
      const newest = await seedHighlight(article.id, 'New highlight');

      // Derive "tomorrow" from the DB clock the highlights were stamped with
      // (createdAt defaults to SQLite datetime('now'), which vi.setSystemTime cannot
      // pin), not from the JS wall clock. This keeps the calendar boundary
      // self-consistent with the seeded rows so it cannot flake at midnight/timezone
      // edges where SQL-now and JS-now can land on different UTC dates.
      const seededMs = Date.parse(`${newest.createdAt.replace(' ', 'T')}Z`);
      // dateFrom = tomorrow should return none
      const tomorrow = new Date(seededMs + 86400000).toISOString().slice(0, 10);
      const res = await listHighlights(jsonReq('GET', `/api/highlights?dateFrom=${tomorrow}`));
      const body = await res.json();
      expect(body.highlights).toHaveLength(0);

      // dateTo = tomorrow should return all
      const resTomorrow = await listHighlights(
        jsonReq('GET', `/api/highlights?dateTo=${tomorrow}`),
      );
      const bodyTomorrow = await resTomorrow.json();
      expect(bodyTomorrow.highlights).toHaveLength(2);
    });
  });

  describe('POST /api/highlights/bulk-delete', () => {
    it('deletes multiple highlights', async () => {
      const article = await seedArticle();
      const h1 = await seedHighlight(article.id, 'First');
      const h2 = await seedHighlight(article.id, 'Second');
      const h3 = await seedHighlight(article.id, 'Third');

      const res = await bulkDeleteHighlights(
        jsonReq('POST', '/api/highlights/bulk-delete', {
          ids: [h1.id, h2.id],
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(2);

      // Verify h3 still exists
      const remaining = await listHighlights(jsonReq('GET', '/api/highlights'));
      const remainingBody = await remaining.json();
      expect(remainingBody.total).toBe(1);
      expect(remainingBody.highlights[0].id).toBe(h3.id);
    });

    it('skips nonexistent IDs and returns actual count', async () => {
      const article = await seedArticle();
      const h1 = await seedHighlight(article.id, 'Only one');

      const res = await bulkDeleteHighlights(
        jsonReq('POST', '/api/highlights/bulk-delete', {
          ids: [h1.id, 9999, 8888],
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
    });

    it('returns 422 for empty ids array', async () => {
      const res = await bulkDeleteHighlights(
        jsonReq('POST', '/api/highlights/bulk-delete', { ids: [] }),
      );
      expect(res.status).toBe(422);
    });

    it('returns 422 for more than 100 ids', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => i + 1);
      const res = await bulkDeleteHighlights(
        jsonReq('POST', '/api/highlights/bulk-delete', { ids }),
      );
      expect(res.status).toBe(422);
    });
  });

  describe('POST /api/highlights/bulk-tag', () => {
    it('adds tags to multiple highlights (add mode)', async () => {
      const article = await seedArticle();
      const tag1 = await seedTag('tag-a');
      const tag2 = await seedTag('tag-b');
      const h1 = await seedHighlight(article.id, 'H1', { tagIds: [tag1.id] });
      const h2 = await seedHighlight(article.id, 'H2');

      const res = await bulkTagHighlights(
        jsonReq('POST', '/api/highlights/bulk-tag', {
          ids: [h1.id, h2.id],
          tagIds: [tag2.id],
          mode: 'add',
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(2);

      // h1 should now have both tag-a and tag-b
      const h1Res = await listHighlights(jsonReq('GET', `/api/highlights?tagId=${tag1.id}`));
      const h1Body = await h1Res.json();
      expect(h1Body.highlights).toHaveLength(1);

      const h1Tag2Res = await listHighlights(jsonReq('GET', `/api/highlights?tagId=${tag2.id}`));
      const h1Tag2Body = await h1Tag2Res.json();
      expect(h1Tag2Body.highlights).toHaveLength(2);
    });

    it('replaces tags on multiple highlights (replace mode)', async () => {
      const article = await seedArticle();
      const tag1 = await seedTag('old-tag');
      const tag2 = await seedTag('new-tag');
      const h1 = await seedHighlight(article.id, 'H1', { tagIds: [tag1.id] });
      const h2 = await seedHighlight(article.id, 'H2', { tagIds: [tag1.id] });

      const res = await bulkTagHighlights(
        jsonReq('POST', '/api/highlights/bulk-tag', {
          ids: [h1.id, h2.id],
          tagIds: [tag2.id],
          mode: 'replace',
        }),
      );
      expect(res.status).toBe(200);

      // old-tag should have 0 highlights now
      const oldRes = await listHighlights(jsonReq('GET', `/api/highlights?tagId=${tag1.id}`));
      const oldBody = await oldRes.json();
      expect(oldBody.highlights).toHaveLength(0);

      // new-tag should have 2 highlights
      const newRes = await listHighlights(jsonReq('GET', `/api/highlights?tagId=${tag2.id}`));
      const newBody = await newRes.json();
      expect(newBody.highlights).toHaveLength(2);
    });

    it('returns 422 for empty ids', async () => {
      const res = await bulkTagHighlights(
        jsonReq('POST', '/api/highlights/bulk-tag', {
          ids: [],
          tagIds: [1],
          mode: 'add',
        }),
      );
      expect(res.status).toBe(422);
    });

    it('dedupes repeated tag ids instead of violating highlight_tags_unique', async () => {
      const article = await seedArticle();
      const tag = await seedTag('dup-tag');
      // Create path (linkHighlightTags) with a repeated tag id
      const h1 = await seedHighlight(article.id, 'H1', { tagIds: [tag.id, tag.id] });
      expect(h1).toBeDefined();

      // Replace mode with a repeated tag id
      const res = await bulkTagHighlights(
        jsonReq('POST', '/api/highlights/bulk-tag', {
          ids: [h1.id],
          tagIds: [tag.id, tag.id],
          mode: 'replace',
        }),
      );
      expect(res.status).toBe(200);

      const listRes = await listHighlights(jsonReq('GET', `/api/highlights?tagId=${tag.id}`));
      const listBody = await listRes.json();
      expect(listBody.highlights).toHaveLength(1);
      expect(listBody.highlights[0].tags).toHaveLength(1);
    });
  });

  describe('DELETE /api/tags/[id]', () => {
    it('deletes a tag', async () => {
      const tag = await seedTag('to-delete');

      const res = await deleteTag(jsonReq('DELETE', `/api/tags/${tag.id}`), routeParams(tag.id));
      expect(res.status).toBe(200);
      expect((await res.json()).deleted).toBe(true);

      // Verify it no longer appears in tag list
      const listRes = await listTags(jsonReq('GET', '/api/tags'));
      const listBody = await listRes.json();
      expect(listBody.tags).toHaveLength(0);
    });

    it('cascades to highlight_tags when tag is deleted', async () => {
      const tag = await seedTag('cascading');
      const article = await seedArticle();
      await seedHighlight(article.id, 'Tagged highlight', { tagIds: [tag.id] });

      // Delete the tag
      await deleteTag(jsonReq('DELETE', `/api/tags/${tag.id}`), routeParams(tag.id));

      // Highlight should still exist but have no tags
      const hlRes = await listHighlights(jsonReq('GET', '/api/highlights'));
      const hlBody = await hlRes.json();
      expect(hlBody.highlights).toHaveLength(1);
      expect(hlBody.highlights[0].tags).toHaveLength(0);
    });

    it('returns 404 for nonexistent tag', async () => {
      const res = await deleteTag(jsonReq('DELETE', '/api/tags/9999'), routeParams(9999));
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/tags/[id]', () => {
    it('updates tag name', async () => {
      const tag = await seedTag('old-name');

      const res = await updateTag(
        jsonReq('PATCH', `/api/tags/${tag.id}`, { name: 'new-name' }),
        routeParams(tag.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tag.name).toBe('new-name');
    });

    it('updates tag color', async () => {
      const tag = await seedTag('colored');

      const res = await updateTag(
        jsonReq('PATCH', `/api/tags/${tag.id}`, { color: '#FF0000' }),
        routeParams(tag.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tag.color).toBe('#FF0000');
    });

    it('clears tag color with null', async () => {
      const tag = await seedTag('has-color', '#00FF00');

      const res = await updateTag(
        jsonReq('PATCH', `/api/tags/${tag.id}`, { color: null }),
        routeParams(tag.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tag.color).toBeNull();
    });

    it('returns 409 for duplicate name', async () => {
      await seedTag('existing');
      const tag = await seedTag('to-rename');

      const res = await updateTag(
        jsonReq('PATCH', `/api/tags/${tag.id}`, { name: 'existing' }),
        routeParams(tag.id),
      );
      expect(res.status).toBe(409);
    });

    it('returns 404 for nonexistent tag', async () => {
      const res = await updateTag(
        jsonReq('PATCH', '/api/tags/9999', { name: 'ghost' }),
        routeParams(9999),
      );
      expect(res.status).toBe(404);
    });

    it('returns 422 for empty body', async () => {
      const tag = await seedTag('no-change');

      const res = await updateTag(jsonReq('PATCH', `/api/tags/${tag.id}`, {}), routeParams(tag.id));
      expect(res.status).toBe(422);
    });
  });
});
