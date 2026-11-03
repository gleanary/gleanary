import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';
import { eq } from 'drizzle-orm';
import { server, setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { articles, tags } from '@/db/schema';
import { resetClient } from '@/lib/ai';
import { clearSettingsCache, deleteSetting, setSetting } from '@/lib/settings';
import { expectActiveModel } from '../mocks/active-models';
import { logger } from '@/lib/logger';
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
      model: 'claude-sonnet-4-6',
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
      let requestedModel: unknown;
      server.use(
        http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
          requestedModel = ((await request.json()) as { model?: unknown }).model;
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
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20 },
          });
        }),
      );

      const res = await summarize(jsonReq('POST', '/api/ai/summarize', { articleId }));
      expect(res.status).toBe(200);
      expectActiveModel(requestedModel);

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
            model: 'claude-sonnet-4-6',
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

    it('returns 503 when Claude API fails', async () => {
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
    /** Mocks the model's tag reply and records the user message it was sent. */
    function mockTagReply(reply: string[]): { userMessage: () => string } {
      let sent = '';
      server.use(
        http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
          const body = (await request.json()) as {
            messages: Array<{ content: string | Array<{ text?: string }> }>;
          };
          const content = body.messages[0]?.content ?? '';
          sent = typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('');
          return HttpResponse.json({
            id: 'msg_tag',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: JSON.stringify(reply) }],
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20 },
          });
        }),
      );
      return { userMessage: () => sent };
    }

    /** The "Existing tags" vocabulary hint parsed out of the user message. */
    function vocabularyHint(userMessage: string): string[] {
      const match = /Existing tags: (.*)\n/.exec(userMessage);
      expect(match).not.toBeNull();
      return JSON.parse(match![1]!) as string[];
    }

    /** Creates another article whose ai_tags column holds `aiTags` verbatim. */
    async function createTaggedArticle(slug: string, aiTags: string | null) {
      const res = await createArticle(
        jsonReq('POST', '/api/articles', {
          ...validArticle,
          url: `https://example.com/${slug}`,
          title: slug,
        }),
      );
      const { article } = await res.json();
      dbMock.mock.db!.update(articles).set({ aiTags }).where(eq(articles.id, article.id)).run();
      return article.id as number;
    }

    function storedAiTags(id: number): string | null {
      return (
        dbMock.mock
          .db!.select({ aiTags: articles.aiTags })
          .from(articles)
          .where(eq(articles.id, id))
          .get()?.aiTags ?? null
      );
    }

    it('auto-tags an article', async () => {
      let requestedModel: unknown;
      server.use(
        http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
          requestedModel = ((await request.json()) as { model?: unknown }).model;
          return HttpResponse.json({
            id: 'msg_tag',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '["testing", "web-development", "javascript"]' }],
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20 },
          });
        }),
      );

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));
      expect(res.status).toBe(200);
      expectActiveModel(requestedModel);

      const body = await res.json();
      expect(body).toEqual({ tags: ['testing', 'web-development', 'javascript'] });
      expect(JSON.parse(storedAiTags(articleId)!)).toEqual([
        'testing',
        'web-development',
        'javascript',
      ]);
    });

    it('reuses existing article tag spellings', async () => {
      await createTaggedArticle('tagged-a', JSON.stringify(['Machine Learning', 'AI']));
      await createTaggedArticle('tagged-b', JSON.stringify(['ai', 'Databases']));
      await createTaggedArticle('tagged-malformed', 'not json');
      const reply = mockTagReply(['machine learning', 'DATABASES', 'new-tag']);

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));
      expect(res.status).toBe(200);

      // Other articles' tags, de-duplicated case-insensitively, are the vocabulary hint
      const hint = vocabularyHint(reply.userMessage());
      expect(hint).toHaveLength(3);
      expect(hint).toEqual(expect.arrayContaining(['Machine Learning', 'Databases']));
      expect(hint.filter((t) => t.toLowerCase() === 'ai')).toHaveLength(1);

      const expected = ['Machine Learning', 'Databases', 'new-tag'];
      expect((await res.json()).tags).toEqual(expected);
      expect(JSON.parse(storedAiTags(articleId)!)).toEqual(expected);
    });

    it('trims spellings and collapses suggestions that normalize to the same tag', async () => {
      await createTaggedArticle('tagged-padded', JSON.stringify(['Testing ', '  ']));
      const reply = mockTagReply(['testing', 'Testing', ' TESTING ']);

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));

      expect(vocabularyHint(reply.userMessage())).toEqual(['Testing']);
      expect((await res.json()).tags).toEqual(['Testing']);
    });

    it('skips malformed ai_tags without logging a warning', async () => {
      await createTaggedArticle('tagged-ok', JSON.stringify(['Kept']));
      await createTaggedArticle('tagged-malformed', 'not json');
      const reply = mockTagReply(['kept']);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));
      const events = warnSpy.mock.calls.map((c) => (c[0] as { event?: string })?.event);
      warnSpy.mockRestore();

      expect(res.status).toBe(200);
      expect(vocabularyHint(reply.userMessage())).toEqual(['Kept']);
      expect(events).not.toContain('ai_tags_malformed');
    });

    it('merges non-ASCII case variants into one vocabulary entry', async () => {
      await createTaggedArticle('tagged-upper', JSON.stringify(['Économie']));
      await createTaggedArticle('tagged-lower', JSON.stringify(['économie']));
      const reply = mockTagReply(['ÉCONOMIE']);

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));

      // First-seen spelling wins
      expect(vocabularyHint(reply.userMessage())).toEqual(['Économie']);
      expect((await res.json()).tags).toEqual(['Économie']);
    });

    it('sends only the 200 most frequent article tags as the vocabulary hint', async () => {
      const many = Array.from({ length: 201 }, (_, i) => `tag-${i}`);
      await createTaggedArticle('tagged-many', JSON.stringify(many));
      await createTaggedArticle('tagged-frequent', JSON.stringify(['tag-200']));
      const reply = mockTagReply(['tag-0']);

      await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));

      const hint = vocabularyHint(reply.userMessage());
      expect(hint).toHaveLength(200);
      // tag-200 is used twice, so it ranks first; the last single-use tag is cut
      expect(hint[0]).toBe('tag-200');
      expect(hint).not.toContain('tag-199');
    });

    it('counts a tag once per article when ranking the vocabulary hint', async () => {
      await createTaggedArticle('tagged-repeats', JSON.stringify(['Dup', 'Dup', 'dup']));
      await createTaggedArticle('tagged-pop-a', JSON.stringify(['Pop']));
      await createTaggedArticle('tagged-pop-b', JSON.stringify(['Pop']));
      const reply = mockTagReply(['pop']);

      await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));

      expect(vocabularyHint(reply.userMessage())).toEqual(['Pop', 'Dup']);
    });

    it("leaves the article's own previous tags out of the vocabulary hint", async () => {
      dbMock.mock
        .db!.update(articles)
        .set({ aiTags: JSON.stringify(['Stale Tag']) })
        .where(eq(articles.id, articleId))
        .run();
      const reply = mockTagReply(['stale tag']);

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));

      expect(vocabularyHint(reply.userMessage())).toEqual([]);
      expect((await res.json()).tags).toEqual(['stale tag']);
    });

    it('does not insert into the tags table', async () => {
      // A highlight tag must neither be offered as vocabulary nor be (re)written
      const { POST: createTag } = await import('@/app/api/tags/route');
      await createTag(jsonReq('POST', '/api/tags', { name: 'Testing' }));
      const reply = mockTagReply(['testing', 'new-tag']);

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));
      expect(res.status).toBe(200);

      expect(vocabularyHint(reply.userMessage())).toEqual([]);
      expect((await res.json()).tags).toEqual(['testing', 'new-tag']);
      const rows = dbMock.mock.db!.select({ name: tags.name }).from(tags).all();
      expect(rows).toEqual([{ name: 'Testing' }]);
    });

    it('returns an empty tag list when the model suggests none', async () => {
      mockTagReply([]);

      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tags: [] });
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

    it('returns 503 when Claude API fails', async () => {
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
            model: 'claude-sonnet-4-6',
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
            model: 'claude-sonnet-4-6',
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

    it('returns 503 when Claude API fails', async () => {
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
  describe('without an Anthropic API key', () => {
    let anthropicCalled: boolean;

    beforeEach(() => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      deleteSetting('anthropic_api_key');
      clearSettingsCache();
      resetClient();
      anthropicCalled = false;
    });

    afterEach(() => {
      clearSettingsCache();
    });

    /** Registers a handler that records whether any request reached the Anthropic API. */
    function trackAnthropicCalls() {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', () => {
          anthropicCalled = true;
          return HttpResponse.json({ error: { message: 'unexpected' } }, { status: 401 });
        }),
      );
    }

    async function expectNotConfigured(res: Response) {
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain('not configured');
      expect(body.error).not.toContain('Could not resolve authentication');
      expect(anthropicCalled).toBe(false);
    }

    it('summarize returns 503 not configured instead of the raw SDK error', async () => {
      trackAnthropicCalls();
      const res = await summarize(jsonReq('POST', '/api/ai/summarize', { articleId }));
      await expectNotConfigured(res);
    });

    it('tag returns 503 not configured instead of the raw SDK error', async () => {
      trackAnthropicCalls();
      const res = await autoTag(jsonReq('POST', '/api/ai/tag', { articleId }));
      await expectNotConfigured(res);
    });

    it('explain returns 503 not configured instead of the raw SDK error', async () => {
      const hlRes = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId,
          text: 'Testing patterns are essential for maintainable code.',
        }),
      );
      const { highlight } = await hlRes.json();
      trackAnthropicCalls();

      const res = await explain(
        jsonReq('POST', '/api/ai/explain', { highlightId: highlight.id, mode: 'explain' }),
      );
      await expectNotConfigured(res);
    });

    it('succeeds on the next call once a key is saved in Settings (missing key not cached)', async () => {
      trackAnthropicCalls();
      const failed = await summarize(jsonReq('POST', '/api/ai/summarize', { articleId }));
      expect(failed.status).toBe(503);

      server.use(
        http.post('https://api.anthropic.com/v1/messages', () =>
          HttpResponse.json({
            id: 'msg_later',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Summary after the key was saved.' }],
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20 },
          }),
        ),
      );
      setSetting('anthropic_api_key', 'sk-ant-saved-later');

      const res = await summarize(jsonReq('POST', '/api/ai/summarize', { articleId }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary).toBeTruthy();
    });
  });

  describe('API key rotation', () => {
    afterEach(() => {
      deleteSetting('anthropic_api_key');
      clearSettingsCache();
    });

    it('sends the new Settings key on the next call without a client reset', async () => {
      const hlRes = await createHighlight(
        jsonReq('POST', '/api/highlights', {
          articleId,
          text: 'Testing patterns are essential for maintainable code.',
        }),
      );
      const { highlight } = await hlRes.json();
      const sentAuth: (string | null)[] = [];
      server.use(
        http.post('https://api.anthropic.com/v1/messages', ({ request }) => {
          sentAuth.push(request.headers.get('authorization'));
          return HttpResponse.json({
            id: 'msg_rotation',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Explanation.' }],
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20 },
          });
        }),
      );
      const explainReq = () =>
        explain(jsonReq('POST', '/api/ai/explain', { highlightId: highlight.id, mode: 'explain' }));

      setSetting('anthropic_api_key', 'sk-ant-first-key');
      expect((await explainReq()).status).toBe(200);
      setSetting('anthropic_api_key', 'sk-ant-rotated-key');
      expect((await explainReq()).status).toBe(200);

      expect(sentAuth).toEqual(['Bearer sk-ant-first-key', 'Bearer sk-ant-rotated-key']);
    });
  });
});
