import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { resetClient } from '@/lib/ai';
import { articles, highlights, theses } from '@/db/schema';
import { POST as lintPost } from '@/app/api/chat/lint/route';

/**
 * Mock Claude responses for the LLM-backed lint checks.
 * The stale check never calls Claude; other checks need deterministic JSON.
 */
const mockClaudeJsonByPurpose: Record<string, unknown> = {
  lint_connections: { coherent: true, thesisTitle: 'Regulatory capture across domains' },
  lint_gaps: {
    hasGap: true,
    gapType: 'counterargument',
    description: 'No opposing highlights yet.',
    suggestedAction: 'Find counterarguments',
  },
  lint_contradictions_notes: [],
  lint_contradictions_tension: [],
};

setupHandlers(
  http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const system = typeof body.system === 'string' ? body.system : '';
    // Route by prompt marker in the system prompt
    let payload: unknown = { coherent: false };
    if (system.includes('reviewing a cluster of highlights')) {
      payload = mockClaudeJsonByPurpose.lint_connections;
    } else if (system.includes('reviewing a thesis')) {
      payload = mockClaudeJsonByPurpose.lint_gaps;
    } else if (system.includes('annotated highlights')) {
      payload = mockClaudeJsonByPurpose.lint_contradictions_notes;
    } else if (system.includes('supporting and opposing highlights')) {
      payload = mockClaudeJsonByPurpose.lint_contradictions_tension;
    }
    return HttpResponse.json({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  }),
);

function jsonReq(body: object): NextRequest {
  return new NextRequest(new URL('/api/chat/lint', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Parse SSE events from a streamed Response. */
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

/** Seeds a minimal-but-valid KB so global quorum gates pass. */
function seedMinimalKb(db: ReturnType<typeof dbMock.setup>['db']) {
  const articleIds: number[] = [];
  for (let i = 0; i < 3; i++) {
    const a = db
      .insert(articles)
      .values({
        url: `https://example.com/a${i}`,
        title: `Article ${i}`,
        status: 'reading',
        aiIndex: 'TOPICS: regulatory capture, finance\nENTITIES: sec',
      })
      .returning()
      .get()!;
    articleIds.push(a.id);
  }
  for (let i = 0; i < 5; i++) {
    db.insert(highlights)
      .values({
        articleId: articleIds[i % 3]!,
        text: `Highlight about regulatory capture number ${i}`,
      })
      .run();
  }
  return articleIds;
}

describe('POST /api/chat/lint', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
    dbMock.setup();
    resetClient();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('validation', () => {
    it('rejects invalid check value with 400', async () => {
      seedMinimalKb(dbMock.mock.db!);
      const res = await lintPost(jsonReq({ check: 'nope' }));
      expect(res.status).toBe(422);
    });

    it('rejects missing check with 400', async () => {
      seedMinimalKb(dbMock.mock.db!);
      const res = await lintPost(jsonReq({}));
      expect(res.status).toBe(422);
    });
  });

  describe('empty KB gate', () => {
    it('emits empty + done events when the KB has <3 articles', async () => {
      // Only 1 article
      const db = dbMock.mock.db!;
      db.insert(articles).values({ url: 'https://example.com/solo', title: 'Solo' }).run();

      const res = await lintPost(jsonReq({ check: 'stale' }));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');

      const events = await parseSSE(res);
      const emptyEvent = events.find((e) => e.event === 'empty');
      const doneEvent = events.find((e) => e.event === 'done');
      expect(emptyEvent).toBeDefined();
      expect(doneEvent).toBeDefined();
      expect((doneEvent!.data as { totalSuggestions: number }).totalSuggestions).toBe(0);
    });
  });

  describe('stale check (no LLM)', () => {
    it('streams stale suggestions for theses/articles/highlights', async () => {
      const db = dbMock.mock.db!;
      const articleIds = seedMinimalKb(db);

      // Insert a stale thesis
      db.insert(theses)
        .values({
          title: 'Old thesis',
          status: 'developing',
          updatedAt: sql`datetime('now', '-45 days')`,
        })
        .run();

      // Insert a stale reading article
      db.insert(articles)
        .values({
          url: 'https://example.com/stuck',
          title: 'Stuck article',
          status: 'reading',
          updatedAt: sql`datetime('now', '-20 days')`,
        })
        .run();

      // Insert an overdue mature highlight
      db.insert(highlights)
        .values({
          articleId: articleIds[0]!,
          text: 'Mature memory',
          reviewInterval: 60,
          lastReviewed: sql`datetime('now', '-90 days')` as unknown as string,
        })
        .run();

      const res = await lintPost(jsonReq({ check: 'stale' }));
      expect(res.status).toBe(200);
      const events = await parseSSE(res);

      const suggestions = events.filter((e) => e.event === 'suggestion');
      expect(suggestions.length).toBeGreaterThanOrEqual(3);

      const doneEvent = events.find((e) => e.event === 'done');
      expect(doneEvent).toBeDefined();
      expect((doneEvent!.data as { totalSuggestions: number }).totalSuggestions).toBe(
        suggestions.length,
      );
    });

    it('emits done with 0 suggestions when nothing is stale', async () => {
      seedMinimalKb(dbMock.mock.db!);
      const res = await lintPost(jsonReq({ check: 'stale' }));
      const events = await parseSSE(res);
      const suggestions = events.filter((e) => e.event === 'suggestion');
      expect(suggestions).toHaveLength(0);
      const doneEvent = events.find((e) => e.event === 'done');
      expect((doneEvent!.data as { totalSuggestions: number }).totalSuggestions).toBe(0);
    });
  });

  describe('gaps check (mocked LLM)', () => {
    it('streams a gap suggestion for a developing thesis', async () => {
      const db = dbMock.mock.db!;
      seedMinimalKb(db);

      db.insert(theses)
        .values({
          title: 'A developing thesis',
          status: 'developing',
          claim: 'Something specific',
        })
        .run();

      const res = await lintPost(jsonReq({ check: 'gaps' }));
      expect(res.status).toBe(200);
      const events = await parseSSE(res);
      const suggestions = events.filter((e) => e.event === 'suggestion');
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      expect((suggestions[0]!.data as { description: string }).description).toMatch(
        /developing thesis|counterarguments/i,
      );
    });
  });

  describe('connections check (mocked LLM)', () => {
    it('streams a connection suggestion when clusters form', async () => {
      const db = dbMock.mock.db!;
      const articleIds: number[] = [];
      for (let i = 0; i < 4; i++) {
        const a = db
          .insert(articles)
          .values({
            url: `https://example.com/cluster-${i}`,
            title: `Cluster article ${i}`,
            aiIndex: `TOPICS: regulatory capture, finance\nENTITIES: fed`,
          })
          .returning()
          .get()!;
        articleIds.push(a.id);
      }
      for (let i = 0; i < 12; i++) {
        db.insert(highlights)
          .values({
            articleId: articleIds[i % 4]!,
            text: `Highlight text ${i} about capture`,
          })
          .run();
      }

      const res = await lintPost(jsonReq({ check: 'connections' }));
      expect(res.status).toBe(200);
      const events = await parseSSE(res);
      const suggestions = events.filter((e) => e.event === 'suggestion');
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('contradictions check (mocked LLM)', () => {
    it('runs without error and emits done even when nothing is found', async () => {
      seedMinimalKb(dbMock.mock.db!);
      const res = await lintPost(jsonReq({ check: 'contradictions' }));
      expect(res.status).toBe(200);
      const events = await parseSSE(res);
      const doneEvent = events.find((e) => e.event === 'done');
      expect(doneEvent).toBeDefined();
    });
  });
});
