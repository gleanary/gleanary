import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { eq } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { server, setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { insertTestArticle } from './setup';
import { aiUsage, articles, sources } from '@/db/schema';
import { callClaudeTool, resetClient } from '@/lib/ai';
import { buildEnrichRequestParams } from '@/lib/enrichment-core';
import { enrichArticle, resolveEnrichPolicy } from '@/lib/enrichment';
import { clearSettingsCache, setSetting } from '@/lib/settings';
import { ConflictError, ExternalServiceError, NotFoundError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { DEFAULT_ENRICH_MODEL } from '@/lib/models';
import { expectActiveModel } from '../mocks/active-models';
import toolFixture from '../mocks/fixtures/claude-tool-response.json';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const OLD_UPDATED_AT = '2020-01-01 00:00:00';

let claudeCalls = 0;
let lastRequest: Record<string, unknown> | null = null;

/** Default handler: echoes the model and returns the shared tool-use fixture. */
setupHandlers(
  http.post(MESSAGES_URL, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    claudeCalls += 1;
    lastRequest = body;
    expectActiveModel(body.model);
    return HttpResponse.json({ ...toolFixture, model: body.model });
  }),
);

/** Per-test override returning a derived response for the next call(s). */
function respondWith(response: object, status = 200) {
  server.use(
    http.post(MESSAGES_URL, () => {
      claudeCalls += 1;
      return HttpResponse.json(response, { status });
    }),
  );
}

function seed(values: Partial<Parameters<typeof insertTestArticle>[1]> = {}) {
  return insertTestArticle(dbMock.mock.db!, {
    url: `https://example.com/${Math.random().toString(36).slice(2)}`,
    title: 'Seed article',
    contentMarkdown: 'A detailed article about **testing** patterns.\n\nIt has two paragraphs.',
    contentText: 'A detailed article about testing patterns. It has two paragraphs.',
    updatedAt: OLD_UPDATED_AT,
    ...values,
  });
}

function row(id: number) {
  return dbMock.mock.db!.select().from(articles).where(eq(articles.id, id)).get()!;
}

function usageRows() {
  return dbMock.mock.db!.select().from(aiUsage).all();
}

describe('enrichArticle', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    dbMock.setup();
    clearSettingsCache();
    resetClient();
    claudeCalls = 0;
    lastRequest = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes summary, tags, index, done, enriched_at and attempts 0 in one update, leaving updated_at alone', async () => {
    const article = seed({ enrichStatus: 'failed', enrichAttempts: 2 });
    const result = await enrichArticle(article.id, { manual: true });

    expect(result.cached).toBe(false);
    expect(result.article.enrichStatus).toBe('done');
    expect(result.article.aiTags).toEqual(['testing', 'software-engineering']);
    expect(result.article.aiSummary).toContain('**Unit tests catch regressions cheaply');
    expect(result.article.enrichTruncated).toBe(false);

    const stored = row(article.id);
    expect(stored.enrichStatus).toBe('done');
    expect(stored.enrichAttempts).toBe(0);
    expect(stored.enrichedAt).not.toBeNull();
    expect(stored.aiIndex).toMatch(/^TOPICS: software testing, unit testing/);
    expect(stored.aiIndex!.split('\n')).toHaveLength(5);
    expect(stored.updatedAt).toBe(OLD_UPDATED_AT);
    expect(claudeCalls).toBe(1);
    expect(lastRequest!.tool_choice).toEqual({ type: 'tool', name: 'record_enrichment' });
    expect(lastRequest!.thinking).toEqual({ type: 'disabled' });
    expect(lastRequest!.model).toBe(DEFAULT_ENRICH_MODEL);
  });

  it('tracks the call in ai_usage under article_enrich with the article as resource', async () => {
    const article = seed();
    await enrichArticle(article.id);
    const rows = usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: 'article_enrich',
      status: 'success',
      resourceType: 'article',
      resourceId: article.id,
      inputTokens: 1843,
      outputTokens: 412,
    });
  });

  it('clears enrich_batch_id when a run starts', async () => {
    const article = seed({ enrichStatus: 'batched', enrichBatchId: 42 });
    await enrichArticle(article.id);
    expect(row(article.id).enrichBatchId).toBeNull();
  });

  it('deduplicates two concurrent calls for one article into one Claude call', async () => {
    const article = seed();
    const [a, b] = await Promise.all([enrichArticle(article.id), enrichArticle(article.id)]);
    expect(claudeCalls).toBe(1);
    expect(a).toEqual(b);
    expect(usageRows()).toHaveLength(1);
  });

  it('throws ConflictError for a pending_review article with no call and no write', async () => {
    const article = seed({ status: 'pending_review', enrichStatus: 'failed', enrichAttempts: 1 });
    await expect(enrichArticle(article.id, { force: true, manual: true })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(claudeCalls).toBe(0);
    expect(row(article.id)).toMatchObject({ enrichStatus: 'failed', enrichAttempts: 1 });
  });

  it('returns the stored fields with cached: true for a done article without force', async () => {
    const article = seed({
      enrichStatus: 'done',
      aiSummary: '**Old**',
      aiTags: JSON.stringify(['old-tag']),
      enrichedAt: '2024-01-01 00:00:00',
    });
    const result = await enrichArticle(article.id);
    expect(result).toEqual({
      cached: true,
      article: {
        id: article.id,
        aiSummary: '**Old**',
        aiTags: ['old-tag'],
        enrichStatus: 'done',
        enrichedAt: '2024-01-01 00:00:00',
        enrichTruncated: false,
      },
    });
    expect(claudeCalls).toBe(0);
    expect(row(article.id).updatedAt).toBe(OLD_UPDATED_AT);
  });

  it('throws NotFoundError for an unknown article', async () => {
    await expect(enrichArticle(99_999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws 503 and writes nothing when no API key is configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const article = seed({ enrichStatus: 'failed', enrichAttempts: 2 });
    const err = await enrichArticle(article.id, { manual: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect((err as ExternalServiceError).statusCode).toBe(503);
    expect(row(article.id)).toMatchObject({ enrichStatus: 'failed', enrichAttempts: 2 });
    expect(claudeCalls).toBe(0);
  });

  it('throws 422 and marks failed with attempts 3 when the article has no content', async () => {
    const article = seed({ contentMarkdown: '', contentText: '' });
    await expect(enrichArticle(article.id, { manual: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(row(article.id)).toMatchObject({ enrichStatus: 'failed', enrichAttempts: 3 });
    expect(row(article.id).updatedAt).toBe(OLD_UPDATED_AT);
    expect(claudeCalls).toBe(0);
  });

  it('keeps a done article done when a forced run finds no content', async () => {
    const article = seed({
      contentMarkdown: '',
      contentText: '',
      enrichStatus: 'done',
      aiSummary: '**Old**',
    });
    await expect(enrichArticle(article.id, { force: true, manual: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(row(article.id)).toMatchObject({ enrichStatus: 'done', enrichAttempts: 0 });
  });

  describe('failures after the call starts', () => {
    const doneValues = {
      enrichStatus: 'done' as const,
      enrichAttempts: 0,
      aiSummary: '**Old summary**',
      aiTags: JSON.stringify(['old-tag']),
      aiIndex: 'TOPICS: old\nENTITIES: \nARGUMENTS FOR: \nARGUMENTS AGAINST: \nRELATED CONCEPTS: ',
    };

    it('a provider error gives 503 and failed/1 through the manual path', async () => {
      respondWith({ error: { type: 'api_error', message: 'boom' } }, 500);
      const warn = vi.spyOn(logger, 'warn');
      const article = seed({ enrichStatus: 'failed', enrichAttempts: 2 });
      const err = await enrichArticle(article.id, { manual: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExternalServiceError);
      expect((err as ExternalServiceError).statusCode).toBe(503);
      expect(row(article.id)).toMatchObject({ enrichStatus: 'failed', enrichAttempts: 1 });
      expect(row(article.id).updatedAt).toBe(OLD_UPDATED_AT);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'enrich_failed', articleId: article.id, statusCode: 503 }),
        expect.any(String),
      );
    });

    it('a non-manual failure from failed/1 accumulates to failed/2', async () => {
      respondWith({ error: { type: 'api_error', message: 'boom' } }, 500);
      const article = seed({ enrichStatus: 'failed', enrichAttempts: 1 });
      await expect(enrichArticle(article.id)).rejects.toBeInstanceOf(ExternalServiceError);
      expect(row(article.id)).toMatchObject({ enrichStatus: 'failed', enrichAttempts: 2 });
    });

    it('manual: true resets attempts to 0 when the run starts', async () => {
      let attemptsDuringCall: number | null = null;
      const article = seed({ enrichStatus: 'failed', enrichAttempts: 2 });
      server.use(
        http.post(MESSAGES_URL, () => {
          attemptsDuringCall = row(article.id).enrichAttempts;
          return HttpResponse.json(toolFixture);
        }),
      );
      await enrichArticle(article.id, { manual: true });
      expect(attemptsDuringCall).toBe(0);
    });

    it.each([
      ['no tool_use block', { ...toolFixture, content: [{ type: 'text', text: 'Sure!' }] }],
      [
        'a tool_use block with another name',
        {
          ...toolFixture,
          content: [{ ...toolFixture.content[0], name: 'something_else' }],
        },
      ],
      ['stop_reason max_tokens', { ...toolFixture, stop_reason: 'max_tokens' }],
      ['stop_reason refusal', { ...toolFixture, stop_reason: 'refusal' }],
      [
        'a bad payload shape',
        {
          ...toolFixture,
          content: [{ ...toolFixture.content[0], input: { summary: {}, tags: [], index: {} } }],
        },
      ],
    ])('%s gives 502 and keeps the real token counts in ai_usage', async (_name, response) => {
      respondWith(response);
      const article = seed();
      const err = await enrichArticle(article.id, { manual: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExternalServiceError);
      expect((err as ExternalServiceError).statusCode).toBe(502);
      expect(row(article.id)).toMatchObject({ enrichStatus: 'failed', enrichAttempts: 1 });
      const rows = usageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'success', inputTokens: 1843, outputTokens: 412 });
    });

    it('a failed forced run (502) on a done article restores done with the old outputs', async () => {
      respondWith({ ...toolFixture, stop_reason: 'max_tokens' });
      const article = seed(doneValues);
      await expect(enrichArticle(article.id, { force: true, manual: true })).rejects.toBeInstanceOf(
        ExternalServiceError,
      );
      expect(row(article.id)).toMatchObject(doneValues);
    });

    it('a failed forced run (503) on a done article restores done with the old outputs', async () => {
      respondWith({ error: { type: 'api_error', message: 'boom' } }, 500);
      const article = seed(doneValues);
      await expect(enrichArticle(article.id, { force: true, manual: true })).rejects.toBeInstanceOf(
        ExternalServiceError,
      );
      expect(row(article.id)).toMatchObject(doneValues);
    });

    it('an unexpected error after the call starts still takes the failure branch', async () => {
      const core = await import('@/lib/enrichment-core');
      vi.spyOn(core, 'formatIndexText').mockImplementation(() => {
        throw new Error('formatter exploded');
      });
      const article = seed();
      await expect(enrichArticle(article.id, { manual: true })).rejects.toThrow(
        'formatter exploded',
      );
      expect(row(article.id)).toMatchObject({ enrichStatus: 'failed', enrichAttempts: 1 });
    });

    it('a forced run from done whose tags all drop keeps the old ai_tags and writes the rest', async () => {
      respondWith({
        ...toolFixture,
        content: [
          {
            ...toolFixture.content[0],
            input: { ...toolFixture.content[0]!.input, tags: ['Not Valid', 'bad tag!'] },
          },
        ],
      });
      const article = seed(doneValues);
      const result = await enrichArticle(article.id, { force: true, manual: true });
      expect(result.article.aiTags).toEqual(['old-tag']);
      expect(row(article.id).aiTags).toBe(JSON.stringify(['old-tag']));
      expect(row(article.id).aiSummary).toContain('Unit tests catch regressions');
    });

    it('a first run whose tags all drop stores [] and logs enrich_tags_all_dropped', async () => {
      respondWith({
        ...toolFixture,
        content: [
          {
            ...toolFixture.content[0],
            input: { ...toolFixture.content[0]!.input, tags: ['Not Valid'] },
          },
        ],
      });
      const info = vi.spyOn(logger, 'info');
      const article = seed();
      const result = await enrichArticle(article.id);
      expect(result.article.aiTags).toEqual([]);
      expect(row(article.id)).toMatchObject({ aiTags: '[]', enrichStatus: 'done' });
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'enrich_tags_all_dropped', articleId: article.id }),
        expect.any(String),
      );
    });
  });

  it('marks enrich_truncated and says so in the prompt when content exceeds the budget', async () => {
    setSetting('enrich_max_input_tokens', '10000');
    const article = seed({
      contentMarkdown: `${'word '.repeat(7_900)}\n\n${'tail '.repeat(10_000)}`,
    });
    const result = await enrichArticle(article.id);
    expect(result.article.enrichTruncated).toBe(true);
    expect(row(article.id).enrichTruncated).toBe(true);
    const content = (lastRequest!.messages as Array<{ content: string }>)[0]!.content;
    expect(content).toMatch(/Coverage: first ~\d+% of the document \(truncated\)/);
  });

  it('uses the per-source model override and the stored tag spellings', async () => {
    const db = dbMock.mock.db!;
    const feed = db
      .insert(sources)
      .values({ type: 'rss_feed', name: 'Feed', feedUrl: 'https://example.com/feed' })
      .returning({ id: sources.id })
      .get()!;
    setSetting('enrich_model_rss_feed', 'claude-haiku-4-5-20251001');
    seed({ aiTags: JSON.stringify(['Testing']) }); // another article's tag: the vocabulary
    const article = seed({ sourceId: feed.id });
    const result = await enrichArticle(article.id);
    expect(lastRequest!.model).toBe('claude-haiku-4-5-20251001');
    expect(result.article.aiTags).toEqual(['Testing', 'software-engineering']);
  });
});

describe('resolveEnrichPolicy', () => {
  beforeEach(() => {
    dbMock.setup();
    clearSettingsCache();
  });

  it('logs one enrich_model_fallback warning per rejected level', () => {
    const warn = vi.spyOn(logger, 'warn');
    setSetting('enrich_model_rss_feed', 'claude-sonnet-4-20250514');
    setSetting('enrich_default_model', 'claude-nope');
    const policy = resolveEnrichPolicy('rss_feed');
    expect(policy).toEqual({ mode: 'lazy', model: DEFAULT_ENRICH_MODEL });
    const events = warn.mock.calls.filter(
      ([obj]) => (obj as { event?: string }).event === 'enrich_model_fallback',
    );
    expect(events).toHaveLength(2);
    expect(events[0]![0]).toMatchObject({
      key: 'enrich_model_rss_feed',
      rejected: 'claude-sonnet-4-20250514',
    });
    expect(events[1]![0]).toMatchObject({ key: 'enrich_default_model', rejected: 'claude-nope' });
    warn.mockRestore();
  });
});

describe('callClaudeTool', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    dbMock.setup();
    clearSettingsCache();
    resetClient();
    claudeCalls = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetClient();
  });

  const ctx = {
    feature: 'article_enrich' as const,
    resourceType: 'article' as const,
    resourceId: 1,
  };

  it('returns the tool input and stop reason, and passes the timeout with maxRetries 0 under test', async () => {
    const create = vi.spyOn(Anthropic.Messages.prototype, 'create');
    const params = buildEnrichRequestParams({ model: DEFAULT_ENRICH_MODEL, userMessage: 'hi' });
    const result = await callClaudeTool(params, ctx, { timeoutMs: 61_000 });
    expect(result.stopReason).toBe('tool_use');
    expect(result.input).toEqual(toolFixture.content[0]!.input);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toBe(params);
    expect(create.mock.calls[0]![1]).toEqual({ timeout: 61_000, maxRetries: 0 });
  });

  it('passes maxRetries 1 outside the test environment', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    resetClient();
    const create = vi.spyOn(Anthropic.Messages.prototype, 'create');
    const params = buildEnrichRequestParams({ model: DEFAULT_ENRICH_MODEL, userMessage: 'hi' });
    await callClaudeTool(params, ctx, { timeoutMs: 61_000 });
    expect(create.mock.calls[0]![1]).toEqual({ timeout: 61_000, maxRetries: 1 });
  });

  it('returns input null for a completed response without the named tool block instead of throwing', async () => {
    respondWith({
      ...toolFixture,
      content: [{ type: 'text', text: 'nope' }],
      stop_reason: 'end_turn',
    });
    const params = buildEnrichRequestParams({ model: DEFAULT_ENRICH_MODEL, userMessage: 'hi' });
    const result = await callClaudeTool(params, ctx, { timeoutMs: 61_000 });
    expect(result).toEqual({ input: null, stopReason: 'end_turn' });
    expect(usageRows()[0]).toMatchObject({ status: 'success', inputTokens: 1843 });
  });

  it('rewraps SDK errors as a 503 ExternalServiceError', async () => {
    respondWith({ error: { type: 'api_error', message: 'boom' } }, 500);
    const params = buildEnrichRequestParams({ model: DEFAULT_ENRICH_MODEL, userMessage: 'hi' });
    const err = await callClaudeTool(params, ctx, { timeoutMs: 61_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect((err as ExternalServiceError).statusCode).toBe(503);
    expect(usageRows()[0]).toMatchObject({ status: 'error', feature: 'article_enrich' });
  });
});
