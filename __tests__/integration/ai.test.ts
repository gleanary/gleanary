import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';
import { server, setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { resetClient } from '@/lib/ai';
import { POST as createArticle } from '@/app/api/articles/route';
import { POST as createHighlight } from '@/app/api/highlights/route';
import { POST as summarize } from '@/app/api/ai/summarize/route';
import { POST as autoTag } from '@/app/api/ai/tag/route';
import { POST as explain } from '@/app/api/ai/explain/route';

setupHandlers(
  http.post('https://api.anthropic.com/v1/messages', () => {
    return HttpResponse.json({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'This article discusses testing patterns for modern web applications.',
        },
      ],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  }),
);

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

const validArticle = {
  url: 'https://example.com/ai-test',
  title: 'AI Test Article',
  contentHtml: '<p>This is a detailed article about testing patterns.</p>',
  contentText:
    'This is a detailed article about testing patterns. It covers unit tests, integration tests, and end-to-end tests for web applications.',
  excerpt: 'Testing patterns for web apps',
};

describe('AI Features API', () => {
  let articleId: number;

  beforeEach(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    dbMock.setup();
    resetClient();

    // Create a test article
    const res = await createArticle(jsonReq('POST', '/api/articles', validArticle));
    const body = await res.json();
    articleId = body.article.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('POST /api/ai/summarize', () => {
    it('summarizes an article and stores result', async () => {
      const res = await summarize(jsonReq('POST', '/api/ai/summarize', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.summary).toBeTruthy();
      expect(typeof body.summary).toBe('string');
    });

    it('returns cached summary on second call', async () => {
      // First call — hits Claude API
      await summarize(jsonReq('POST', '/api/ai/summarize', { articleId }));

      // Mock API to return different response (should not be called)
      server.use(
        http.post('https://api.anthropic.com/v1/messages', () => {
          return HttpResponse.json({
            id: 'msg_mock2',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'DIFFERENT RESPONSE' }],
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20 },
          });
        }),
      );

      // Second call — should return cached
      const res = await summarize(jsonReq('POST', '/api/ai/summarize', { articleId }));
      const body = await res.json();
      expect(body.summary).not.toBe('DIFFERENT RESPONSE');
      expect(body.cached).toBe(true);
    });

    it('returns 404 for nonexistent article', async () => {
      const res = await summarize(jsonReq('POST', '/api/ai/summarize', { articleId: 9999 }));
      expect(res.status).toBe(404);
    });

    it('returns 422 for invalid input', async () => {
      const res = await summarize(jsonReq('POST', '/api/ai/summarize', { articleId: -1 }));
      expect(res.status).toBe(422);
    });

    it('returns 422 for missing articleId', async () => {
      const res = await summarize(jsonReq('POST', '/api/ai/summarize', {}));
      expect(res.status).toBe(422);
    });

    it('returns 422 for article with no content', async () => {
      // Create article without content
      const createRes = await createArticle(
        jsonReq('POST', '/api/articles', {
          url: 'https://example.com/no-content',
          title: 'No Content Article',
        }),
      );
      const { article } = await createRes.json();

      const res = await summarize(jsonReq('POST', '/api/ai/summarize', { articleId: article.id }));
      expect(res.status).toBe(422);
    });

    it('returns 502 when Claude API fails', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', () => {
          return HttpResponse.json({ error: { message: 'Rate limited' } }, { status: 429 });
        }),
      );

      const res = await summarize(jsonReq('POST', '/api/ai/summarize', { articleId }));
      expect(res.status).toBe(503);
    });
  });

  describe('POST /api/ai/tag', () => {
    it('auto-tags an article', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', () => {
          return HttpResponse.json({
            id: 'msg_tag',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '["testing", "web-development", "javascript"]' }],
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20 },
          });
        }),
      );

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.tags).toBeInstanceOf(Array);
      expect(body.tags.length).toBeGreaterThan(0);
      expect(body.tags[0]).toHaveProperty('name');
    });

    it('reuses existing tags when matching', async () => {
      // First create a tag via the tags API
      const { POST: createTag } = await import('@/app/api/tags/route');
      await createTag(jsonReq('POST', '/api/tags', { name: 'testing' }));

      server.use(
        http.post('https://api.anthropic.com/v1/messages', () => {
          return HttpResponse.json({
            id: 'msg_tag2',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '["testing", "new-tag"]' }],
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20 },
          });
        }),
      );

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));
      const body = await res.json();

      // 'testing' should have id 1 (the pre-existing one)
      const testingTag = body.tags.find((t: { name: string }) => t.name === 'testing');
      expect(testingTag).toBeDefined();
      expect(testingTag.id).toBe(1);

      // 'new-tag' should be newly created
      expect(body.created).toContain('new-tag');
    });

    it('returns 404 for nonexistent article', async () => {
      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId: 9999 }));
      expect(res.status).toBe(404);
    });

    it('returns 422 for invalid input', async () => {
      const res = await autoTag(jsonReq('POST', '/api/ai/tag', {}));
      expect(res.status).toBe(422);
    });

    it('returns 422 for article with no content', async () => {
      const createRes = await createArticle(
        jsonReq('POST', '/api/articles', {
          url: 'https://example.com/no-content-tag',
          title: 'No Content',
        }),
      );
      const { article } = await createRes.json();

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId: article.id }));
      expect(res.status).toBe(422);
    });

    it('returns 502 when Claude API fails', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', () => {
          return HttpResponse.json({ error: { message: 'Server error' } }, { status: 500 });
        }),
      );

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));
      expect(res.status).toBe(503);
    });
  });

  describe('POST /api/ai/explain', () => {
    let highlightId: number;

    beforeEach(async () => {
      // Create a highlight on the article
      const res = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId,
          text: 'Testing patterns are essential for maintainable code.',
        }),
      );
      const body = await res.json();
      highlightId = body.highlight.id;
    });

    it('explains a highlight', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', () => {
          return HttpResponse.json({
            id: 'msg_explain',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'This passage emphasizes the importance of testing patterns for code quality.',
              },
            ],
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 30 },
          });
        }),
      );

      const res = await explain(
        jsonReq('POST', '/api/ai/explain', { highlightId, mode: 'explain' }),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.explanation).toBeTruthy();
      expect(typeof body.explanation).toBe('string');
    });

    it('supports importance mode', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', () => {
          return HttpResponse.json({
            id: 'msg_importance',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'This is important because it highlights a key software engineering principle.',
              },
            ],
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 30 },
          });
        }),
      );

      const res = await explain(
        jsonReq('POST', '/api/ai/explain', { highlightId, mode: 'importance' }),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.explanation).toBeTruthy();
    });

    it('defaults to explain mode', async () => {
      const res = await explain(jsonReq('POST', '/api/ai/explain', { highlightId }));
      expect(res.status).toBe(200);
    });

    it('returns 404 for nonexistent highlight', async () => {
      const res = await explain(
        jsonReq('POST', '/api/ai/explain', { highlightId: 9999, mode: 'explain' }),
      );
      expect(res.status).toBe(404);
    });

    it('returns 422 for invalid input', async () => {
      const res = await explain(jsonReq('POST', '/api/ai/explain', {}));
      expect(res.status).toBe(422);
    });

    it('returns 502 when Claude API fails', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', () => {
          return HttpResponse.json({ error: { message: 'Overloaded' } }, { status: 529 });
        }),
      );

      const res = await explain(
        jsonReq('POST', '/api/ai/explain', { highlightId, mode: 'explain' }),
      );
      expect(res.status).toBe(503);
    });
  });
});
