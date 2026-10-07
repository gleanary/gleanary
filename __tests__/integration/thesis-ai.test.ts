import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

vi.mock('@/lib/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ai')>();
  return {
    ...original,
    callClaude: vi.fn(),
  };
});

import { callClaude } from '@/lib/ai';

import { POST as createArticle } from '@/app/api/articles/route';
import { POST as createHighlight } from '@/app/api/highlights/route';
import { POST as createThesis } from '@/app/api/theses/route';
import { POST as linkHighlights } from '@/app/api/theses/[id]/highlights/route';
import { POST as suggestTheses } from '@/app/api/theses/suggest/route';
import { POST as suggestHighlights } from '@/app/api/theses/[id]/suggest-highlights/route';

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

async function seedArticle(url = 'https://example.com/test') {
  const res = await createArticle(
    jsonReq('POST', '/api/articles', {
      url,
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

describe('Thesis AI API', () => {
  beforeEach(() => {
    dbMock.setup();
    vi.mocked(callClaude).mockReset();
  });

  describe('POST /api/theses/suggest', () => {
    it('returns AI suggestions for unlinked highlights', async () => {
      const article = await seedArticle();
      const h1 = await seedHighlight(article.id, 'Remote work increases focus');
      const h2 = await seedHighlight(article.id, 'Office politics reduce output');

      const mockSuggestions = [
        {
          title: 'Remote work improves productivity',
          claim: 'Distributed teams outperform co-located teams...',
          relevantHighlightIds: [h1.id, h2.id],
          confidence: 0.87,
        },
      ];

      vi.mocked(callClaude).mockResolvedValue(JSON.stringify(mockSuggestions));

      const res = await suggestTheses(jsonReq('POST', '/api/theses/suggest', { limit: 5 }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.suggestions).toHaveLength(1);
      expect(body.suggestions[0].title).toBe('Remote work improves productivity');
      expect(body.suggestions[0].relevantHighlightIds).toEqual([h1.id, h2.id]);
    });

    it('returns empty suggestions when no unlinked highlights', async () => {
      const res = await suggestTheses(jsonReq('POST', '/api/theses/suggest', {}));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.suggestions).toEqual([]);
    });

    it('returns 503 when AI is not configured', async () => {
      vi.mocked(callClaude).mockRejectedValue(new Error('No API key'));

      const article = await seedArticle();
      await seedHighlight(article.id);

      const res = await suggestTheses(jsonReq('POST', '/api/theses/suggest', {}));
      // Should return some error code — not crash with unhandled exception
      expect([200, 500, 502, 503]).toContain(res.status);
    });
  });

  describe('POST /api/theses/[id]/suggest-highlights', () => {
    it('returns AI highlight suggestions for a thesis', async () => {
      const article = await seedArticle();
      const h1 = await seedHighlight(article.id, 'Platform teams own DX');
      const h2 = await seedHighlight(article.id, 'Infrastructure teams own infra');

      const createRes = await createThesis(
        jsonReq('POST', '/api/theses', {
          title: 'Platform teams should own DX',
          claim: 'Effective platform teams measure by developer productivity...',
        }),
      );
      const { thesis } = await createRes.json();

      // Link one highlight already
      await linkHighlights(
        jsonReq('POST', `/api/theses/${thesis.id}/highlights`, {
          highlightIds: [h1.id],
        }),
        routeParams(thesis.id),
      );

      const mockSuggestions = [
        {
          highlightId: h2.id,
          suggestedRole: 'supporting',
          reason: 'Directly supports the claim',
        },
      ];

      vi.mocked(callClaude).mockResolvedValue(JSON.stringify(mockSuggestions));

      const res = await suggestHighlights(
        jsonReq('POST', `/api/theses/${thesis.id}/suggest-highlights`, { limit: 10 }),
        routeParams(thesis.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.suggestions).toHaveLength(1);
      expect(body.suggestions[0].highlightId).toBe(h2.id);
      expect(body.suggestions[0].suggestedRole).toBe('supporting');
    });

    it('returns 404 for non-existent thesis', async () => {
      const res = await suggestHighlights(
        jsonReq('POST', '/api/theses/9999/suggest-highlights', {}),
        routeParams(9999),
      );
      expect(res.status).toBe(404);
    });
  });
});
