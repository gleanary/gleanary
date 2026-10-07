import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { articles, drafts } from '@/db/schema';

import { POST as createArticle } from '@/app/api/articles/route';
import { POST as createSource } from '@/app/api/sources/route';
import { POST as createHighlight } from '@/app/api/highlights/route';
import { POST as createThesis } from '@/app/api/theses/route';
import { GET as search } from '@/app/api/search/route';
import { POST as createDraftApi } from '@/app/api/drafts/route';
import { PATCH as updateDraftApi, DELETE as deleteDraftApi } from '@/app/api/drafts/[id]/route';

// db is typed as the drizzle instance from createTestDb
let db: NonNullable<typeof dbMock.mock.db>;

function getReq(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

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

let counter = 0;
function uid() {
  return `t${++counter}`;
}

async function seedArticle(
  overrides: {
    title?: string;
    contentText?: string;
    sourceId?: number;
  } = {},
) {
  const res = await createArticle(
    jsonReq('POST', '/api/articles', {
      url: `https://example.com/article-${uid()}`,
      title: overrides.title ?? 'Test Article',
      contentText: overrides.contentText ?? 'some content',
      ...(overrides.sourceId ? { sourceId: overrides.sourceId } : {}),
    }),
  );
  return (await res.json()).article as { id: number; title: string; status: string };
}

async function seedSource(name: string) {
  const res = await createSource(jsonReq('POST', '/api/sources', { type: 'manual', name }));
  return (await res.json()).source as { id: number };
}

async function seedHighlight(articleId: number, text: string, note?: string) {
  const res = await createHighlight(
    jsonReq('POST', '/api/highlights', { articleId, text, ...(note ? { note } : {}) }),
  );
  return (await res.json()).highlight as { id: number };
}

async function seedThesis(title: string, claim?: string) {
  const res = await createThesis(
    jsonReq('POST', '/api/theses', { title, ...(claim ? { claim } : {}) }),
  );
  return (await res.json()).thesis as { id: number; title: string };
}

async function seedDraft(thesisId: number, titleOverride?: string) {
  const res = await createDraftApi(
    jsonReq('POST', '/api/drafts', {
      thesisId,
      templateId: 'blog',
      includedHighlightIds: [],
      includedResearchIds: [],
    }),
  );
  const draft = (await res.json()).draft as { id: number; title: string };
  if (titleOverride) {
    await updateDraftApi(
      jsonReq('PATCH', `/api/drafts/${draft.id}`, { title: titleOverride }),
      routeParams(draft.id),
    );
    return { ...draft, title: titleOverride };
  }
  return draft;
}

describe('GET /api/search (global search)', () => {
  beforeEach(() => {
    const testDb = dbMock.setup();
    db = testDb.db;
  });

  // --- Validation ---

  it('returns 422 when q is missing', async () => {
    const res = await search(getReq('/api/search'));
    expect(res.status).toBe(422);
  });

  it('returns 422 when q is 1 char', async () => {
    const res = await search(getReq('/api/search?q=a'));
    expect(res.status).toBe(422);
  });

  it('returns 422 for an invalid types value', async () => {
    const res = await search(getReq('/api/search?q=hello&types=invalid'));
    expect(res.status).toBe(422);
  });

  it('returns 422 for a partially invalid types CSV', async () => {
    const res = await search(getReq('/api/search?q=hello&types=article,bogus'));
    expect(res.status).toBe(422);
  });

  // --- Empty query after escaping ---

  it('returns 200 with empty results when query escapes to empty string', async () => {
    const res = await search(getReq('/api/search?q=**'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.articles).toHaveLength(0);
    expect(body.totals.article).toBe(0);
  });

  // --- Quote-containing query safety ---

  it('returns 200 (not 500) for a quote-containing query in palette mode', async () => {
    // escapeFts5Query('neural"') → 'neural""'; applyPrefixStar → 'neural""*'
    // FTS5 must handle this without a syntax error
    const res = await search(getReq('/api/search?q=neural"&mode=palette'));
    expect(res.status).toBe(200);
  });

  // --- Article search ---

  it('finds articles by title', async () => {
    await seedArticle({
      title: 'Photosynthesis in Deep Sea Plants',
      contentText: 'chlorophyll content here',
    });
    const res = await search(getReq('/api/search?q=Photosynthesis&types=article'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.articles.length).toBeGreaterThanOrEqual(1);
    expect(body.results.articles[0].title).toContain('Photosynthesis');
  });

  it('finds articles by content', async () => {
    await seedArticle({
      title: 'Unrelated Title',
      contentText: 'bioluminescence deep ocean unique818',
    });
    const res = await search(getReq('/api/search?q=bioluminescence&types=article'));
    const body = await res.json();
    expect(body.results.articles.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes pending_review articles', async () => {
    const article = await seedArticle({ title: 'Pending Review xyzpending99' });
    // pending_review is not a valid status via the public API, so set it directly
    db.update(articles).set({ status: 'pending_review' }).where(eq(articles.id, article.id)).run();
    // FTS still has the row; the SQL WHERE clause must filter it out
    const res = await search(getReq('/api/search?q=xyzpending99&types=article'));
    const body = await res.json();
    expect(body.results.articles).toHaveLength(0);
    expect(body.totals.article).toBe(0);
  });

  it('status filter returns articles with matching status', async () => {
    await seedArticle({ title: 'Inbox article quantumwaveuniq5' });
    const res = await search(getReq('/api/search?q=quantumwaveuniq5&types=article&status=inbox'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.articles.length).toBeGreaterThanOrEqual(1);
  });

  it('status filter excludes articles with non-matching status', async () => {
    await seedArticle({ title: 'Inbox article wormhole4299' });
    const res = await search(getReq('/api/search?q=wormhole4299&types=article&status=archived'));
    const body = await res.json();
    expect(body.results.articles).toHaveLength(0);
  });

  it('status filter does not affect highlight results', async () => {
    const article = await seedArticle({ title: 'Host Article' });
    await seedHighlight(article.id, 'Nebula formation process uniqstathl6');
    // Article doesn't match, but highlight should still be returned regardless of status filter
    const res = await search(
      getReq('/api/search?q=uniqstathl6&types=article,highlight&status=archived'),
    );
    const body = await res.json();
    expect(body.results.highlights.length).toBeGreaterThanOrEqual(1);
  });

  // --- Highlight search ---

  it('finds highlights by text', async () => {
    const article = await seedArticle({ title: 'Host Article' });
    await seedHighlight(article.id, 'Mitochondria powerhouse cell uniquehl77');
    const res = await search(getReq('/api/search?q=Mitochondria&types=highlight'));
    const body = await res.json();
    expect(body.results.highlights.length).toBeGreaterThanOrEqual(1);
    expect(body.results.highlights[0].articleTitle).toBe('Host Article');
  });

  it('finds highlights by note', async () => {
    const article = await seedArticle({ title: 'Host Article' });
    await seedHighlight(article.id, 'some text content', 'fermentation process note uniquehl88');
    const res = await search(getReq('/api/search?q=fermentation&types=highlight'));
    const body = await res.json();
    expect(body.results.highlights.length).toBeGreaterThanOrEqual(1);
  });

  // --- Thesis search ---

  it('finds theses by title', async () => {
    await seedThesis('Neuroplasticity shapes learning uniqueth55');
    const res = await search(getReq('/api/search?q=Neuroplasticity&types=thesis'));
    const body = await res.json();
    expect(body.results.theses.length).toBeGreaterThanOrEqual(1);
    expect(body.results.theses[0].title).toContain('Neuroplasticity');
  });

  it('finds theses by claim', async () => {
    await seedThesis('Some Thesis Title', 'epigenetics controls gene expression uniqueth66');
    const res = await search(getReq('/api/search?q=epigenetics&types=thesis'));
    const body = await res.json();
    expect(body.results.theses.length).toBeGreaterThanOrEqual(1);
  });

  // --- Draft search + trigger tests ---

  it('drafts_fts INSERT trigger: newly created draft is immediately searchable', async () => {
    const thesis = await seedThesis('My Thesis for Draft uniquedr11');
    await seedDraft(thesis.id, 'Microbiome diet connection uniquedr11title');
    const res = await search(getReq('/api/search?q=uniquedr11title&types=draft'));
    const body = await res.json();
    expect(body.results.drafts.length).toBeGreaterThanOrEqual(1);
  });

  it('drafts_fts UPDATE trigger (generation persist path): updated content is searchable', async () => {
    const thesis = await seedThesis('Thesis for generation test');
    const draft = await seedDraft(thesis.id);
    const uniqueContent = 'thermoregulation endotherm uniquedrgen77';

    // Simulate the generation persist path (mirrors content-generation.ts §7 persist block)
    db.update(drafts)
      .set({
        content: uniqueContent,
        generatedAt: sql`(datetime('now'))`,
        lastEditedAt: null,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(drafts.id, draft.id))
      .run();

    const res = await search(getReq('/api/search?q=thermoregulation&types=draft'));
    const body = await res.json();
    expect(body.results.drafts.length).toBeGreaterThanOrEqual(1);
    expect(body.results.drafts[0].id).toBe(draft.id);
  });

  it('drafts_fts DELETE trigger: deleted draft is no longer searchable', async () => {
    const thesis = await seedThesis('Thesis for delete test');
    const draft = await seedDraft(thesis.id, 'Deletable fossils paleontology uniquedr99');

    const before = await search(getReq('/api/search?q=uniquedr99&types=draft'));
    expect((await before.json()).results.drafts.length).toBe(1);

    await deleteDraftApi(
      new NextRequest(`http://localhost:3000/api/drafts/${draft.id}`, { method: 'DELETE' }),
      routeParams(draft.id),
    );

    const after = await search(getReq('/api/search?q=uniquedr99&types=draft'));
    expect((await after.json()).results.drafts).toHaveLength(0);
  });

  // --- types filter ---

  it('types=article returns only articles, empty arrays for other types', async () => {
    await seedArticle({ title: 'Quark matter uniquetypes11' });
    const res = await search(getReq('/api/search?q=Quark&types=article'));
    const body = await res.json();
    expect(body.results.articles.length).toBeGreaterThanOrEqual(1);
    expect(body.results.highlights).toHaveLength(0);
    expect(body.results.theses).toHaveLength(0);
    expect(body.results.drafts).toHaveLength(0);
    expect(body.totals.highlight).toBe(0);
    expect(body.totals.thesis).toBe(0);
    expect(body.totals.draft).toBe(0);
  });

  it('types=highlight returns only highlights', async () => {
    const article = await seedArticle({ title: 'Host' });
    await seedHighlight(article.id, 'Supernova remnants uniquetypes22');
    const res = await search(getReq('/api/search?q=Supernova&types=highlight'));
    const body = await res.json();
    expect(body.results.highlights.length).toBeGreaterThanOrEqual(1);
    expect(body.results.articles).toHaveLength(0);
    expect(body.totals.article).toBe(0);
  });

  it('omitting types defaults to all four entity types in the response shape', async () => {
    const res = await search(getReq('/api/search?q=anything'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveProperty('articles');
    expect(body.results).toHaveProperty('highlights');
    expect(body.results).toHaveProperty('theses');
    expect(body.results).toHaveProperty('drafts');
    expect(body.totals).toHaveProperty('article');
    expect(body.totals).toHaveProperty('highlight');
    expect(body.totals).toHaveProperty('thesis');
    expect(body.totals).toHaveProperty('draft');
  });

  // --- Pagination ---

  it('limit and offset paginate results; totals are unaffected', async () => {
    const unique = 'planktonbloom99';
    for (let i = 0; i < 3; i++) {
      await seedArticle({ title: `${unique} Article ${i}` });
    }
    const page1 = await (
      await search(getReq(`/api/search?q=${unique}&types=article&limit=2&offset=0`))
    ).json();
    expect(page1.results.articles.length).toBeLessThanOrEqual(2);
    expect(page1.totals.article).toBeGreaterThanOrEqual(3);

    const page2 = await (
      await search(getReq(`/api/search?q=${unique}&types=article&limit=2&offset=2`))
    ).json();
    expect(page2.totals.article).toBe(page1.totals.article);
  });

  // --- mode=palette ---

  it('mode=palette caps results at 5 per type', async () => {
    const unique = 'asteroidbelt99';
    for (let i = 0; i < 7; i++) {
      await seedArticle({ title: `${unique} Article ${i}` });
    }
    const res = await search(getReq(`/api/search?q=${unique}&types=article&mode=palette`));
    const body = await res.json();
    expect(body.results.articles.length).toBeLessThanOrEqual(5);
    expect(body.totals.article).toBeGreaterThanOrEqual(6);
  });

  it('mode=palette uses prefix match (partial token matches)', async () => {
    await seedArticle({ title: 'Neural networks and deep learning uniquepal33' });
    const res = await search(getReq('/api/search?q=neur&mode=palette&types=article'));
    const body = await res.json();
    expect(body.results.articles.length).toBeGreaterThanOrEqual(1);
  });

  it('mode=palette ignores limit and offset', async () => {
    const unique = 'coralreef99';
    for (let i = 0; i < 3; i++) {
      await seedArticle({ title: `${unique} Study ${i}` });
    }
    // limit=1 in palette mode should not restrict below PALETTE_CAP
    const res = await search(
      getReq(`/api/search?q=${unique}&types=article&mode=palette&limit=1&offset=0`),
    );
    const body = await res.json();
    expect(body.results.articles.length).toBeGreaterThanOrEqual(2);
  });

  it('mode=palette ignores status filter', async () => {
    await seedArticle({ title: 'Inbox climate article uniquepalstatus44' });
    // status=archived in palette mode should be ignored — inbox article still returned
    const res = await search(
      getReq('/api/search?q=uniquepalstatus44&types=article&mode=palette&status=archived'),
    );
    const body = await res.json();
    expect(body.results.articles.length).toBeGreaterThanOrEqual(1);
  });

  // --- Snippets ---

  it('article snippet contains <mark> tags around matched terms', async () => {
    await seedArticle({
      title: 'About tectonic plates',
      contentText: 'Tectonic plates move slowly over millions of years uniquesnip11',
    });
    const res = await search(getReq('/api/search?q=tectonic&types=article'));
    const body = await res.json();
    expect(body.results.articles.length).toBeGreaterThanOrEqual(1);
    expect(body.results.articles[0].snippet).toMatch(/<mark>.*<\/mark>/i);
  });

  it('snippet does not expose raw HTML from stored content', async () => {
    await seedArticle({
      title: 'Safe article',
      contentText: '<script>alert(1)</script> Dendrology uniquesnip22',
    });
    const res = await search(getReq('/api/search?q=Dendrology&types=article'));
    const body = await res.json();
    expect(body.results.articles.length).toBeGreaterThanOrEqual(1);
    expect(body.results.articles[0].snippet).not.toContain('<script>');
  });

  it('highlight snippet contains <mark> tags around matched terms', async () => {
    const article = await seedArticle({ title: 'Host Article' });
    await seedHighlight(article.id, 'Photosynthesis converts light uniquehlmark11');
    const res = await search(getReq('/api/search?q=uniquehlmark11&types=highlight'));
    const body = await res.json();
    expect(body.results.highlights.length).toBeGreaterThanOrEqual(1);
    expect(body.results.highlights[0].snippet).toMatch(/<mark>.*<\/mark>/i);
  });

  it('thesis snippet contains <mark> tags around matched terms', async () => {
    await seedThesis('Some Thesis', 'Cognition emerges from networks uniqueThmark22');
    const res = await search(getReq('/api/search?q=uniqueThmark22&types=thesis'));
    const body = await res.json();
    expect(body.results.theses.length).toBeGreaterThanOrEqual(1);
    expect(body.results.theses[0].snippet).toMatch(/<mark>.*<\/mark>/i);
  });

  it('draft snippet contains <mark> tags around matched terms', async () => {
    const thesis = await seedThesis('Thesis for draft mark test');
    await seedDraft(thesis.id, 'Photovoltaics efficiency uniqueDrMark33');
    const res = await search(getReq('/api/search?q=uniqueDrMark33&types=draft'));
    const body = await res.json();
    expect(body.results.drafts.length).toBeGreaterThanOrEqual(1);
    expect(body.results.drafts[0].snippet).toMatch(/<mark>.*<\/mark>/i);
  });

  // --- Date filtering ---

  it('dateFrom in the future excludes and past-anchored range includes an article', async () => {
    await seedArticle({ title: 'Glaciology retreat rates uniquedate44' });

    const excluded = await (
      await search(getReq('/api/search?q=uniquedate44&types=article&dateFrom=2099-01-01'))
    ).json();
    expect(excluded.results.articles).toHaveLength(0);
    expect(excluded.totals.article).toBe(0);

    const included = await (
      await search(getReq('/api/search?q=uniquedate44&types=article&dateFrom=2000-01-01'))
    ).json();
    expect(included.results.articles.length).toBeGreaterThanOrEqual(1);
  });

  it('dateTo in the past excludes an article saved now', async () => {
    await seedArticle({ title: 'Seismology waveforms uniquedate55' });
    const res = await search(getReq('/api/search?q=uniquedate55&types=article&dateTo=2000-01-01'));
    const body = await res.json();
    expect(body.results.articles).toHaveLength(0);
    expect(body.totals.article).toBe(0);
  });

  // --- sourceId filtering ---

  it('sourceId filter restricts articles to the matching source', async () => {
    const sourceA = await seedSource('Source A');
    const sourceB = await seedSource('Source B');
    await seedArticle({ title: 'Ornithology migration uniquesrc66', sourceId: sourceA.id });

    const matched = await (
      await search(getReq(`/api/search?q=uniquesrc66&types=article&sourceId=${sourceA.id}`))
    ).json();
    expect(matched.results.articles.length).toBeGreaterThanOrEqual(1);

    const other = await (
      await search(getReq(`/api/search?q=uniquesrc66&types=article&sourceId=${sourceB.id}`))
    ).json();
    expect(other.results.articles).toHaveLength(0);
    expect(other.totals.article).toBe(0);
  });

  // --- Totals for non-article entities ---

  it('thesis and draft totals reflect unpaginated match counts', async () => {
    const thesis = await seedThesis('Thesis totals uniquetot77');
    await seedDraft(thesis.id, 'Draft totals uniquetot77body');

    const thesisBody = await (
      await search(getReq('/api/search?q=uniquetot77&types=thesis'))
    ).json();
    expect(thesisBody.totals.thesis).toBeGreaterThanOrEqual(1);

    const draftBody = await (
      await search(getReq('/api/search?q=uniquetot77body&types=draft'))
    ).json();
    expect(draftBody.totals.draft).toBeGreaterThanOrEqual(1);
  });

  // --- Response shape ---

  it('response includes query, results, and totals fields', async () => {
    const res = await search(getReq('/api/search?q=anything'));
    const body = await res.json();
    expect(body).toHaveProperty('query', 'anything');
    expect(body).toHaveProperty('results');
    expect(body).toHaveProperty('totals');
  });
});
