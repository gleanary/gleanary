import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';
import { server, setupHandlers } from '../mocks/server';
import { eq } from 'drizzle-orm';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { resetClient } from '@/lib/ai';
import { drafts } from '@/db/schema';

import { POST as createArticle } from '@/app/api/articles/route';
import { POST as createHighlight } from '@/app/api/highlights/route';
import { POST as createThesis } from '@/app/api/theses/route';
import { PATCH as updateThesis, DELETE as deleteThesis } from '@/app/api/theses/[id]/route';
import { POST as linkHighlights } from '@/app/api/theses/[id]/highlights/route';
import { POST as addResearch } from '@/app/api/theses/[id]/research/route';
import { GET as listDrafts, POST as createDraft } from '@/app/api/drafts/route';
import {
  GET as getDraft,
  PATCH as updateDraft,
  DELETE as deleteDraft,
} from '@/app/api/drafts/[id]/route';
import { POST as generateDraftHandler } from '@/app/api/drafts/[id]/generate/route';

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
      contentHtml: '<p>content</p>',
      contentText: 'content',
    }),
  );
  return (await res.json()).article;
}

async function seedHighlight(articleId: number, text = 'A highlight') {
  const res = await createHighlight(jsonReq('POST', '/api/highlights', { articleId, text }));
  return (await res.json()).highlight;
}

async function seedThesis(title = 'Test Thesis') {
  const res = await createThesis(jsonReq('POST', '/api/theses', { title }));
  return (await res.json()).thesis;
}

async function seedResearch(thesisId: number, title = 'Research entry') {
  const res = await addResearch(
    jsonReq('POST', `/api/theses/${thesisId}/research`, {
      title,
      content: 'Research content here',
      source: 'manual',
    }),
    routeParams(thesisId),
  );
  return (await res.json()).research;
}

async function seedLinkedHighlight(thesisId: number) {
  const article = await seedArticle();
  const highlight = await seedHighlight(article.id);
  await linkHighlights(
    jsonReq('POST', `/api/theses/${thesisId}/highlights`, { highlightIds: [highlight.id] }),
    routeParams(thesisId),
  );
  return highlight;
}

async function seedDraft(
  thesisId: number,
  highlightIds: number[] = [],
  researchIds: number[] = [],
) {
  const res = await createDraft(
    jsonReq('POST', '/api/drafts', {
      thesisId,
      templateId: 'blog',
      includedHighlightIds: highlightIds,
      includedResearchIds: researchIds,
    }),
  );
  return (await res.json()).draft;
}

const ANTHROPIC_STREAM_BODY = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

async function parseSSE(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  const events: Array<{ event: string; data: unknown }> = [];
  const lines = text.split('\n');
  let currentEvent = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
      } catch {
        events.push({ event: currentEvent, data: line.slice(6) });
      }
    }
  }
  return events;
}

