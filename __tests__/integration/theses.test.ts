import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { POST as createArticle } from '@/app/api/articles/route';
import { POST as createHighlight } from '@/app/api/highlights/route';
import { GET as listTheses, POST as createThesis } from '@/app/api/theses/route';
import {
  GET as getThesis,
  PATCH as updateThesis,
  DELETE as deleteThesis,
} from '@/app/api/theses/[id]/route';
import { POST as linkHighlights } from '@/app/api/theses/[id]/highlights/route';
import { DELETE as unlinkHighlight } from '@/app/api/theses/[id]/highlights/[highlightId]/route';
import { POST as addResearch } from '@/app/api/theses/[id]/research/route';
import { DELETE as deleteResearch } from '@/app/api/theses/[id]/research/[researchId]/route';

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

function routeParamsTwo(first: string, firstVal: number, second: string, secondVal: number) {
  return { params: Promise.resolve({ [first]: String(firstVal), [second]: String(secondVal) }) };
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

async function seedHighlight(articleId: number, text = 'A highlight') {
  const res = await createHighlight(jsonReq('POST', '/api/highlights', { articleId, text }));
  const body = await res.json();
  return body.highlight;
}

describe('Theses API', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  // --- POST /api/theses ---

  describe('POST /api/theses', () => {
    it('creates a thesis with minimal data', async () => {
      const res = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'AI changes work not workers' }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.thesis.title).toBe('AI changes work not workers');
      expect(body.thesis.status).toBe('nascent');
      expect(body.thesis.id).toBeTypeOf('number');
    });

    it('creates a thesis with all fields', async () => {
      const res = await createThesis(
        jsonReq('POST', '/api/theses', {
          title: 'Full thesis',
          claim: 'A specific arguable claim',
          counterarguments: 'Smart skeptics would say...',
          implications: 'Therefore we should...',
          notes: 'Working notes',
          status: 'developing',
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.thesis.claim).toBe('A specific arguable claim');
      expect(body.thesis.status).toBe('developing');
    });

    it('rejects title shorter than 3 chars', async () => {
      const res = await createThesis(jsonReq('POST', '/api/theses', { title: 'AB' }));
      expect(res.status).toBe(422);
    });

    it('rejects invalid status value', async () => {
      const res = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Test', status: 'invalid' }),
      );
      expect(res.status).toBe(422);
    });
  });

  // --- GET /api/theses ---

  describe('GET /api/theses', () => {
    it('returns empty list when no theses exist', async () => {
      const res = await listTheses(new NextRequest('http://localhost:3000/api/theses'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.theses).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns all theses with highlight and research counts', async () => {
      await createThesis(jsonReq('POST', '/api/theses', { title: 'Thesis One' }));
      await createThesis(jsonReq('POST', '/api/theses', { title: 'Thesis Two', status: 'ready' }));

      const res = await listTheses(new NextRequest('http://localhost:3000/api/theses'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.theses).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.theses[0]).toHaveProperty('highlightCount');
      expect(body.theses[0]).toHaveProperty('researchCount');
    });

    it('filters by status', async () => {
      await createThesis(jsonReq('POST', '/api/theses', { title: 'Nascent one' }));
      await createThesis(jsonReq('POST', '/api/theses', { title: 'Ready one', status: 'ready' }));

      const res = await listTheses(
        new NextRequest('http://localhost:3000/api/theses?status=ready'),
      );
      const body = await res.json();
      expect(body.theses).toHaveLength(1);
      expect(body.theses[0].title).toBe('Ready one');
    });

    it('supports pagination', async () => {
      await createThesis(jsonReq('POST', '/api/theses', { title: 'Thesis A' }));
      await createThesis(jsonReq('POST', '/api/theses', { title: 'Thesis B' }));
      await createThesis(jsonReq('POST', '/api/theses', { title: 'Thesis C' }));

      const res = await listTheses(
        new NextRequest('http://localhost:3000/api/theses?limit=2&offset=0'),
      );
      const body = await res.json();
      expect(body.theses).toHaveLength(2);
      expect(body.total).toBe(3);
    });
  });

  // --- GET /api/theses/[id] ---

  describe('GET /api/theses/[id]', () => {
    it('returns thesis with highlights and research', async () => {
      const article = await seedArticle();
      const highlight = await seedHighlight(article.id);

      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Detail thesis' }),
      );
      const { thesis } = await createRes.json();

      await linkHighlights(
        jsonReq('POST', `/api/theses/${thesis.id}/highlights`, {
          highlightIds: [highlight.id],
          role: 'supporting',
        }),
        routeParams(thesis.id),
      );

      await addResearch(
        jsonReq('POST', `/api/theses/${thesis.id}/research`, {
          title: 'Research entry',
          content: '# Research\nSome findings',
          source: 'manual',
        }),
        routeParams(thesis.id),
      );

      const res = await getThesis(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}`),
        routeParams(thesis.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.thesis.title).toBe('Detail thesis');
      expect(body.highlights).toHaveLength(1);
      expect(body.highlights[0].role).toBe('supporting');
      expect(body.highlights[0].article).toBeDefined();
      expect(body.research).toHaveLength(1);
      expect(body.research[0].title).toBe('Research entry');
    });

    it('returns 404 for non-existent thesis', async () => {
      const res = await getThesis(
        new NextRequest('http://localhost:3000/api/theses/9999'),
        routeParams(9999),
      );
      expect(res.status).toBe(404);
    });
  });

  // --- PATCH /api/theses/[id] ---

  describe('PATCH /api/theses/[id]', () => {
    it('updates thesis fields', async () => {
      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Original title' }),
      );
      const { thesis } = await createRes.json();

      const res = await updateThesis(
        jsonReq('PATCH', `/api/theses/${thesis.id}`, {
          claim: 'A new claim',
          status: 'developing',
        }),
        routeParams(thesis.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.thesis.claim).toBe('A new claim');
      expect(body.thesis.status).toBe('developing');
    });

    it('auto-advances status nascent→developing when claim added', async () => {
      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Nascent thesis' }),
      );
      const { thesis } = await createRes.json();
      expect(thesis.status).toBe('nascent');

      const res = await updateThesis(
        jsonReq('PATCH', `/api/theses/${thesis.id}`, { claim: 'My claim' }),
        routeParams(thesis.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.thesis.status).toBe('developing');
    });

    it('does not auto-advance if status explicitly set', async () => {
      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Nascent thesis' }),
      );
      const { thesis } = await createRes.json();

      const res = await updateThesis(
        jsonReq('PATCH', `/api/theses/${thesis.id}`, {
          claim: 'My claim',
          status: 'nascent',
        }),
        routeParams(thesis.id),
      );
      const body = await res.json();
      expect(body.thesis.status).toBe('nascent');
    });

    it('returns 404 for non-existent thesis', async () => {
      const res = await updateThesis(
        jsonReq('PATCH', '/api/theses/9999', { title: 'Updated' }),
        routeParams(9999),
      );
      expect(res.status).toBe(404);
    });

    it('returns 422 when body is empty', async () => {
      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Test thesis' }),
      );
      const { thesis } = await createRes.json();

      const res = await updateThesis(
        jsonReq('PATCH', `/api/theses/${thesis.id}`, {}),
        routeParams(thesis.id),
      );
      expect(res.status).toBe(422);
    });
  });

  // --- DELETE /api/theses/[id] ---

  describe('DELETE /api/theses/[id]', () => {
    it('deletes a thesis', async () => {
      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'To be deleted' }),
      );
      const { thesis } = await createRes.json();

      const deleteRes = await deleteThesis(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}`, { method: 'DELETE' }),
        routeParams(thesis.id),
      );
      expect(deleteRes.status).toBe(200);
      const body = await deleteRes.json();
      expect(body.deleted).toBe(true);

      const getRes = await getThesis(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}`),
        routeParams(thesis.id),
      );
      expect(getRes.status).toBe(404);
    });

    it('returns 404 for non-existent thesis', async () => {
      const res = await deleteThesis(
        new NextRequest('http://localhost:3000/api/theses/9999', { method: 'DELETE' }),
        routeParams(9999),
      );
      expect(res.status).toBe(404);
    });
  });

  // --- POST /api/theses/[id]/highlights ---

  describe('POST /api/theses/[id]/highlights', () => {
    it('links highlights to a thesis', async () => {
      const article = await seedArticle();
      const h1 = await seedHighlight(article.id, 'First highlight');
      const h2 = await seedHighlight(article.id, 'Second highlight');

      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Evidence thesis' }),
      );
      const { thesis } = await createRes.json();

      const res = await linkHighlights(
        jsonReq('POST', `/api/theses/${thesis.id}/highlights`, {
          highlightIds: [h1.id, h2.id],
          role: 'supporting',
          note: 'Key evidence',
        }),
        routeParams(thesis.id),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.links).toHaveLength(2);
    });

    it('auto-advances status nascent→developing when first highlight linked', async () => {
      const article = await seedArticle();
      const highlight = await seedHighlight(article.id);

      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Nascent thesis' }),
      );
      const { thesis } = await createRes.json();
      expect(thesis.status).toBe('nascent');

      await linkHighlights(
        jsonReq('POST', `/api/theses/${thesis.id}/highlights`, {
          highlightIds: [highlight.id],
        }),
        routeParams(thesis.id),
      );

      const getRes = await getThesis(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}`),
        routeParams(thesis.id),
      );
      const body = await getRes.json();
      expect(body.thesis.status).toBe('developing');
    });

    it('returns 409 on duplicate link', async () => {
      const article = await seedArticle();
      const highlight = await seedHighlight(article.id);

      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Dedup thesis' }),
      );
      const { thesis } = await createRes.json();

      await linkHighlights(
        jsonReq('POST', `/api/theses/${thesis.id}/highlights`, {
          highlightIds: [highlight.id],
        }),
        routeParams(thesis.id),
      );

      const res = await linkHighlights(
        jsonReq('POST', `/api/theses/${thesis.id}/highlights`, {
          highlightIds: [highlight.id],
        }),
        routeParams(thesis.id),
      );
      expect(res.status).toBe(409);
    });

    it('returns 404 for non-existent thesis', async () => {
      const article = await seedArticle();
      const highlight = await seedHighlight(article.id);

      const res = await linkHighlights(
        jsonReq('POST', '/api/theses/9999/highlights', { highlightIds: [highlight.id] }),
        routeParams(9999),
      );
      expect(res.status).toBe(404);
    });
  });

  // --- DELETE /api/theses/[id]/highlights/[highlightId] ---

  describe('DELETE /api/theses/[id]/highlights/[highlightId]', () => {
    it('unlinks a highlight from a thesis', async () => {
      const article = await seedArticle();
      const highlight = await seedHighlight(article.id);

      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Unlink thesis' }),
      );
      const { thesis } = await createRes.json();

      await linkHighlights(
        jsonReq('POST', `/api/theses/${thesis.id}/highlights`, {
          highlightIds: [highlight.id],
        }),
        routeParams(thesis.id),
      );

      const res = await unlinkHighlight(
        new NextRequest(
          `http://localhost:3000/api/theses/${thesis.id}/highlights/${highlight.id}`,
          { method: 'DELETE' },
        ),
        routeParamsTwo('id', thesis.id, 'highlightId', highlight.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it('returns 404 when link does not exist', async () => {
      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Test thesis' }),
      );
      const { thesis } = await createRes.json();

      const res = await unlinkHighlight(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}/highlights/9999`, {
          method: 'DELETE',
        }),
        routeParamsTwo('id', thesis.id, 'highlightId', 9999),
      );
      expect(res.status).toBe(404);
    });
  });

  // --- POST /api/theses/[id]/research ---

  describe('POST /api/theses/[id]/research', () => {
    it('adds research to a thesis', async () => {
      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Research thesis' }),
      );
      const { thesis } = await createRes.json();

      const res = await addResearch(
        jsonReq('POST', `/api/theses/${thesis.id}/research`, {
          title: 'My research',
          content: '# Findings\nDetailed analysis...',
          source: 'manual',
        }),
        routeParams(thesis.id),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.research.title).toBe('My research');
      expect(body.research.thesisId).toBe(thesis.id);
    });

    it('auto-advances status developing→researched when first research added', async () => {
      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Dev thesis', status: 'developing' }),
      );
      const { thesis } = await createRes.json();
      expect(thesis.status).toBe('developing');

      await addResearch(
        jsonReq('POST', `/api/theses/${thesis.id}/research`, {
          title: 'First research',
          content: 'Some content',
        }),
        routeParams(thesis.id),
      );

      const getRes = await getThesis(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}`),
        routeParams(thesis.id),
      );
      const body = await getRes.json();
      expect(body.thesis.status).toBe('researched');
    });

    it('returns 404 for non-existent thesis', async () => {
      const res = await addResearch(
        jsonReq('POST', '/api/theses/9999/research', { title: 'R', content: 'C' }),
        routeParams(9999),
      );
      expect(res.status).toBe(404);
    });
  });

  // --- DELETE /api/theses/[id]/research/[researchId] ---

  describe('DELETE /api/theses/[id]/research/[researchId]', () => {
    it('removes a research entry', async () => {
      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', { title: 'Research thesis' }),
      );
      const { thesis } = await createRes.json();

      const addRes = await addResearch(
        jsonReq('POST', `/api/theses/${thesis.id}/research`, {
          title: 'To remove',
          content: 'Content',
        }),
        routeParams(thesis.id),
      );
      const { research } = await addRes.json();

      const res = await deleteResearch(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}/research/${research.id}`, {
          method: 'DELETE',
        }),
        routeParamsTwo('id', thesis.id, 'researchId', research.id),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).deleted).toBe(true);
    });

    it('returns 404 when research entry does not exist', async () => {
      const createRes = await createThesis(jsonReq('POST', '/api/theses', { title: 'Test' }));
      const { thesis } = await createRes.json();

      const res = await deleteResearch(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}/research/9999`, {
          method: 'DELETE',
        }),
        routeParamsTwo('id', thesis.id, 'researchId', 9999),
      );
      expect(res.status).toBe(404);
    });
  });
});
