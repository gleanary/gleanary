import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { POST as createArticle } from '@/app/api/articles/route';
import { GET as getArticle } from '@/app/api/articles/[id]/route';
import { GET as listHighlights, POST as createHighlight } from '@/app/api/highlights/route';
import {
  PATCH as updateHighlight,
  DELETE as deleteHighlight,
} from '@/app/api/highlights/[id]/route';
import {
  POST as reanchorHighlights,
  buildRoot as buildTestRoot,
} from '@/app/api/articles/[id]/reanchor-highlights/route';
import { runBackfill } from '../../scripts/backfill-highlight-anchors';
import { serializeRange } from '@/lib/highlight-anchoring';
import type { TextQuoteAnchor } from '@/types';

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
      url: 'https://example.com/highlight-test',
      title: 'Highlight Test Article',
      contentHtml: '<p>The quick brown fox jumps over the lazy dog.</p><p>Second paragraph.</p>',
      contentText: 'The quick brown fox jumps over the lazy dog. Second paragraph.',
      wordCount: 12,
    }),
  );
  const body = await res.json();
  return body.article;
}

describe('Highlight anchoring integration', () => {
  beforeEach(() => {
    dbMock.setup();
  });

  it('creates a highlight with position data', async () => {
    const article = await seedArticle();

    const positionData = JSON.stringify({
      startContainerPath: [0, 0],
      startOffset: 10,
      endContainerPath: [0, 0],
      endOffset: 19,
      text: 'brown fox',
    });

    const res = await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'brown fox',
        color: 'yellow',
        positionData,
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.highlight.positionData).toBe(positionData);
    expect(body.highlight.text).toBe('brown fox');
    expect(body.highlight.color).toBe('yellow');
  });

  it('persists position data and returns it via GET /api/articles/[id]', async () => {
    const article = await seedArticle();

    const positionData = JSON.stringify({
      startContainerPath: [0, 0],
      startOffset: 4,
      endContainerPath: [0, 0],
      endOffset: 9,
      text: 'quick',
    });

    await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'quick',
        color: 'yellow',
        positionData,
      }),
    );

    const res = await getArticle(
      jsonReq('GET', `/api/articles/${article.id}`),
      routeParams(article.id),
    );
    const body = await res.json();

    expect(body.highlights).toHaveLength(1);
    expect(body.highlights[0].positionData).toBe(positionData);
    expect(body.highlights[0].color).toBe('yellow');
  });

  it('creates multiple highlights on the same article', async () => {
    const article = await seedArticle();

    await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'brown fox',
        color: 'yellow',
        positionData: JSON.stringify({
          startContainerPath: [0, 0],
          startOffset: 10,
          endContainerPath: [0, 0],
          endOffset: 19,
          text: 'brown fox',
        }),
      }),
    );

    await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'lazy dog',
        color: 'yellow',
        positionData: JSON.stringify({
          startContainerPath: [0, 0],
          startOffset: 35,
          endContainerPath: [0, 0],
          endOffset: 43,
          text: 'lazy dog',
        }),
      }),
    );

    const res = await listHighlights(jsonReq('GET', `/api/highlights?articleId=${article.id}`));
    const body = await res.json();

    expect(body.highlights).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it('updates highlight note and preserves position data', async () => {
    const article = await seedArticle();

    const positionData = JSON.stringify({
      startContainerPath: [0, 0],
      startOffset: 0,
      endContainerPath: [0, 0],
      endOffset: 3,
      text: 'The',
    });

    const createRes = await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'The',
        color: 'yellow',
        positionData,
      }),
    );
    const { highlight } = await createRes.json();

    const updateRes = await updateHighlight(
      jsonReq('PATCH', `/api/highlights/${highlight.id}`, { note: 'Updated note' }),
      routeParams(highlight.id),
    );
    const updated = await updateRes.json();

    expect(updated.highlight.note).toBe('Updated note');
    expect(updated.highlight.positionData).toBe(positionData);
  });

  it('deletes a highlight', async () => {
    const article = await seedArticle();

    const createRes = await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'quick',
        color: 'yellow',
        positionData: JSON.stringify({
          startContainerPath: [0, 0],
          startOffset: 4,
          endContainerPath: [0, 0],
          endOffset: 9,
          text: 'quick',
        }),
      }),
    );
    const { highlight } = await createRes.json();

    const deleteRes = await deleteHighlight(
      jsonReq('DELETE', `/api/highlights/${highlight.id}`),
      routeParams(highlight.id),
    );
    expect(deleteRes.status).toBe(200);

    const listRes = await listHighlights(jsonReq('GET', `/api/highlights?articleId=${article.id}`));
    const body = await listRes.json();
    expect(body.highlights).toHaveLength(0);
  });

  it('creates a highlight with a note', async () => {
    const article = await seedArticle();

    const res = await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'brown fox',
        color: 'yellow',
        note: 'This is an important phrase',
        positionData: JSON.stringify({
          startContainerPath: [0, 0],
          startOffset: 10,
          endContainerPath: [0, 0],
          endOffset: 19,
          text: 'brown fox',
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.highlight.note).toBe('This is an important phrase');
  });

  it('updates highlight note', async () => {
    const article = await seedArticle();

    const createRes = await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'quick',
        color: 'yellow',
      }),
    );
    const { highlight } = await createRes.json();

    const updateRes = await updateHighlight(
      jsonReq('PATCH', `/api/highlights/${highlight.id}`, { note: 'Added a note' }),
      routeParams(highlight.id),
    );
    const updated = await updateRes.json();
    expect(updated.highlight.note).toBe('Added a note');
  });

  it('handles cross-element position data', async () => {
    const article = await seedArticle();

    const positionData = JSON.stringify({
      startContainerPath: [0, 0],
      startOffset: 35,
      endContainerPath: [1, 0],
      endOffset: 6,
      text: 'lazy dog.Second',
    });

    const res = await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'lazy dog.Second',
        color: 'yellow',
        positionData,
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    const parsed = JSON.parse(body.highlight.positionData);
    expect(parsed.startContainerPath).toEqual([0, 0]);
    expect(parsed.endContainerPath).toEqual([1, 0]);
  });

  // --- v2 text-quote anchors ---

  it('stores a valid v2 text-quote anchor and defaults anchorStatus to "anchored"', async () => {
    const article = await seedArticle();

    const v2: TextQuoteAnchor = {
      v: 2,
      exact: 'brown fox',
      prefix: 'The quick ',
      suffix: ' jumps over the lazy dog.',
      start: 10,
      end: 19,
    };
    const positionData = JSON.stringify(v2);

    const res = await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'brown fox',
        color: 'yellow',
        positionData,
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.highlight.positionData).toBe(positionData);
    expect(body.highlight.anchorStatus).toBe('anchored');
  });

  it('rejects malformed positionData with 422', async () => {
    const article = await seedArticle();

    const nonJson = await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'brown fox',
        positionData: 'not valid json at all',
      }),
    );
    expect(nonJson.status).toBe(422);

    const wrongShape = await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'brown fox',
        positionData: JSON.stringify({ foo: 'bar' }),
      }),
    );
    expect(wrongShape.status).toBe(422);
  });

  it('surfaces anchorStatus via GET and lets PATCH orphan a highlight', async () => {
    const article = await seedArticle();

    const createRes = await createHighlight(
      jsonReq('POST', '/api/highlights', {
        articleId: article.id,
        text: 'quick',
        color: 'yellow',
      }),
    );
    const { highlight } = await createRes.json();

    const listRes = await listHighlights(jsonReq('GET', `/api/highlights?articleId=${article.id}`));
    const listed = await listRes.json();
    expect(listed.highlights[0].anchorStatus).toBe('anchored');

    const patchRes = await updateHighlight(
      jsonReq('PATCH', `/api/highlights/${highlight.id}`, { anchorStatus: 'orphaned' }),
      routeParams(highlight.id),
    );
    const patched = await patchRes.json();
    expect(patched.highlight.anchorStatus).toBe('orphaned');
  });

  // --- v1 → v2 backfill ---

  describe('runBackfill (v1 → v2)', () => {
    /** Posts a highlight carrying a legacy v1 anchor (paths are relative to the reader root). */
    async function seedV1Highlight(
      articleId: number,
      text: string,
      v1: {
        startContainerPath: number[];
        startOffset: number;
        endContainerPath: number[];
        endOffset: number;
      },
    ) {
      const res = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId,
          text,
          positionData: JSON.stringify({ ...v1, text }),
        }),
      );
      const body = await res.json();
      return body.highlight;
    }

    async function fetchHighlights(articleId: number) {
      const res = await listHighlights(jsonReq('GET', `/api/highlights?articleId=${articleId}`));
      const body = await res.json();
      return body.highlights as Array<{
        text: string;
        positionData: string | null;
        anchorStatus: string;
      }>;
    }

    it('upgrades a resolvable v1 row, recovers by text, and orphans the unrecoverable', async () => {
      const article = await seedArticle();
      // Content root path: root(highlight-layer div) → [0] .article-content → [0] <p> → [0] text.
      // First <p>: "The quick brown fox jumps over the lazy dog."

      // (a) Upgradeable: a correct v1 path for "brown fox" (offsets 10..19 in the first text node).
      await seedV1Highlight(article.id, 'brown fox', {
        startContainerPath: [0, 0, 0],
        startOffset: 10,
        endContainerPath: [0, 0, 0],
        endOffset: 19,
      });

      // (b) Recoverable-by-text: a broken path, but the text still exists in the content.
      await seedV1Highlight(article.id, 'Second paragraph.', {
        startContainerPath: [0, 9, 0],
        startOffset: 0,
        endContainerPath: [0, 9, 0],
        endOffset: 17,
      });

      // (c) Unrecoverable: broken path AND the text is absent from the content.
      await seedV1Highlight(article.id, 'this phrase is entirely absent', {
        startContainerPath: [0, 9, 0],
        startOffset: 0,
        endContainerPath: [0, 9, 0],
        endOffset: 5,
      });

      const summary = runBackfill(dbMock.mock.rawDb!);
      expect(summary.upgraded).toBe(1);
      expect(summary.recovered).toBe(1);
      expect(summary.orphaned).toBe(1);

      const byText = new Map((await fetchHighlights(article.id)).map((h) => [h.text, h] as const));

      const upgraded = byText.get('brown fox')!;
      expect(upgraded.anchorStatus).toBe('anchored');
      const upgradedAnchor = JSON.parse(upgraded.positionData!) as TextQuoteAnchor;
      expect(upgradedAnchor.v).toBe(2);
      expect(upgradedAnchor.exact).toBe('brown fox');

      const recovered = byText.get('Second paragraph.')!;
      expect(recovered.anchorStatus).toBe('anchored');
      expect((JSON.parse(recovered.positionData!) as TextQuoteAnchor).v).toBe(2);

      const orphaned = byText.get('this phrase is entirely absent')!;
      expect(orphaned.anchorStatus).toBe('orphaned');
    });

    it('is idempotent: re-running skips already-v2 rows', async () => {
      const article = await seedArticle();
      await seedV1Highlight(article.id, 'brown fox', {
        startContainerPath: [0, 0, 0],
        startOffset: 10,
        endContainerPath: [0, 0, 0],
        endOffset: 19,
      });

      runBackfill(dbMock.mock.rawDb!);
      const second = runBackfill(dbMock.mock.rawDb!);
      expect(second.upgraded).toBe(0);
      expect(second.recovered).toBe(0);
      expect(second.orphaned).toBe(0);
      expect(second.skipped).toBeGreaterThanOrEqual(1);
    });
  });

  // --- POST /api/articles/[id]/reanchor-highlights ---

  describe('POST /api/articles/[id]/reanchor-highlights', () => {
    const CONTENT_HTML =
      '<p>The quick brown fox jumps over the lazy dog.</p><p>Second paragraph.</p>';

    async function seed() {
      return seedArticle();
    }

    it('returns unchanged=1 for a v2 highlight whose offsets are already correct', async () => {
      const article = await seed();
      const v2: TextQuoteAnchor = {
        v: 2,
        exact: 'brown fox',
        prefix: 'The quick ',
        suffix: ' jumps over',
        start: 10,
        end: 19,
      };
      await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'brown fox',
          positionData: JSON.stringify(v2),
        }),
      );

      const res = await reanchorHighlights(
        new Request('http://localhost'),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ reanchored: 0, orphaned: 0, unchanged: 1 });
    });

    it('reanchors a v2 highlight with drifted offsets (wrong start/end but correct exact)', async () => {
      const article = await seed();
      const drifted: TextQuoteAnchor = {
        v: 2,
        exact: 'brown fox',
        prefix: 'The quick ',
        suffix: ' jumps over',
        start: 0, // deliberately wrong
        end: 9, // deliberately wrong
      };
      const createRes = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'brown fox',
          positionData: JSON.stringify(drifted),
        }),
      );
      const { highlight } = await createRes.json();

      const res = await reanchorHighlights(
        new Request('http://localhost'),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ reanchored: 1, orphaned: 0, unchanged: 0 });

      // Verify the stored anchor now has the correct offsets and anchorStatus stays anchored
      const listRes = await listHighlights(
        jsonReq('GET', `/api/highlights?articleId=${article.id}`),
      );
      const listed = await listRes.json();
      const updated = listed.highlights.find((h: { id: number }) => h.id === highlight.id);
      expect(updated.anchorStatus).toBe('anchored');
      const anchor = JSON.parse(updated.positionData) as TextQuoteAnchor;
      expect(anchor.v).toBe(2);
      expect(anchor.exact).toBe('brown fox');
      expect(anchor.start).toBe(10); // correct offset in the content stream
      expect(anchor.end).toBe(19);
    });

    it('orphans a v2 highlight whose exact text is absent from the content', async () => {
      const article = await seed();
      const absent: TextQuoteAnchor = {
        v: 2,
        exact: 'this phrase does not exist in the article',
        prefix: '',
        suffix: '',
        start: 0,
        end: 41,
      };
      const createRes = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'this phrase does not exist in the article',
          positionData: JSON.stringify(absent),
        }),
      );
      const { highlight } = await createRes.json();

      const res = await reanchorHighlights(
        new Request('http://localhost'),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ reanchored: 0, orphaned: 1, unchanged: 0 });

      // Verify the highlight is now orphaned in the GET response
      const listRes = await listHighlights(
        jsonReq('GET', `/api/highlights?articleId=${article.id}`),
      );
      const listed = await listRes.json();
      const updated = listed.highlights.find((h: { id: number }) => h.id === highlight.id);
      expect(updated.anchorStatus).toBe('orphaned');
    });

    it('resets anchorStatus to "anchored" when a previously-orphaned v2 highlight resolves', async () => {
      const article = await seed();
      const v2: TextQuoteAnchor = {
        v: 2,
        exact: 'brown fox',
        prefix: 'The quick ',
        suffix: ' jumps over',
        start: 10,
        end: 19,
      };
      const createRes = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'brown fox',
          positionData: JSON.stringify(v2),
        }),
      );
      const { highlight } = await createRes.json();

      // Simulate a prior orphaning (e.g. from a previous content mutation)
      await updateHighlight(
        jsonReq('PATCH', `/api/highlights/${highlight.id}`, { anchorStatus: 'orphaned' }),
        routeParams(highlight.id),
      );

      // Re-anchor: the offsets are still correct, so the route hits the "unchanged but orphaned" path
      const res = await reanchorHighlights(
        new Request('http://localhost'),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ reanchored: 1, orphaned: 0, unchanged: 0 });

      const listRes = await listHighlights(
        jsonReq('GET', `/api/highlights?articleId=${article.id}`),
      );
      const listed = await listRes.json();
      const updated = listed.highlights.find((h: { id: number }) => h.id === highlight.id);
      expect(updated.anchorStatus).toBe('anchored');
    });

    it('upgrades a v1 highlight to v2 via the deserializeRange path', async () => {
      const article = await seed();

      // Generate a provably-correct v1 anchor by calling serializeRange against
      // the same DOM structure buildRoot produces (not hand-constructed paths).
      const root = buildTestRoot(CONTENT_HTML);

      // Find the text node inside the first <p> and build a range for "brown fox" (chars 10–19).
      const firstP = root.querySelector('p')!;
      const textNode = firstP.firstChild!;
      const range = root.ownerDocument.createRange();
      range.setStart(textNode, 10);
      range.setEnd(textNode, 19);
      const v1 = serializeRange(range, root);

      await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'brown fox',
          positionData: JSON.stringify(v1),
        }),
      );

      const res = await reanchorHighlights(
        new Request('http://localhost'),
        routeParams(article.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ reanchored: 1, orphaned: 0, unchanged: 0 });

      // Verify the stored positionData is now a v2 anchor
      const listRes = await listHighlights(
        jsonReq('GET', `/api/highlights?articleId=${article.id}`),
      );
      const listed = await listRes.json();
      const upgraded = listed.highlights[0];
      expect(upgraded.anchorStatus).toBe('anchored');
      const anchor = JSON.parse(upgraded.positionData) as TextQuoteAnchor;
      expect(anchor.v).toBe(2);
      expect(anchor.exact).toBe('brown fox');
    });

    it('returns 404 for an unknown article', async () => {
      const res = await reanchorHighlights(new Request('http://localhost'), routeParams(99999));
      expect(res.status).toBe(404);
    });

    it('is idempotent: second pass returns all unchanged', async () => {
      const article = await seed();
      const v2: TextQuoteAnchor = {
        v: 2,
        exact: 'lazy dog',
        prefix: 'over the ',
        suffix: '.',
        start: 35,
        end: 43,
      };
      await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId: article.id,
          text: 'lazy dog',
          positionData: JSON.stringify(v2),
        }),
      );

      const first = await (
        await reanchorHighlights(new Request('http://localhost'), routeParams(article.id))
      ).json();
      expect(first.unchanged).toBe(1);

      const second = await (
        await reanchorHighlights(new Request('http://localhost'), routeParams(article.id))
      ).json();
      expect(second).toEqual({ reanchored: 0, orphaned: 0, unchanged: 1 });
    });
  });
});