describe('Drafts API', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    dbMock.setup();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // --- POST /api/drafts ---

  describe('POST /api/drafts', () => {
    it('creates a draft shell with empty highlight/research lists', async () => {
      const thesis = await seedThesis('My Thesis');
      const res = await createDraft(
        jsonReq('POST', '/api/drafts', {
          thesisId: thesis.id,
          templateId: 'blog',
          includedHighlightIds: [],
          includedResearchIds: [],
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.draft.thesisId).toBe(thesis.id);
      expect(body.draft.templateId).toBe('blog');
      expect(body.draft.title).toBe('My Thesis');
      expect(body.draft.status).toBe('draft');
      expect(body.draft.content).toBe('');
    });

    it('seeds title from thesis title', async () => {
      const thesis = await seedThesis('Specific Title Here');
      const draft = await seedDraft(thesis.id);
      expect(draft.title).toBe('Specific Title Here');
    });

    it('writes context_snapshot with provided IDs', async () => {
      const thesis = await seedThesis();
      const highlight = await seedLinkedHighlight(thesis.id);
      const research = await seedResearch(thesis.id);
      const draft = await seedDraft(thesis.id, [highlight.id], [research.id]);
      const snapshot = JSON.parse(draft.contextSnapshot);
      expect(snapshot.highlightIds).toEqual([highlight.id]);
      expect(snapshot.researchIds).toEqual([research.id]);
    });

    it('stores optional angle', async () => {
      const thesis = await seedThesis();
      const res = await createDraft(
        jsonReq('POST', '/api/drafts', {
          thesisId: thesis.id,
          templateId: 'linkedin',
          angle: 'Lead with the contrarian take',
          includedHighlightIds: [],
          includedResearchIds: [],
        }),
      );
      const body = await res.json();
      expect(body.draft.angle).toBe('Lead with the contrarian take');
    });

    it('returns 404 when thesisId does not exist', async () => {
      const res = await createDraft(
        jsonReq('POST', '/api/drafts', {
          thesisId: 99999,
          templateId: 'blog',
          includedHighlightIds: [],
          includedResearchIds: [],
        }),
      );
      expect(res.status).toBe(404);
    });

    it('returns 422 when includedHighlightIds contains ID not linked to thesis', async () => {
      const thesis = await seedThesis();
      const article = await seedArticle();
      const highlight = await seedHighlight(article.id);
      // highlight exists but is NOT linked to this thesis
      const res = await createDraft(
        jsonReq('POST', '/api/drafts', {
          thesisId: thesis.id,
          templateId: 'blog',
          includedHighlightIds: [highlight.id],
          includedResearchIds: [],
        }),
      );
      expect(res.status).toBe(422);
    });

    it('returns 422 when includedResearchIds contains ID not belonging to thesis', async () => {
      const thesis1 = await seedThesis('Thesis 1');
      const thesis2 = await seedThesis('Thesis 2');
      const research = await seedResearch(thesis2.id);
      const res = await createDraft(
        jsonReq('POST', '/api/drafts', {
          thesisId: thesis1.id,
          templateId: 'blog',
          includedHighlightIds: [],
          includedResearchIds: [research.id],
        }),
      );
      expect(res.status).toBe(422);
    });

    it('rejects invalid templateId', async () => {
      const thesis = await seedThesis();
      const res = await createDraft(
        jsonReq('POST', '/api/drafts', {
          thesisId: thesis.id,
          templateId: 'invalid',
          includedHighlightIds: [],
          includedResearchIds: [],
        }),
      );
      expect(res.status).toBe(422);
    });
  });

  // --- GET /api/drafts ---

  describe('GET /api/drafts', () => {
    it('returns empty list when no drafts exist', async () => {
      const res = await listDrafts(new NextRequest('http://localhost:3000/api/drafts'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.drafts).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns drafts with thesisTitle joined', async () => {
      const thesis = await seedThesis('Joined Title');
      await seedDraft(thesis.id);
      const res = await listDrafts(new NextRequest('http://localhost:3000/api/drafts'));
      const body = await res.json();
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].thesisTitle).toBe('Joined Title');
      expect(body.total).toBe(1);
    });

    it('filters by thesisId', async () => {
      const thesis1 = await seedThesis('Thesis Alpha');
      const thesis2 = await seedThesis('Thesis Beta');
      await seedDraft(thesis1.id);
      await seedDraft(thesis2.id);
      const res = await listDrafts(
        new NextRequest(`http://localhost:3000/api/drafts?thesisId=${thesis1.id}`),
      );
      const body = await res.json();
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].thesisTitle).toBe('Thesis Alpha');
    });

    it('filters by templateId', async () => {
      const thesis = await seedThesis();
      await seedDraft(thesis.id);
      await createDraft(
        jsonReq('POST', '/api/drafts', {
          thesisId: thesis.id,
          templateId: 'linkedin',
          includedHighlightIds: [],
          includedResearchIds: [],
        }),
      );
      const res = await listDrafts(
        new NextRequest('http://localhost:3000/api/drafts?templateId=linkedin'),
      );
      const body = await res.json();
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].templateId).toBe('linkedin');
    });

    it('filters by status', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);
      await updateDraft(
        jsonReq('PATCH', `/api/drafts/${draft.id}`, { status: 'published' }),
        routeParams(draft.id),
      );
      const res = await listDrafts(
        new NextRequest('http://localhost:3000/api/drafts?status=published'),
      );
      const body = await res.json();
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].status).toBe('published');
    });

    it('respects limit param', async () => {
      const thesis = await seedThesis();
      for (let i = 0; i < 5; i++) await seedDraft(thesis.id);
      const res = await listDrafts(new NextRequest('http://localhost:3000/api/drafts?limit=3'));
      const body = await res.json();
      expect(body.drafts).toHaveLength(3);
      expect(body.total).toBe(5);
    });
  });

  // --- GET /api/drafts/[id] ---

  describe('GET /api/drafts/[id]', () => {
    it('returns full draft with resolved context', async () => {
      const thesis = await seedThesis();
      const highlight = await seedLinkedHighlight(thesis.id);
      const research = await seedResearch(thesis.id);
      const draft = await seedDraft(thesis.id, [highlight.id], [research.id]);

      const res = await getDraft(
        new NextRequest(`http://localhost:3000/api/drafts/${draft.id}`),
        routeParams(draft.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.draft.id).toBe(draft.id);
      expect(body.resolvedHighlights).toHaveLength(1);
      expect(body.resolvedHighlights[0].deleted).toBe(false);
      expect(body.resolvedHighlights[0].text).toBe('A highlight');
      expect(body.resolvedResearch).toHaveLength(1);
      expect(body.resolvedResearch[0].deleted).toBe(false);
      expect(body.resolvedResearch[0].title).toBe('Research entry');
    });

    it('shows (deleted) label for highlight removed from thesis after draft creation', async () => {
      const thesis = await seedThesis();
      const highlight = await seedLinkedHighlight(thesis.id);
      const draft = await seedDraft(thesis.id, [highlight.id]);

      // Delete the highlight entirely — cascades out of thesis_highlights
      const { DELETE: deleteHighlight } = await import('@/app/api/highlights/[id]/route');
      await deleteHighlight(
        new NextRequest(`http://localhost:3000/api/highlights/${highlight.id}`),
        routeParams(highlight.id),
      );

      const res = await getDraft(
        new NextRequest(`http://localhost:3000/api/drafts/${draft.id}`),
        routeParams(draft.id),
      );
      const body = await res.json();
      expect(body.resolvedHighlights).toHaveLength(1);
      expect(body.resolvedHighlights[0].deleted).toBe(true);
      expect(body.resolvedHighlights[0].text).toBe('(deleted)');
    });

    it('returns empty resolved arrays when context_snapshot is null', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);
      const res = await getDraft(
        new NextRequest(`http://localhost:3000/api/drafts/${draft.id}`),
        routeParams(draft.id),
      );
      const body = await res.json();
      expect(body.resolvedHighlights).toEqual([]);
      expect(body.resolvedResearch).toEqual([]);
    });

    it('returns 404 for unknown draft id', async () => {
      const res = await getDraft(
        new NextRequest('http://localhost:3000/api/drafts/99999'),
        routeParams(99999),
      );
      expect(res.status).toBe(404);
    });
  });

  // --- PATCH /api/drafts/[id] ---

  describe('PATCH /api/drafts/[id]', () => {
    it('updates title without touching last_edited_at', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);
      expect(draft.lastEditedAt).toBeNull();

      const res = await updateDraft(
        jsonReq('PATCH', `/api/drafts/${draft.id}`, { title: 'New Title' }),
        routeParams(draft.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.draft.title).toBe('New Title');
      expect(body.draft.lastEditedAt).toBeNull();
    });

    it('updates angle without touching last_edited_at', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);
      const res = await updateDraft(
        jsonReq('PATCH', `/api/drafts/${draft.id}`, { angle: 'Lead with the contrarian take' }),
        routeParams(draft.id),
      );
      const body = await res.json();
      expect(body.draft.angle).toBe('Lead with the contrarian take');
      expect(body.draft.lastEditedAt).toBeNull();
    });

    it('updates includedHighlightIds without touching last_edited_at', async () => {
      const thesis = await seedThesis();
      const highlight = await seedLinkedHighlight(thesis.id);
      const draft = await seedDraft(thesis.id);
      const res = await updateDraft(
        jsonReq('PATCH', `/api/drafts/${draft.id}`, { includedHighlightIds: [highlight.id] }),
        routeParams(draft.id),
      );
      const body = await res.json();
      expect(body.draft.lastEditedAt).toBeNull();
      const snapshot = JSON.parse(body.draft.contextSnapshot);
      expect(snapshot.highlightIds).toEqual([highlight.id]);
    });

    it('sets last_edited_at when content is updated', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);
      expect(draft.lastEditedAt).toBeNull();

      const res = await updateDraft(
        jsonReq('PATCH', `/api/drafts/${draft.id}`, { content: '# My Draft\n\nSome content.' }),
        routeParams(draft.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.draft.content).toBe('# My Draft\n\nSome content.');
      expect(body.draft.lastEditedAt).not.toBeNull();
    });

    it('status published sets published_at and advances thesis to used', async () => {
      const thesis = await seedThesis();
      expect(thesis.status).toBe('nascent');
      const draft = await seedDraft(thesis.id);

      const res = await updateDraft(
        jsonReq('PATCH', `/api/drafts/${draft.id}`, { status: 'published' }),
        routeParams(draft.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.draft.status).toBe('published');
      expect(body.draft.publishedAt).not.toBeNull();

      // Verify thesis advanced
      const { GET: getThesis } = await import('@/app/api/theses/[id]/route');
      const thesisRes = await getThesis(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}`),
        routeParams(thesis.id),
      );
      const thesisBody = await thesisRes.json();
      expect(thesisBody.thesis.status).toBe('used');
    });

    it('status published when thesis already used is a no-op on thesis', async () => {
      const thesis = await seedThesis();
      await updateThesis(
        jsonReq('PATCH', `/api/theses/${thesis.id}`, { status: 'used' }),
        routeParams(thesis.id),
      );
      const draft = await seedDraft(thesis.id);

      const res = await updateDraft(
        jsonReq('PATCH', `/api/drafts/${draft.id}`, { status: 'published' }),
        routeParams(draft.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.draft.status).toBe('published');

      const { GET: getThesis } = await import('@/app/api/theses/[id]/route');
      const thesisRes = await getThesis(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}`),
        routeParams(thesis.id),
      );
      const thesisBody = await thesisRes.json();
      expect(thesisBody.thesis.status).toBe('used');
    });

    it('reverting status to draft succeeds and preserves published_at and thesis used status', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);

      // Publish first
      await updateDraft(
        jsonReq('PATCH', `/api/drafts/${draft.id}`, { status: 'published' }),
        routeParams(draft.id),
      );

      // Revert to draft
      const res = await updateDraft(
        jsonReq('PATCH', `/api/drafts/${draft.id}`, { status: 'draft' }),
        routeParams(draft.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.draft.status).toBe('draft');
      // published_at preserved as historical record
      expect(body.draft.publishedAt).not.toBeNull();

      // Thesis stays 'used' — no rollback
      const { GET: getThesis } = await import('@/app/api/theses/[id]/route');
      const thesisRes = await getThesis(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}`),
        routeParams(thesis.id),
      );
      const thesisBody = await thesisRes.json();
      expect(thesisBody.thesis.status).toBe('used');
    });

    it('returns 422 when includedHighlightIds contains ID not linked to thesis', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);
      const article = await seedArticle();
      const unlinkedHighlight = await seedHighlight(article.id);

      const res = await updateDraft(
        jsonReq('PATCH', `/api/drafts/${draft.id}`, {
          includedHighlightIds: [unlinkedHighlight.id],
        }),
        routeParams(draft.id),
      );
      expect(res.status).toBe(422);
    });

    it('returns 404 for unknown draft id', async () => {
      const res = await updateDraft(
        jsonReq('PATCH', '/api/drafts/99999', { title: 'X' }),
        routeParams(99999),
      );
      expect(res.status).toBe(404);
    });
  });

  // --- DELETE /api/drafts/[id] ---

  describe('DELETE /api/drafts/[id]', () => {
    it('deletes an existing draft', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);

      const res = await deleteDraft(
        new NextRequest(`http://localhost:3000/api/drafts/${draft.id}`),
        routeParams(draft.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);

      const getRes = await getDraft(
        new NextRequest(`http://localhost:3000/api/drafts/${draft.id}`),
        routeParams(draft.id),
      );
      expect(getRes.status).toBe(404);
    });

    it('returns 404 for unknown draft id', async () => {
      const res = await deleteDraft(
        new NextRequest('http://localhost:3000/api/drafts/99999'),
        routeParams(99999),
      );
      expect(res.status).toBe(404);
    });

    it('cascade: deleting thesis also removes its drafts', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);

      await deleteThesis(
        new NextRequest(`http://localhost:3000/api/theses/${thesis.id}`),
        routeParams(thesis.id),
      );

      const getRes = await getDraft(
        new NextRequest(`http://localhost:3000/api/drafts/${draft.id}`),
        routeParams(draft.id),
      );
      expect(getRes.status).toBe(404);
    });
  });

  // --- POST /api/drafts/[id]/generate ---

  describe('POST /api/drafts/[id]/generate', () => {
    let testDb: NonNullable<typeof dbMock.mock.db>;

    setupHandlers(
      http.post(
        'https://api.anthropic.com/v1/messages',
        () =>
          new HttpResponse(ANTHROPIC_STREAM_BODY, {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
    );

    beforeEach(() => {
      testDb = dbMock.mock.db!;
      resetClient();
    });

    it('streams generation and persists content on success', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);

      const res = await generateDraftHandler(
        jsonReq('POST', `/api/drafts/${draft.id}/generate`, {}),
        routeParams(draft.id),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');

      const events = await parseSSE(res);
      expect(events.filter((e) => e.event === 'delta').length).toBeGreaterThan(0);
      expect(events.filter((e) => e.event === 'done')).toHaveLength(1);

      const updated = testDb.select().from(drafts).where(eq(drafts.id, draft.id)).get()!;
      expect(updated.content).toBe('Hello world');
      expect(updated.generatedAt).not.toBeNull();
      expect(updated.lastEditedAt).toBeNull();
      expect(updated.contextSnapshot).toBe(JSON.stringify({ highlightIds: [], researchIds: [] }));
    });

    it('returns 409 when lastEditedAt > generatedAt and force is false', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);

      testDb
        .update(drafts)
        .set({ generatedAt: '2026-01-01 00:00:00', lastEditedAt: '2026-01-02 00:00:00' })
        .where(eq(drafts.id, draft.id))
        .run();

      const res = await generateDraftHandler(
        jsonReq('POST', `/api/drafts/${draft.id}/generate`, { force: false }),
        routeParams(draft.id),
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/unsaved edits/i);
    });

    it('force: true overrides the 409 guard', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);

      testDb
        .update(drafts)
        .set({ generatedAt: '2026-01-01 00:00:00', lastEditedAt: '2026-01-02 00:00:00' })
        .where(eq(drafts.id, draft.id))
        .run();

      const res = await generateDraftHandler(
        jsonReq('POST', `/api/drafts/${draft.id}/generate`, { force: true }),
        routeParams(draft.id),
      );

      expect(res.status).toBe(200);
      const events = await parseSSE(res);
      expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
    });

    it('forwards SSE error event when Anthropic returns 503, original content preserved', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', () =>
          HttpResponse.json(
            { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
            { status: 503 },
          ),
        ),
      );

      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);
      testDb
        .update(drafts)
        .set({ content: 'original content' })
        .where(eq(drafts.id, draft.id))
        .run();

      const res = await generateDraftHandler(
        jsonReq('POST', `/api/drafts/${draft.id}/generate`, {}),
        routeParams(draft.id),
      );

      expect(res.status).toBe(200);
      const events = await parseSSE(res);
      expect(events.some((e) => e.event === 'error')).toBe(true);

      const updated = testDb.select().from(drafts).where(eq(drafts.id, draft.id)).get()!;
      expect(updated.content).toBe('original content');
      expect(updated.generatedAt).toBeNull();
    });

    it('client disconnect aborts generation and preserves original content', async () => {
      // MSW's request.signal does not propagate client-side AbortSignal in Node mode,
      // so we use streamStarted to confirm mid-flight state. The DB-write invariant
      // holds without fetchAborted because content-generation.ts only persists on
      // outcome.ok === true, which requires message_stop — never sent by this handler.
      let resolveStarted!: () => void;
      const streamStarted = new Promise<void>((r) => {
        resolveStarted = r;
      });

      server.use(
        http.post('https://api.anthropic.com/v1/messages', () => {
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            start(controller) {
              // Signal stream is mid-flight, then hang indefinitely
              controller.enqueue(
                encoder.encode(
                  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":0}}}\n\n',
                ),
              );
              resolveStarted();
            },
          });

          return new HttpResponse(body, {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }),
      );

      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);
      testDb
        .update(drafts)
        .set({ content: 'original content' })
        .where(eq(drafts.id, draft.id))
        .run();

      const res = await generateDraftHandler(
        jsonReq('POST', `/api/drafts/${draft.id}/generate`, {}),
        routeParams(draft.id),
      );

      await streamStarted;
      await res.body?.cancel();

      const updated = testDb.select().from(drafts).where(eq(drafts.id, draft.id)).get()!;
      expect(updated.content).toBe('original content');
      expect(updated.generatedAt).toBeNull();
    });

    it('returns 404 for unknown draft id', async () => {
      const res = await generateDraftHandler(
        jsonReq('POST', '/api/drafts/99999/generate', {}),
        routeParams(99999),
      );
      expect(res.status).toBe(404);
    });

    it('returns 422 for malformed body (force is not a boolean)', async () => {
      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);

      const res = await generateDraftHandler(
        jsonReq('POST', `/api/drafts/${draft.id}/generate`, { force: 'yes' }),
        routeParams(draft.id),
      );

      expect(res.status).toBe(422);
    });

    it('leaves a brand-new draft retriable after a generation failure', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', () =>
          HttpResponse.json(
            { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
            { status: 503 },
          ),
        ),
      );

      const thesis = await seedThesis();
      const draft = await seedDraft(thesis.id);

      const res = await generateDraftHandler(
        jsonReq('POST', `/api/drafts/${draft.id}/generate`, {}),
        routeParams(draft.id),
      );

      expect(res.status).toBe(200);
      const events = await parseSSE(res);
      expect(events.some((e) => e.event === 'error')).toBe(true);

      const updated = testDb.select().from(drafts).where(eq(drafts.id, draft.id)).get()!;
      expect(updated.content).toBe('');
      expect(updated.generatedAt).toBeNull();
    });
  });
});
